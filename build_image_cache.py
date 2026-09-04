#!/usr/bin/env python3
"""
Chef2Chef Image Pre-Cache Builder
Generates images.json with a URL for every item in data.csv.
Run ONCE — commit images.json to the repo — the app loads it instantly with zero API calls.

Usage:
    pip install requests
    python build_image_cache.py

Place this script in the same folder as data.csv.
It will create / update images.json, saving progress every 100 items so you can Ctrl+C and resume safely.

API order per item (all free, keyless, no daily limits):
  1. Open Food Facts  — real product photos, best for packaged goods
  2. Wikipedia        — great for generic ingredients
  3. Wikimedia Commons — broad food photo library
"""

import csv, json, time, re, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    print("Missing dependency.  Run:  pip install requests")
    sys.exit(1)

# ── CONFIG ───────────────────────────────────────────────────────────────────
# No API keys needed — every source below is free and keyless.
CSV_FILE     = 'data.csv'
OUTPUT_FILE  = 'images.json'
WORKERS      = 5      # parallel workers (increase to 8 if your connection is fast)
DELAY        = 0.25   # seconds between requests per worker — be polite to free APIs
SAVE_EVERY   = 100    # flush to disk every N completions
TIMEOUT      = 8      # per-request timeout in seconds

# ── HTTP SESSION ─────────────────────────────────────────────────────────────
_session = requests.Session()
_retry = Retry(total=2, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504])
_session.mount('https://', HTTPAdapter(max_retries=_retry))
_session.headers.update({'User-Agent': 'Chef2Chef-ImageCache/1.0 (food-product lookup)'})

# ── QUERY BUILDER ─────────────────────────────────────────────────────────────
_SKIP = {
    'organic','australian','lebanese','french','spanish','italian','thai',
    'fresh','frozen','chilled','fzn','frz','raw','cooked','boneless',
    'skinless','whole','sliced','diced','minced','cleaned','trimmed',
    'peeled','chopped','grilled','smoked','dried','halal','kosher',
    'imported','local','uae','premium','select','extra','grade','quality',
    'style','type','approx','portion','serving','large','medium','small',
    'mini','baby','young','aged','pack','per','the','and','with','from',
    'abaca','chef2chef','alannahs','kibsons','abela','aiad','uns',
}
_INTERNAL_BRANDS = {'chef 2 chef', 'chef2chef', 'c2c', 'own brand', 'house brand'}


def _build_query(desc: str, brand: str = '') -> str:
    d = re.sub(r'\(.*?\)', ' ', desc)
    d = re.sub(r'\d+\s*[xX]\s*\d+\s*(?:kg|g|ml|l|pcs?|pkt)?', ' ', d)
    d = re.sub(r'\d+[-–]\d+\s*(?:kg|g|ml|l|pcs?)?', ' ', d)
    d = re.sub(r'\d+\s*(?:kg|g|ml|l|pcs?|pkt|ltr|litre|liter)\.?', ' ', d, flags=re.I)
    d = re.sub(r'\b[A-Z0-9]{6,}\b', ' ', d)
    words = [w for w in re.split(r'\W+', d.lower())
             if len(w) > 2 and w not in _SKIP]

    b = brand.lower().strip()
    use_brand = bool(b) and not any(ib in b for ib in _INTERNAL_BRANDS)

    if use_brand:
        return (brand.strip() + ' ' + ' '.join(words[:3])).strip()
    return ' '.join(words[:4])


def _shorten(q: str, n: int = 2) -> str:
    return ' '.join(q.split()[:n])

# ── API FETCHERS ──────────────────────────────────────────────────────────────

def _open_food_facts(q: str):
    try:
        r = _session.get(
            'https://world.openfoodfacts.org/cgi/search.pl',
            params={'search_terms': q, 'search_simple': 1, 'action': 'process',
                    'json': 1, 'page_size': 5,
                    'fields': 'image_front_small_url,product_name'},
            timeout=TIMEOUT,
        )
        for p in r.json().get('products', []):
            url = p.get('image_front_small_url') or p.get('image_small_url')
            if url:
                return url
    except Exception:
        pass
    return None


_FOOD_TERMS = {
    'food','fruit','vegetable','meat','fish','poultry','seafood','cheese',
    'dairy','herb','spice','ingredient','dish','cuisine','recipe','crop',
    'plant','eaten','edible','cooked','drink','beverage','grain','seed',
    'nut','oil','sauce','soup','bread','pasta','rice','egg','sugar',
    'salt','flour','condiment','flavour','flavor','leaf','root','bean',
    'legume','mushroom','truffle','berry','citrus','pepper',
}
_BAD_TERMS = {
    'color','colour','company','corporation','brand','person','singer',
    'actor','musician','politician','city','country','software',
    'technology','album','film','television','game',
}


def _wikipedia(q: str):
    try:
        r = _session.get(
            f'https://en.wikipedia.org/api/rest_v1/page/summary/{requests.utils.quote(q)}',
            timeout=TIMEOUT,
        )
        if not r.ok:
            return None
        d = r.json()
        if d.get('type') == 'disambiguation':
            return None
        text = (d.get('description', '') + ' ' + d.get('extract', '')).lower()
        if not any(t in text for t in _FOOD_TERMS):
            return None
        if any(t in text for t in _BAD_TERMS):
            return None
        thumb = (d.get('thumbnail') or {}).get('source')
        if thumb:
            return re.sub(r'/\d+px-', '/400px-', thumb)
    except Exception:
        pass
    return None


def _wikimedia_commons(q: str):
    try:
        r = _session.get(
            'https://commons.wikimedia.org/w/api.php',
            params={
                'action': 'query', 'generator': 'search', 'gsrnamespace': 6,
                'gsrsearch': q + ' food', 'gsrlimit': 5,
                'prop': 'imageinfo', 'iiprop': 'url', 'iiurlwidth': 400,
                'format': 'json',
            },
            timeout=TIMEOUT,
        )
        pages = r.json().get('query', {}).get('pages', {})
        for page in pages.values():
            info = (page.get('imageinfo') or [{}])[0]
            url = info.get('thumburl') or info.get('url', '')
            if url and not any(url.lower().endswith(ext)
                               for ext in ('.svg', '.ogg', '.webm', '.pdf')):
                return url
    except Exception:
        pass
    return None


# ── MAIN LOOKUP (per item) ────────────────────────────────────────────────────

def lookup(item_id: str, desc: str, brand: str):
    time.sleep(DELAY)
    q = _build_query(desc, brand)
    if not q:
        return item_id, None

    short2 = _shorten(q, 2)
    short3 = _shorten(q, 3)
    core   = _shorten(q, 1)

    # 1 — Open Food Facts (best for packaged/branded products)
    for attempt in filter(None, dict.fromkeys([q, short3, short2])):
        url = _open_food_facts(attempt)
        if url:
            return item_id, url

    # 2 — Wikipedia (great for raw ingredients)
    for attempt in filter(None, dict.fromkeys([q, short3, core])):
        url = _wikipedia(attempt)
        if url:
            return item_id, url

    # 3 — Wikimedia Commons
    url = _wikimedia_commons(short3 or q)
    if url:
        return item_id, url

    return item_id, None

# ── SAVE HELPER ───────────────────────────────────────────────────────────────

def _save(data: dict):
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))

# ── ENTRY POINT ───────────────────────────────────────────────────────────────

def main():
    if not Path(CSV_FILE).exists():
        print(f'ERROR: {CSV_FILE} not found.\nRun this script from the same folder as data.csv.')
        sys.exit(1)

    # Load previous run
    result: dict = {}
    if Path(OUTPUT_FILE).exists():
        with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
            result = json.load(f)
        print(f'Resuming — {len(result):,} items already cached.')

    # Read CSV, skip already-done items
    todo: list[tuple] = []
    with open(CSV_FILE, newline='', encoding='latin-1') as f:
        for row in csv.DictReader(f):
            item_id = str(row.get('Item', '')).strip()
            desc    = str(row.get('Description', '')).strip()
            brand   = str(row.get('Brand', '')).strip()
            if item_id and item_id not in result:
                todo.append((item_id, desc, brand))

    total = len(result) + len(todo)
    print(f'Total items : {total:,}')
    print(f'Remaining   : {len(todo):,}')
    if not todo:
        print('All done — images.json is up to date.')
        return

    done      = len(result)
    saved_at  = done
    found_now = 0

    print(f'\nStarting with {WORKERS} workers…  (Ctrl+C to pause and resume later)\n')

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(lookup, iid, d, b): iid
            for iid, d, b in todo
        }
        try:
            for future in as_completed(futures):
                item_id, url = future.result()
                result[item_id] = url
                done += 1
                if url:
                    found_now += 1
                pct    = done / total * 100
                marker = '✓' if url else '–'
                print(
                    f'\r[{pct:5.1f}%] {done:>6}/{total}  {marker}  {item_id:<20}',
                    end='', flush=True,
                )
                if done - saved_at >= SAVE_EVERY:
                    print()
                    _save(result)
                    print(f'  ↳ saved {len(result):,} entries to {OUTPUT_FILE}')
                    saved_at = done
        except KeyboardInterrupt:
            print('\n\nInterrupted — saving progress…')

    _save(result)
    total_found = sum(1 for v in result.values() if v)
    pct_found   = total_found / total * 100 if total else 0
    print(f'\n\n{"─"*50}')
    print(f'Complete!   {total_found:,}/{total:,} images found  ({pct_found:.1f}%)')
    print(f'Output      → {OUTPUT_FILE}')
    print(f'{"─"*50}')
    print('Next step: commit images.json to GitHub and the app will load it automatically.')


if __name__ == '__main__':
    main()
