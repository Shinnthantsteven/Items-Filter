/* Invoice Scanner v2 — upload a supplier invoice (PDF / photo), match each line to our item codes.
   Uses globals from index.html: db (items), imageMap, openLightbox, XLSX. Libraries load only when first used. */
(function () {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
  let rows = [], invNo = '';

  const load = src => new Promise((ok, no) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const photoOf = id => { try { return (typeof imageMap !== 'undefined' && imageMap[id]) || ''; } catch (e) { return ''; } };

  /* ── UI ── */
  function build() {
    if ($('invModal')) return;
    const st = document.createElement('style');
    st.textContent = `
#invModal{position:fixed;inset:0;z-index:6000;background:var(--bg-color);display:none;flex-direction:column;font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:var(--text);--iv-muted:#94a3b8;--iv-soft:rgba(255,255,255,.07);--iv-warn:#fbbf24;--iv-ok:#10b981}
#invModal.open{display:flex}#invModal *{box-sizing:border-box}
[data-theme="light"] #invModal{--iv-muted:#475569;--iv-soft:rgba(15,23,42,.06);--iv-warn:#b45309;--iv-ok:#047857}
.iv-top{display:flex;align-items:center;gap:12px;padding:calc(14px + env(safe-area-inset-top,0px)) 24px 14px;border-bottom:1px solid var(--glass-edge)}
.iv-top h2{margin:0;font-size:18px;font-weight:800;flex:1}
.iv-x{width:40px;height:40px;border-radius:50%;border:none;background:var(--iv-soft);color:var(--text);font-size:18px;cursor:pointer}
.iv-scroll{flex:1;overflow:auto;padding:20px 24px calc(96px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch}
.iv-wrap{max-width:1180px;margin:0 auto}
.iv-drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 16px;border:1.5px dashed var(--glass-edge);border-radius:20px;background:var(--iv-soft);cursor:pointer;text-align:center}
.iv-drop.on{border-color:var(--brand)}.iv-drop small{color:var(--iv-muted);font-size:12px;word-break:break-all}
.iv-ctl{display:flex;gap:12px;margin:16px 0 8px;flex-wrap:wrap}
.iv-ctl select{flex:1;min-width:220px;padding:13px 14px;border-radius:14px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:600 14px inherit}
.iv-go,.iv-sec{padding:13px 24px;border:none;border-radius:14px;font:800 15px inherit;cursor:pointer}
.iv-go{background:var(--brand);color:#fff}.iv-sec{background:var(--iv-soft);color:var(--text)}
.iv-paste summary,.iv-enh summary{cursor:pointer;font-size:12px;color:var(--iv-muted);margin:6px 0}
.iv-paste textarea{width:100%;border-radius:14px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);padding:12px}
.iv-enh canvas{max-width:100%;border-radius:12px;border:1px solid var(--glass-edge)}
.iv-st{font-size:13px;color:var(--iv-muted);margin:8px 2px 14px;min-height:18px}
.iv-sum{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.iv-chip{padding:7px 14px;border-radius:50px;background:var(--iv-soft);font-size:12px;font-weight:700}.iv-chip.a{color:var(--iv-warn)}
.iv-bar{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:center;gap:10px;padding:12px 24px calc(12px + env(safe-area-inset-bottom,0px));background:var(--bg-color);border-top:1px solid var(--glass-edge)}
.iv-bar button{flex:1;max-width:260px;padding:14px;border-radius:14px;border:none;font:800 14px inherit;cursor:pointer;background:var(--iv-soft);color:var(--text)}
.iv-bar button.p{background:var(--brand);color:#fff}
.iv-ph{width:44px;height:44px;border-radius:10px;object-fit:cover;background:var(--iv-soft);cursor:zoom-in;flex:none;display:flex;align-items:center;justify-content:center;font-size:18px}
.iv-code{font:800 14px ui-monospace,monospace;color:var(--brand);cursor:pointer;white-space:nowrap}.iv-code.none{color:#dc2626}
.iv-uom{display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:20px;background:rgba(16,185,129,.12);color:var(--iv-ok)}
.iv-q{width:100%;margin-top:6px;padding:9px 12px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:500 13px inherit}
.iv-pick select{width:100%;padding:9px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:600 13px inherit}
/* desktop: table */
.iv-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
.iv-tbl th{text-align:left;font-size:11px;font-weight:700;color:var(--iv-muted);padding:10px 12px;border-bottom:1px solid var(--glass-edge);position:sticky;top:-20px;background:var(--bg-color);z-index:2}
.iv-tbl td{padding:12px;border-bottom:1px solid var(--glass-edge);vertical-align:middle}
.iv-tbl tr:hover td{background:var(--iv-soft)}.iv-tbl .r{text-align:right;font-variant-numeric:tabular-nums}
.iv-tbl .it{display:flex;gap:12px;align-items:flex-start;min-width:340px}.iv-tbl .it>div{flex:1;min-width:0}
.iv-tbl .nm{font-weight:700;margin-bottom:4px}.iv-sub{font-size:12px;color:var(--iv-muted)}
/* phone: cards */
.iv-cards{display:none}
.iv-card{background:var(--card-bg,#0d1829);border:1px solid var(--glass-edge);border-radius:18px;padding:14px;margin-bottom:12px}
.iv-c1{display:flex;gap:12px;align-items:flex-start}.iv-c1 .iv-ph{width:60px;height:60px;border-radius:12px}
.iv-c1>div{flex:1;min-width:0}.iv-card .nm{font-weight:700;font-size:15px;line-height:1.3;cursor:pointer}
.iv-c2{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px}
.iv-c2 .iv-code{font-size:16px;background:rgba(16,185,129,.12);padding:6px 12px;border-radius:12px}
.iv-cost{font-weight:800;font-size:18px;cursor:pointer}
.iv-card .iv-sub{margin-top:8px}.iv-chg{display:inline-block;margin-top:8px;font-size:12px;color:var(--iv-muted);text-decoration:underline;cursor:pointer}
.iv-card .iv-pick{display:none;margin-top:6px}.iv-card.edit .iv-pick{display:block}
@media(max-width:899px){.iv-tblwrap{display:none}.iv-cards{display:block}.iv-scroll{padding:16px 14px calc(96px + env(safe-area-inset-bottom,0px))}.iv-go,.iv-sec{flex:1}}`;
    document.head.appendChild(st);
    const m = document.createElement('div'); m.id = 'invModal';
    m.innerHTML = `<div class="iv-top"><h2>📄 Invoice Scanner</h2><button class="iv-x" onclick="document.getElementById('invModal').classList.remove('open')">✕</button></div>
<div class="iv-scroll"><div class="iv-wrap">
  <label class="iv-drop" id="invDrop"><span style="font-size:26px">⬆️</span><b>Tap to choose invoice</b><small id="invFiles">PDF or photo — you can pick several pages</small>
    <input type="file" id="invFile" accept=".pdf,image/*" multiple hidden></label>
  <div class="iv-ctl">
    <select id="invPreset"><option value="barakat">Barakat (BkVgCh / BkFrCh)</option><option value="ag">AG Vegetables (VgCh / FrCh)</option><option value="any">Any supplier</option></select>
    <button class="iv-sec" id="invEnhBtn">✨ Enhance preview</button>
    <button class="iv-go" id="invRun">Scan &amp; Match</button>
  </div>
  <input type="hidden" id="invSup" value="Barakat"><input type="hidden" id="invPre" value="BkVg,BkFr">
  <details class="iv-enh" id="invEnh"><summary>Enhanced document (what the reader sees)</summary><div id="invEnhOut"></div></details>
  <details class="iv-paste"><summary>Can't read the file? Paste invoice text instead</summary><textarea id="invPaste" rows="5" placeholder="Strawberry Pp  10/07/2026  3.00 Kg 50.00 150.00"></textarea></details>
  <div class="iv-st" id="invStatus"></div>
  <div id="invBody"></div>
</div></div>
<div class="iv-bar"><button class="p" id="invXls">⬇ Excel</button><button id="invCopy">Copy all</button></div>`;
    document.body.appendChild(m);
    const drop = $('invDrop'), inp = $('invFile');
    inp.onchange = () => { $('invFiles').textContent = [...inp.files].map(f => f.name).join(', ') || 'PDF or photo — you can pick several pages'; };
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('on'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('on'); }));
    drop.addEventListener('drop', e => { inp.files = e.dataTransfer.files; inp.onchange(); });
    $('invPreset').onchange = () => { const P = { barakat: ['Barakat', 'BkVg,BkFr'], ag: ['AG Veg', 'VgCh,FrCh'], any: ['', ''] }[$('invPreset').value]; $('invSup').value = P[0]; $('invPre').value = P[1]; if (rows.length) { match(); render(); } };
    $('invBody').addEventListener('click', e => {
      if (e.target.closest('select,input')) return;
      const ph = e.target.closest('.iv-ph[data-full]'); if (ph) { if (typeof openLightbox === 'function') openLightbox(ph.dataset.full, ph.dataset.label || ''); return; }
      const chg = e.target.closest('.iv-chg'); if (chg) { chg.closest('.iv-card').classList.toggle('edit'); return; }
      const el = e.target.closest('[data-copy]'); if (!el) return;
      const t = el.innerText.trim().replace(/\s*\/\s*\w+$/, ''); if (!t) return;
      navigator.clipboard.writeText(t).then(() => status('Copied: ' + t));
    });
    $('invRun').onclick = run; $('invXls').onclick = exportXls; $('invCopy').onclick = copyTable; $('invEnhBtn').onclick = previewEnhance;
  }
  window.openInvoiceScanner = function () { build(); $('invModal').classList.add('open'); if (!db.length) status('Load the item list first.'); };
  document.addEventListener('DOMContentLoaded', build);
  const status = t => { $('invStatus').textContent = t; };

  /* ── Reading the document ── */
  async function pdfLines(buf) {
    await load(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise, out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const items = (await (await pdf.getPage(p)).getTextContent()).items.filter(i => i.str.trim());
      const byY = new Map();
      items.forEach(i => { const y = Math.round(i.transform[5] / 4); (byY.get(y) || byY.set(y, []).get(y)).push(i); });
      [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) => out.push(r.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str.trim()).join(' ')));
    }
    return out;
  }
  /* Document enhancer for faint / shadowed photos: enlarge → grey → flatten uneven lighting (divide by blurred background)
     → stretch contrast → darken faint ink. Tesseract does its own thresholding, so we keep soft grey (better for thin ink). */
  async function enhance(src) {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Could not open image')); i.src = src; });
    const k = Math.min(3, Math.max(1, 2400 / img.width)), W = Math.round(img.width * k), H = Math.round(img.height * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
    const bg = document.createElement('canvas'); bg.width = Math.max(8, W >> 4); bg.height = Math.max(8, H >> 4);
    const bgc = bg.getContext('2d', { willReadFrequently: true }); bgc.imageSmoothingQuality = 'high'; bgc.drawImage(c, 0, 0, bg.width, bg.height);
    const big = document.createElement('canvas'); big.width = W; big.height = H; const bigc = big.getContext('2d', { willReadFrequently: true });
    bigc.imageSmoothingQuality = 'high'; bigc.filter = 'blur(6px)'; bigc.drawImage(bg, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H), b = bigc.getImageData(0, 0, W, H), px = d.data, bp = b.data, hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      const y = px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114, back = Math.max(60, bp[i] * .299 + bp[i + 1] * .587 + bp[i + 2] * .114);
      const v = Math.min(255, y / back * 235) | 0; px[i] = v; hist[v]++;
    }
    const tot = W * H; let lo = 0, hi = 255, acc = 0;
    while (lo < 254 && (acc += hist[lo]) < tot * .005) lo++; acc = 0; while (hi > lo + 1 && (acc += hist[hi]) < tot * .35) hi--;   // paper ≈ top 35% → white
    for (let i = 0; i < px.length; i += 4) { const t = Math.max(0, Math.min(1, (px[i] - lo) / (hi - lo))), v = 255 * Math.pow(t, 1.7); px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
    g.putImageData(d, 0, 0); return c;
  }
  async function previewEnhance() {
    const f = [...$('invFile').files].find(f => !/\.pdf$/i.test(f.name)); if (!f) return status('Choose a photo first (PDF text is read directly).');
    status('Enhancing…'); const c = await enhance(URL.createObjectURL(f)); $('invEnhOut').innerHTML = ''; $('invEnhOut').appendChild(c); $('invEnh').open = true; status('Enhanced — this is what the reader will use.');
  }
  let worker = null;
  async function ocrOnce(canvasOrSrc) {
    if (!worker) { worker = await Tesseract.createWorker('eng'); await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); }
    const { data } = await worker.recognize(canvasOrSrc); return data.text.split('\n');
  }
  async function ocrLines(src) {
    await load(TESS); status('Reading image (OCR) — first time takes a bit…');
    let best = await ocrOnce(await enhance(src)), n = parseLines(best).res.length;
    if (n < 4) { status('Trying a second reading…'); const alt = await ocrOnce(src); if (parseLines(alt).res.length > n) best = alt; }   // fall back to untouched image
    return best;
  }
  async function pdfToImages(buf) {
    await load(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise, imgs = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p), vp = pg.getViewport({ scale: 2.5 }), c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; imgs.push(c.toDataURL('image/png'));
    }
    return imgs;
  }

  /* ── Parsing: "<supplier item no> <description> <ship date> <qty> <unit> <price> <amount>" ── */
  const NUM = '\\d[\\d,]*\\.\\d{1,4}';
  const ROW = new RegExp(`^(.*?)\\s+(${NUM})\\s+(\\S+)\\s+(${NUM})\\s+(${NUM})\\s*$`);
  const UOMS = 'KG|KGS|PCS|PC|PKT|PK|PACK|BOX|CTN|CARTON|BUNCH|TRAY|LTR|L|BAG|EACH|DOZ|TIN|CASE|SET|TUB|BTL|BOTTLE|PUNNET|CRATE|JAR|CAN';
  const UNIT_FIRST = new RegExp(`^(.*?)\\s+(${UOMS})\\s+((?:\\d[\\d,]*(?:\\.\\d+)?\\s+){2,}\\d[\\d,]*(?:\\.\\d+)?)\\s*$`, 'i');
  const KNOWN = new RegExp(`^(${UOMS})$`, 'i');
  const num = s => parseFloat(String(s).replace(/,/g, ''));
  function parseLines(lines) {
    const res = []; let no = '';
    lines.forEach(l => {
      l = l.replace(/\s+/g, ' ').trim();
      const n = l.match(/\b\d{3,4}-SO-\d+\b/i); if (n && !no) no = n[0];
      const ag = l.match(UNIT_FIRST);
      if (ag) {
        const n = ag[3].trim().split(/\s+/).map(num), prod = n[0] * n[1];
        const net = n.slice(2).find(v => v > 0 && Math.abs(v - prod) <= 0.02 + prod * 0.01);
        const d = ag[1].trim();
        if (/[a-z]{3}/i.test(d) && n[0] > 0 && !/^(sub ?total|total|sales|tax|vat|grand)/i.test(d))
          res.push({ desc: d.replace(/^\d+\s+/, ''), qty: n[0], unit: ag[2], price: n[1], amount: net ?? Math.round(prod * 100) / 100 });
        return;
      }
      const m = l.match(ROW); if (!m) return;
      let d = m[1].replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g, ' ').replace(/^\s*\d{1,3}\s+(?=\S*\d)/, '').trim();
      const first = d.split(' ')[0];
      if (/\d/.test(first) && /[a-z]/i.test(d.slice(first.length))) d = d.slice(first.length).trim();   // drop supplier item no.
      if (!/[a-z]{3}/i.test(d) || /^(sub ?total|total|sales|tax|vat|grand)/i.test(d)) return;
      res.push({ desc: d, qty: num(m[2]), unit: m[3], price: num(m[4]), amount: num(m[5]) });
    });
    return { res, no };
  }

  /* ── Matching ── */
  const STOP = new Set(['kg', 'pcs', 'pc', 'pkt', 'fresh', 'the', 'of', 'and', 'by', 'size', 'pp']);
  const SYN = { capsicum: 'pepper', courgette: 'zucchini', aubergine: 'eggplant', brinjal: 'eggplant', rocket: 'arugula', coriander: 'cilantro', shiso: 'shisho', romain: 'romaine', cos: 'romaine' };
  const LETTUCE_KINDS = ['romaine', 'iceberg', 'lollo', 'oak', 'butter', 'rosso', 'frisee', 'curly', 'batavia', 'green', 'red', 'mix', 'baby', 'lamb', 'little', 'gem', 'rossa', 'bionda'];
  const stem = t => /oes$/.test(t) ? t.slice(0, -2) : /ies$/.test(t) && t.length > 4 ? t.slice(0, -3) + 'y' : t.length > 3 ? t.replace(/s$/, '') : t;
  const tok = (s, inv) => {
    const set = new Set(String(s).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)).map(stem).map(t => SYN[t] || t));
    if (inv && set.has('lettuce') && !LETTUCE_KINDS.some(k => set.has(k))) set.add('romaine');   // plain "lettuce" means Lettuce Romaine in our list
    return set;
  };
  const invUom = u => { u = String(u || '').toLowerCase(); return /^kg|kilo/.test(u) ? 'Kg' : /^(pcs|piece|each|pc)/.test(u) ? 'Pc' : /^(pk|pack)/.test(u) ? 'Pkt' : /^(ltr|litre|liter|l$)/.test(u) ? 'Ltr' : /bunch/.test(u) ? 'Bunch' : /box/.test(u) ? 'Box' : /tray/.test(u) ? 'Tray' : /carton|case|ctn/.test(u) ? 'Carton' : u; };
  const ourBase = r => String(r.um || '').split(' (')[0];
  const uomOk = (r, u) => !r.um || invUom(u).toLowerCase() === ourBase(r).toLowerCase() || (invUom(u) === 'Carton' && /case/i.test(r.um));
  const near = (x, y) => { if (x === y) return true; if (x.length < 5 || Math.abs(x.length - y.length) > 1) return false; let i = 0, j = 0, e = 0;
    while (i < x.length && j < y.length) { if (x[i] === y[j]) { i++; j++; } else { if (++e > 1) return false; if (x.length > y.length) i++; else if (x.length < y.length) j++; else { i++; j++; } } } return e + (x.length - i) + (y.length - j) <= 1; };
  function score(a, b) { let i = 0; a.forEach(t => (b.has(t) || [...b].some(u => near(t, u))) && i++); if (!i) return 0; let sc = 2 * i / (a.size + b.size); if (i === a.size && i === b.size) sc += .15; else if (i === a.size) sc = Math.max(sc, 0.6 + 0.3 * i / b.size); return sc; }
  function candidates(desc, pool, price, unit) {
    const t = tok(desc, true);
    return pool.map(r => { let s = score(t, r._t || (r._t = tok(r.desc))); const c = parseFloat(r.cost);
      if (s > 0 && price && c && Math.abs(c - price) / price <= 0.1) s += 0.03; if (s > 0 && unit && uomOk(r, unit)) s += 0.08; return { r, s }; }).filter(x => x.s > 0.2).sort((a, b) => b.s - a.s).slice(0, 8);
  }
  function match() {
    const sup = $('invSup').value.trim().toLowerCase(), pre = $('invPre').value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const pool = db.filter(r => (!sup || (r.sup || '').toLowerCase().includes(sup)) && (!pre.length || pre.some(p => (r.id || '').toLowerCase().startsWith(p))));
    rows.forEach(x => {
      let c = candidates(x.desc, pool, x.price, x.unit); x.other = false;
      if (!c.length || c[0].s < 0.5) { const c2 = candidates(x.desc, db, x.price, x.unit); if (c2.length && (!c.length || c2[0].s > c[0].s)) { c = c2; x.other = true; } }
      x.cands = c; x.pick = c.length ? 0 : -1;
    });
  }
  /* The unit we show is always OUR item's unit. The invoice unit is only kept when it is a real unit and the item has none. */
  const uomOf = x => { const c = x.pick >= 0 ? x.cands[x.pick].r : null; if (c && c.um) return c.um; return KNOWN.test(String(x.unit)) ? invUom(x.unit) : 'Kg'; };

  async function run() {
    if (!db.length) return status('Load the item list first.');
    try {
      const files = [...$('invFile').files], pasted = $('invPaste').value.trim(); let lines = [];
      if (pasted) lines = pasted.split('\n');
      else if (!files.length) return status('Choose a PDF or image first (you can pick several photos).');
      else for (const f of files) {
        status('Reading ' + f.name + '…');
        if (/\.pdf$/i.test(f.name)) {
          const buf = await f.arrayBuffer(), t = await pdfLines(buf.slice(0));
          if (parseLines(t).res.length) lines.push(...t);
          else { await load(TESS); for (const im of await pdfToImages(buf)) lines.push(...await ocrLines(im)); }
        } else { await load(TESS); lines.push(...await ocrLines(URL.createObjectURL(f))); }
      }
      if (worker) { worker.terminate(); worker = null; }
      const { res, no } = parseLines(lines); rows = res; invNo = no;
      if (!rows.length) return status('Could not find item lines. Try the ✨ Enhance preview, a sharper photo, or paste the invoice text.');
      match(); render(); status(`${rows.length} lines found${no ? ' — ' + no : ''} — please check Qty and Price`);
    } catch (e) { console.error(e); status('Error: ' + e.message); }
  }

  const fmt = v => (v === '' || v == null || isNaN(v)) ? '' : (Math.round(v * 1000) / 1000).toString();
  const money = v => isNaN(v) ? '' : (+v).toFixed(2);
  const picker = (x, i) => `<div class="iv-pick"><select data-i="${i}"></select><input class="iv-q" data-i="${i}" placeholder="Search all items…"></div>`;
  function render() {
    $('invBody').innerHTML = `<div class="iv-sum" id="invSum"></div>
<div class="iv-cards">${rows.map((x, i) => `<div class="iv-card" data-i="${i}">
  <div class="iv-c1"><span class="iv-ph" data-f="ph" data-i="${i}"></span><div><div class="nm" data-f="desc" data-i="${i}" data-copy="1"></div><div class="iv-sub">Invoice: ${esc(x.desc)}</div></div></div>
  <div class="iv-c2"><span class="iv-code" data-f="code" data-i="${i}" data-copy="1"></span><span class="iv-uom" data-f="uom" data-i="${i}"></span><span class="iv-cost" data-copy="1">${money(x.price)}</span></div>
  <div class="iv-sub">${fmt(x.qty)} qty · amount ${money(x.amount)}</div>
  <span class="iv-chg">Change item</span>${picker(x, i)}</div>`).join('')}</div>
<div class="iv-tblwrap"><table class="iv-tbl"><thead><tr><th>#</th><th>Our item</th><th>Code</th><th>Invoice item</th><th class="r">Qty</th><th>UOM</th><th class="r">Cost</th><th class="r">Amount</th></tr></thead><tbody>${rows.map((x, i) => `<tr data-i="${i}"><td>${i + 1}</td>
<td><div class="it"><span class="iv-ph" data-f="ph" data-i="${i}"></span><div><div class="nm" data-f="desc" data-i="${i}" data-copy="1"></div>${picker(x, i)}</div></div></td>
<td><span class="iv-code" data-f="code" data-i="${i}" data-copy="1"></span></td><td>${esc(x.desc)}</td><td class="r">${fmt(x.qty)}</td><td><span class="iv-uom" data-f="uom" data-i="${i}"></span></td><td class="r" data-copy="1">${money(x.price)}</td><td class="r">${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>
<p class="iv-sub">Tap a code, item or cost to copy it. Tap a photo to enlarge.</p>`;
    $('invBody').querySelectorAll('select').forEach(sel => sel.onchange = () => { rows[sel.dataset.i].pick = +sel.value; sys(+sel.dataset.i); sumUp(); });
    $('invBody').querySelectorAll('.iv-q').forEach(q => q.oninput = () => search(+q.dataset.i, q.value));
    rows.forEach((_, i) => { opts(i); sys(i); }); sumUp();
  }
  function opts(i) {
    const x = rows[i];
    $('invBody').querySelectorAll(`select[data-i="${i}"]`).forEach(s => {
      s.innerHTML = x.cands.map((c, k) => `<option value="${k}" ${k === x.pick ? 'selected' : ''}>${esc(c.r.desc)} — ${esc(c.r.id)}</option>`).join('') + `<option value="-1" ${x.pick < 0 ? 'selected' : ''}>— no match —</option>`;
    });
  }
  function search(i, q) {   // search the whole item list, so nothing is ever "not showing"
    const w = q.toLowerCase().split(/\s+/).filter(Boolean); if (!w.length) return;
    const hit = db.filter(r => { const h = (r.desc + ' ' + r.id).toLowerCase(); return w.every(t => h.includes(t)); }).slice(0, 40);
    if (!hit.length) return;
    rows[i].cands = hit.map(r => ({ r, s: 1 })); rows[i].pick = 0; opts(i); sys(i); sumUp();
  }
  function sumUp() {
    const bad = rows.filter(x => x.pick < 0).length;
    $('invSum').innerHTML = `<span class="iv-chip">${rows.length} lines</span>${bad ? `<span class="iv-chip a">${bad} no match</span>` : ''}<span class="iv-chip">Total ${rows.reduce((a, x) => a + (x.amount || 0), 0).toFixed(2)}</span>`;
  }
  function sys(i) {
    const x = rows[i], c = x.pick >= 0 ? x.cands[x.pick].r : null;
    const set = (f, html, cls) => $('invBody').querySelectorAll(`[data-f="${f}"][data-i="${i}"]`).forEach(el => { el.innerHTML = html; if (cls !== undefined) el.classList.toggle('none', cls); });
    set('code', c ? esc(c.id) : 'No match', !c); set('desc', c ? esc(c.desc) : '— pick an item —'); set('uom', esc(uomOf(x)));
    const url = c ? photoOf(c.id) : '';
    $('invBody').querySelectorAll(`[data-f="ph"][data-i="${i}"]`).forEach(el => {
      if (url) { el.outerHTML = `<img class="iv-ph" data-f="ph" data-i="${i}" src="${esc(url)}" data-full="${esc(url.replace('_400x', ''))}" data-label="${esc(c.desc)}" loading="lazy" alt="">`; }
      else { el.className = 'iv-ph'; el.removeAttribute('data-full'); el.textContent = '📦'; }
    });
  }
  const out = () => rows.map((x, i) => { const c = x.pick >= 0 ? x.cands[x.pick].r : null;
    return { '#': i + 1, 'Invoice No': invNo, 'Our Code': c ? c.id : '', 'Our Item': c ? c.desc : '(NO MATCH)', 'Invoice Item': x.desc, Qty: x.qty, UOM: uomOf(x), 'Invoice Cost': x.price, 'System Cost': c ? c.cost : '', Amount: x.amount }; });
  function exportXls() { if (!rows.length) return; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out()), 'Invoice'); XLSX.writeFile(wb, `invoice-${invNo || 'matched'}.xlsx`); }
  function copyTable() { if (!rows.length) return; const o = out(); navigator.clipboard.writeText([Object.keys(o[0]).join('\t'), ...o.map(r => Object.values(r).join('\t'))].join('\n')).then(() => status('Copied — paste into Excel')); }

  window._invParse = parseLines;   // exposed for testing
})();
