/* Invoice Scanner — upload a supplier invoice (PDF / image), match each line to our item codes.
   Uses globals from index.html: db (items), XLSX. Libraries load only when first used. */
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

  /* ── UI ── */
  function build() {
    if ($('invModal')) return;
    const st = document.createElement('style');
    st.textContent = `#invFab{position:fixed;left:16px;bottom:96px;z-index:900;padding:12px 16px;border:none;border-radius:50px;background:var(--brand);color:#fff;font:800 13px 'Plus Jakarta Sans',sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)}
#invModal{position:fixed;inset:0;z-index:6000;background:var(--bg-color);display:none;flex-direction:column;overflow:hidden}
#invModal.open{display:flex}
#invModal header{display:flex;gap:10px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--glass-edge)}
#invModal header h2{margin:0;font-size:18px;flex:1}
#invModal .bar{display:flex;flex-wrap:wrap;gap:10px;padding:14px 20px;align-items:center}
#invModal .bar input[type=text]{padding:10px 12px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font-family:inherit}
#invModal button.b{padding:10px 16px;border-radius:10px;border:none;background:var(--brand);color:#fff;font:800 13px 'Plus Jakarta Sans',sans-serif;cursor:pointer}
#invModal button.g{background:rgba(255,255,255,.08);color:var(--text)}
#invBody{flex:1;overflow:auto;padding:0 20px 20px}
#invBody table{width:100%;border-collapse:collapse;font-size:13px}
#invBody th,#invBody td{padding:8px 10px;border-bottom:1px solid var(--glass-edge);text-align:left;vertical-align:top}
#invBody th{position:sticky;top:0;background:var(--card-bg)}
#invBody select{max-width:360px;width:100%;padding:6px;border-radius:8px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text)}
.cf-h{color:#10b981}.cf-m{color:#fbbf24}.cf-l{color:#ef4444}`;
    document.head.appendChild(st);
    const fab = document.createElement('button'); fab.id = 'invFab'; fab.textContent = '📄 Scan Invoice'; fab.onclick = openInvoiceScanner;
    document.body.appendChild(fab);
    const m = document.createElement('div'); m.id = 'invModal';
    m.innerHTML = `<header><h2>📄 Invoice Scanner</h2><button class="b g" onclick="document.getElementById('invModal').classList.remove('open')">✕ Close</button></header>
<div class="bar">
  <input type="file" id="invFile" accept=".pdf,image/*">
  <select id="invPreset" style="padding:10px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text)"><option value="barakat">Barakat (BkVgCh / BkFrCh)</option><option value="ag">AG Vegetables (VgCh / FrCh)</option><option value="any">Any supplier</option></select>
  <input type="hidden" id="invSup" value="Barakat"><input type="hidden" id="invPre" value="BkVg,BkFr">
  <button class="b" id="invRun">Scan &amp; Match</button>
  <button class="b g" id="invXls">⬇ Excel</button>
  <button class="b g" id="invCopy">Copy</button>
  <span id="invStatus" style="font-size:12px;color:#94a3b8"></span>
</div>
<details class="bar" style="display:block"><summary style="cursor:pointer;font-size:12px;color:#94a3b8">No luck reading the file? Paste invoice text here instead</summary>
<textarea id="invPaste" rows="5" style="width:100%;margin-top:8px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);padding:10px" placeholder="Strawberry Pp  10/07/2026  3.00 Kg 50.00 150.00"></textarea></details>
<div id="invBody"></div>`;
    document.body.appendChild(m);
    $('invPreset').onchange = () => { const v = $('invPreset').value, P = { barakat: ['Barakat', 'BkVg,BkFr'], ag: ['AG Veg', 'VgCh,FrCh'], any: ['', ''] }[v]; $('invSup').value = P[0]; $('invPre').value = P[1]; if (rows.length) { match(); render(); } };
    $('invRun').onclick = run; $('invXls').onclick = exportXls; $('invCopy').onclick = copyTable;
  }
  window.openInvoiceScanner = function () { build(); $('invModal').classList.add('open'); if (!db.length) status('Load the item list first (📁 / cloud).'); };
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
  async function ocrLines(imgSrc) {
    await load(TESS); status('Reading image (OCR) — first time takes a bit…');
    const { data } = await Tesseract.recognize(imgSrc, 'eng'); return data.text.split('\n');
  }
  async function pdfToImages(buf) {
    await load(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise, imgs = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p), vp = pg.getViewport({ scale: 2 }), c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; imgs.push(c.toDataURL('image/png'));
    }
    return imgs;
  }

  /* ── Parsing: "<supplier item no> <description> <ship date> <qty> <unit> <price> <amount>" ── */
  const NUM = '\\d[\\d,]*\\.\\d{1,4}';
  const ROW = new RegExp(`^(.*?)\\s+(${NUM})\\s+(\\S+)\\s+(${NUM})\\s+(${NUM})\\s*$`);
  const num = s => parseFloat(String(s).replace(/,/g, ''));
  function parseLines(lines) {
    const res = []; let no = '';
    lines.forEach(l => {
      l = l.replace(/\s+/g, ' ').trim();
      const n = l.match(/\b\d{3,4}-SO-\d+\b/i); if (n && !no) no = n[0];
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
  const STOP = new Set(['kg', 'pcs', 'pc', 'pkt', 'fresh', 'the', 'of', 'and', 'by', 'size']);
  const tok = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t)).map(t => t.length > 3 ? t.replace(/s$/, '') : t));
  const invUom = u => { u = String(u || '').toLowerCase(); return /^kg|kilo/.test(u) ? 'Kg' : /pcs|piece|each|^pc/.test(u) ? 'Pc' : /pk|pack/.test(u) ? 'Pkt' : /ltr|litre|liter/.test(u) ? 'Ltr' : /bunch/.test(u) ? 'Bunch' : /box/.test(u) ? 'Box' : /tray/.test(u) ? 'Tray' : /carton|case/.test(u) ? 'Carton' : u; };
  const uomOk = (r, u) => !r.um || invUom(u).toLowerCase() === String(r.um).split(' (')[0].toLowerCase() || (invUom(u) === 'Carton' && /case/i.test(r.um));
  const near = (x, y) => { if (x === y) return true; if (x.length < 5 || Math.abs(x.length - y.length) > 1) return false; let i = 0, j = 0, e = 0;
    while (i < x.length && j < y.length) { if (x[i] === y[j]) { i++; j++; } else { if (++e > 1) return false; if (x.length > y.length) i++; else if (x.length < y.length) j++; else { i++; j++; } } } return e + (x.length - i) + (y.length - j) <= 1; };
  function score(a, b) { let i = 0; a.forEach(t => (b.has(t) || [...b].some(u => near(t, u))) && i++); if (!i) return 0; let sc = 2 * i / (a.size + b.size); if (i === a.size && i === b.size) sc += .15; return sc; }
  function candidates(desc, pool, price, unit) {
    const t = tok(desc);
    return pool.map(r => { let s = score(t, r._t || (r._t = tok(r.desc))); const c = parseFloat(r.cost);
      if (s > 0 && price && c && Math.abs(c - price) / price <= 0.1) s += 0.1; if (s > 0 && unit && uomOk(r, unit)) s += 0.08; return { r, s }; }).filter(x => x.s > 0.2).sort((a, b) => b.s - a.s).slice(0, 6);
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

  /* Cloud OCR (Claude vision via Supabase Edge Function). Returns null if not set up, so local OCR is used instead. */
  async function cloudScan(f) {
    try {
      const { data } = await sb.auth.getSession(); if (!data.session) return null;
      const b64 = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result.split(',')[1]); r.readAsDataURL(f); });
      const res = await fetch(SUPABASE_URL + '/functions/v1/scan-invoice', { method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + data.session.access_token },
        body: JSON.stringify({ data: b64, mediaType: f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : 'image/jpeg') }) });
      if (!res.ok) return null; return await res.json();
    } catch (e) { return null; }
  }
  async function run() {
    if (!db.length) return status('Load the item list first.');
    try {
      const f = $('invFile').files[0], pasted = $('invPaste').value.trim();
      let lines;
      if (pasted) lines = pasted.split('\n');
      else if (!f) return status('Choose a PDF or image first.');
      else if (f && (status('Reading with cloud OCR…'), true) && await cloudScan(f).then(j => { if (!j || !j.lines || !j.lines.length) return false;
        rows = j.lines.map(l => ({ desc: String(l.desc), qty: +l.qty, unit: String(l.unit || ''), price: +l.price, amount: +l.amount })); invNo = j.invoice_no || '';
        const t = (j.supplier || '').toLowerCase(), pr = $('invPreset'); if (/barakat/.test(t)) pr.value = 'barakat'; else if (/\bag\b/.test(t)) pr.value = 'ag'; pr.onchange(); match(); render(); status(`${rows.length} lines (cloud OCR)${invNo ? ' — ' + invNo : ''}`); return true; })) return;
      else if (/\.pdf$/i.test(f.name)) {
        const buf = await f.arrayBuffer(); status('Reading PDF…');
        lines = await pdfLines(buf.slice(0));
        if (!parseLines(lines).res.length) { lines = []; for (const im of await pdfToImages(buf)) lines.push(...await ocrLines(im)); }
      } else lines = await ocrLines(URL.createObjectURL(f));
      const { res, no } = parseLines(lines); rows = res; invNo = no;
      if (!rows.length) return status('Could not find item lines. Try pasting the invoice text below.');
      match(); render(); status(`${rows.length} lines found${no ? ' — ' + no : ''}`);
    } catch (e) { console.error(e); status('Error: ' + e.message); }
  }

  function render() {
    const sum = rows.reduce((a, x) => a + (x.amount || 0), 0);
    $('invBody').innerHTML = `<table><thead><tr><th>#</th><th>Invoice item</th><th>Qty</th><th>Invoice UOM</th><th>Invoice cost</th><th>Our code &amp; item</th><th>System cost</th><th>Our UOM</th></tr></thead><tbody>` +
      rows.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.desc)}</td><td>${x.qty}</td><td>${esc(x.unit)}</td><td>${x.price.toFixed(2)}</td>
<td><select data-i="${i}">${x.cands.map((c, k) => `<option value="${k}" ${k === x.pick ? 'selected' : ''}>${esc(c.r.id)} — ${esc(c.r.desc)}${x.other ? ' (other supplier)' : ''}</option>`).join('')}<option value="-1" ${x.pick < 0 ? 'selected' : ''}>— no match —</option></select></td>
<td id="invSys${i}"></td><td id="invUom${i}"></td></tr>`).join('') +
      `</tbody></table><p style="font-size:12px;color:#94a3b8">Lines total: ${sum.toFixed(2)} AED (compare with invoice subtotal). Green = strong match, amber = check, red = weak.</p>`;
    $('invBody').querySelectorAll('select').forEach(s => s.onchange = () => { rows[s.dataset.i].pick = +s.value; sys(+s.dataset.i); });
    rows.forEach((_, i) => sys(i));
  }
  function sys(i) {
    const x = rows[i], c = x.pick >= 0 ? x.cands[x.pick] : null, td = $('invSys' + i);
    const ut = $('invUom' + i);
    if (!c) { td.innerHTML = '<span class="cf-l">—</span>'; ut.textContent = ''; return; }
    ut.innerHTML = c.r.um ? esc(c.r.um) + (uomOk(c.r, x.unit) ? '' : ' <span class="cf-m" title="Invoice unit differs from our UOM">⚠ check</span>') : '<span class="cf-l">no UOM</span>';
    const cost = parseFloat(c.r.cost), diff = !isNaN(cost) && Math.abs(cost - x.price) > 0.005;
    td.innerHTML = `<span class="${c.s >= .8 ? 'cf-h' : c.s >= .5 ? 'cf-m' : 'cf-l'}">${esc(c.r.cost)}</span>${diff ? ' <small title="Differs from invoice price">⚠</small>' : ''}`;
  }
  const out = () => rows.map((x, i) => { const c = x.pick >= 0 ? x.cands[x.pick].r : null;
    return { '#': i + 1, 'Invoice No': invNo, 'Our Code': c ? c.id : '', 'Our Item': c ? c.desc : x.desc + ' (NO MATCH)', Qty: x.qty, 'Invoice UOM': x.unit, 'Our UOM': c ? c.um : '', 'Invoice Cost': x.price, 'System Cost': c ? c.cost : '', Amount: x.amount }; });
  function exportXls() { if (!rows.length) return; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out()), 'Invoice'); XLSX.writeFile(wb, `invoice-${invNo || 'matched'}.xlsx`); }
  function copyTable() { if (!rows.length) return; const o = out(); navigator.clipboard.writeText([Object.keys(o[0]).join('\t'), ...o.map(r => Object.values(r).join('\t'))].join('\n')).then(() => status('Copied — paste into Excel')); }

  window._invParse = parseLines;   // exposed for testing
})();
