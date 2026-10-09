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
    st.textContent = `
#invModal{position:fixed;inset:0;z-index:6000;background:var(--bg-color);display:none;flex-direction:column;font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:var(--text)}
#invModal.open{display:flex}
#invModal *{box-sizing:border-box}
#invModal{--iv-muted:#94a3b8;--iv-soft:rgba(255,255,255,.07);--iv-warn:#fbbf24;--iv-ok:#10b981}
[data-theme="light"] #invModal{--iv-muted:#475569;--iv-soft:rgba(15,23,42,.06);--iv-warn:#b45309;--iv-ok:#047857}
[data-theme="light"] .iv-code{background:rgba(5,150,105,.12);color:#047857}
.iv-top{display:flex;align-items:center;gap:12px;padding:calc(14px + env(safe-area-inset-top,0px)) 20px 12px;border-bottom:1px solid var(--glass-edge)}
.iv-top h2{margin:0;font-size:18px;font-weight:800;flex:1;letter-spacing:-.2px}
.iv-x{width:38px;height:38px;border-radius:50%;border:none;background:var(--iv-soft);color:var(--text);font-size:18px;cursor:pointer}
.iv-scroll{flex:1;overflow:auto;padding:16px 20px calc(96px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch}
.iv-drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 16px;border:1.5px dashed var(--glass-edge);border-radius:20px;background:var(--iv-soft);cursor:pointer;text-align:center;transition:.2s}
.iv-drop.on{border-color:var(--brand);background:rgba(16,185,129,.08)}
.iv-drop b{font-size:15px}.iv-drop small{color:var(--iv-muted);font-size:12px;word-break:break-all}
.iv-ctl{display:flex;gap:10px;margin:12px 0;flex-wrap:wrap}
.iv-ctl select{flex:1;min-width:200px;padding:13px 14px;border-radius:14px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:600 14px inherit}
.iv-go{padding:13px 26px;border:none;border-radius:14px;background:var(--brand);color:#fff;font:800 15px inherit;cursor:pointer}
.iv-sum{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 14px}
.iv-chip{padding:7px 12px;border-radius:50px;background:var(--iv-soft);font-size:12px;font-weight:700}
.iv-chip.g{color:var(--iv-ok)}.iv-chip.a{color:var(--iv-warn)}
.iv-paste summary{cursor:pointer;font-size:12px;color:var(--iv-muted);margin:4px 0 8px}
.iv-paste textarea{width:100%;border-radius:14px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);padding:12px}
.iv-bar{position:absolute;left:0;right:0;bottom:0;display:flex;gap:10px;padding:12px 20px calc(12px + env(safe-area-inset-bottom,0px));background:var(--bg-color);border-top:1px solid var(--glass-edge)}
.iv-bar button{flex:1;padding:14px;border-radius:14px;border:none;font:800 14px inherit;cursor:pointer;background:var(--iv-soft);color:var(--text)}
.iv-bar button.p{background:var(--brand);color:#fff}
.iv-st{font-size:12px;color:var(--iv-muted);margin:2px 2px 10px;min-height:16px}
/* phone cards */
.iv-card{background:var(--card-bg,#0d1829);border:1px solid var(--glass-edge);border-radius:20px;padding:14px 16px;margin-bottom:10px}
.iv-r1{display:flex;justify-content:space-between;align-items:center;gap:10px}
.iv-code{font:800 17px ui-monospace,monospace;color:var(--brand);background:rgba(16,185,129,.12);padding:6px 12px;border-radius:12px;cursor:pointer}
.iv-code.none{color:#dc2626;background:rgba(239,68,68,.12)}
.iv-cost{font-weight:800;font-size:20px;cursor:pointer}.iv-cost small{font-size:11px;color:var(--iv-muted);font-weight:600}
.iv-desc{margin:10px 0 4px;font-weight:700;font-size:15px;line-height:1.3;cursor:pointer}
.iv-meta{font-size:12px;color:var(--iv-muted);line-height:1.5}
.iv-warn{color:var(--iv-warn);font-weight:700}.iv-ok{color:var(--iv-ok);font-weight:700}
.iv-chg{display:inline-block;margin-top:8px;font-size:12px;color:var(--iv-muted);text-decoration:underline;cursor:pointer}
.iv-card select{display:none;width:100%;margin-top:8px;padding:11px;border-radius:12px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text)}
.iv-card.edit select{display:block}
/* desktop table */
.iv-tbl{width:100%;border-collapse:collapse;font-size:13px;min-width:980px}
.iv-tbl th{text-align:left;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--iv-muted);padding:10px;border-bottom:1px solid var(--glass-edge);white-space:nowrap}
.iv-tbl td{padding:10px;border-bottom:1px solid var(--glass-edge);vertical-align:middle}
.iv-tbl tr:hover td{background:var(--iv-soft)}
.iv-tbl select{min-width:300px;padding:8px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text)}
@media(min-width:900px){.iv-cards{display:none}}
@media(max-width:899px){.iv-tblwrap{display:none}}`;
    document.head.appendChild(st);
    const m = document.createElement('div'); m.id = 'invModal';
    m.innerHTML = `<div class="iv-top"><h2>📄 Invoice Scanner</h2><button class="iv-x" onclick="document.getElementById('invModal').classList.remove('open')">✕</button></div>
<div class="iv-scroll">
  <label class="iv-drop" id="invDrop"><span style="font-size:26px">⬆️</span><b>Tap to choose invoice</b><small id="invFiles">PDF or photo — you can pick several pages</small>
    <input type="file" id="invFile" accept=".pdf,image/*" multiple hidden></label>
  <div class="iv-ctl">
    <select id="invPreset"><option value="barakat">Barakat (BkVgCh / BkFrCh)</option><option value="ag">AG Vegetables (VgCh / FrCh)</option><option value="any">Any supplier</option></select>
    <button class="iv-go" id="invRun">Scan &amp; Match</button>
  </div>
  <input type="hidden" id="invSup" value="Barakat"><input type="hidden" id="invPre" value="BkVg,BkFr">
  <details class="iv-paste"><summary>Can't read the file? Paste invoice text instead</summary><textarea id="invPaste" rows="5" placeholder="Strawberry Pp  10/07/2026  3.00 Kg 50.00 150.00"></textarea></details>
  <div class="iv-st" id="invStatus"></div>
  <div id="invBody"></div>
</div>
<div class="iv-bar"><button class="p" id="invXls">⬇ Excel</button><button id="invCopy">Copy all</button></div>`;
    document.body.appendChild(m);
    const drop = $('invDrop'), inp = $('invFile');
    inp.onchange = () => { $('invFiles').textContent = [...inp.files].map(f => f.name).join(', ') || 'PDF or photo — you can pick several pages'; };
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('on'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('on'); }));
    drop.addEventListener('drop', e => { inp.files = e.dataTransfer.files; inp.onchange(); });
    $('invPreset').onchange = () => { const v = $('invPreset').value, P = { barakat: ['Barakat', 'BkVg,BkFr'], ag: ['AG Veg', 'VgCh,FrCh'], any: ['', ''] }[v]; $('invSup').value = P[0]; $('invPre').value = P[1]; if (rows.length) { match(); render(); } };
    $('invBody').addEventListener('click', e => {
      if (e.target.closest('select')) return;
      const chg = e.target.closest('.iv-chg'); if (chg) { chg.closest('.iv-card').classList.toggle('edit'); return; }
      const el = e.target.closest('td,[data-copy]'); if (!el) return;
      const t = el.innerText.trim().replace(/\s*\/\s*\w+$/, ''); if (!t) return;
      navigator.clipboard.writeText(t).then(() => { const o = $('toast'); if (o) { o.style.display = 'block'; setTimeout(() => o.style.display = 'none', 600); } status('Copied: ' + t); });
    });
    $('invRun').onclick = run; $('invXls').onclick = exportXls; $('invCopy').onclick = copyTable;
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
  /* Photo clean-up before OCR: enlarge, grey-scale, stretch contrast, then black/white. Big accuracy gain on WhatsApp photos. */
  async function prep(src) {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Could not open image')); i.src = src; });
    const k = Math.min(2.5, Math.max(1, 2200 / img.width)), c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data, hist = new Array(256).fill(0);
    for (let i = 0; i < px.length; i += 4) { const y = (px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114) | 0; px[i] = y; hist[y]++; }
    const tot = c.width * c.height; let lo = 0, hi = 255, acc = 0;                      // stretch contrast between 1% and 99%
    while (lo < 254 && (acc += hist[lo]) < tot * .01) lo++; acc = 0; while (hi > lo + 1 && (acc += hist[hi]) < tot * .01) hi--;
    for (let i = 0; i < px.length; i += 4) { const v = Math.max(0, Math.min(255, (px[i] - lo) * 255 / (hi - lo))); px[i] = px[i + 1] = px[i + 2] = v; }
    g.putImageData(d, 0, 0); return c;
  }
  let worker = null, usedOcr = false;
  async function ocrLines(imgSrc) {
    usedOcr = true; await load(TESS); status('Reading image (OCR) — first time takes a bit…');
    if (!worker) { worker = await Tesseract.createWorker('eng'); await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); }
    const { data } = await worker.recognize(await prep(imgSrc)); return data.text.split('\n');
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
  const UOMS = 'KG|KGS|PCS|PC|PKT|PK|PACK|BOX|CTN|CARTON|BUNCH|TRAY|LTR|L|BAG|EACH|DOZ|TIN|CASE|SET|TUB|BTL|BOTTLE|PUNNET|CRATE|JAR|CAN';
  const UNIT_FIRST = new RegExp(`^(.*?)\\s+(${UOMS})\\s+((?:\\d[\\d,]*(?:\\.\\d+)?\\s+){2,}\\d[\\d,]*(?:\\.\\d+)?)\\s*$`, 'i');
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
  const STOP = new Set(['kg', 'pcs', 'pc', 'pkt', 'fresh', 'the', 'of', 'and', 'by', 'size']);
  const SYN = { capsicum: 'pepper', courgette: 'zucchini', aubergine: 'eggplant', brinjal: 'eggplant', rocket: 'arugula', coriander: 'cilantro', shiso: 'shisho', romain: 'romaine', cos: 'romaine', spinach: 'spinach' };
  const tok = s => new Set(String(s).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)).map(t => t.length > 3 ? t.replace(/s$/, '') : t).map(t => SYN[t] || t));
  const invUom = u => { u = String(u || '').toLowerCase(); return /^kg|kilo/.test(u) ? 'Kg' : /pcs|piece|each|^pc/.test(u) ? 'Pc' : /pk|pack/.test(u) ? 'Pkt' : /ltr|litre|liter/.test(u) ? 'Ltr' : /bunch/.test(u) ? 'Bunch' : /box/.test(u) ? 'Box' : /tray/.test(u) ? 'Tray' : /carton|case/.test(u) ? 'Carton' : u; };
  const uomOk = (r, u) => !r.um || invUom(u).toLowerCase() === String(r.um).split(' (')[0].toLowerCase() || (invUom(u) === 'Carton' && /case/i.test(r.um));
  const near = (x, y) => { if (x === y) return true; if (x.length < 5 || Math.abs(x.length - y.length) > 1) return false; let i = 0, j = 0, e = 0;
    while (i < x.length && j < y.length) { if (x[i] === y[j]) { i++; j++; } else { if (++e > 1) return false; if (x.length > y.length) i++; else if (x.length < y.length) j++; else { i++; j++; } } } return e + (x.length - i) + (y.length - j) <= 1; };
  function score(a, b) { let i = 0; a.forEach(t => (b.has(t) || [...b].some(u => near(t, u))) && i++); if (!i) return 0; let sc = 2 * i / (a.size + b.size); if (i === a.size && i === b.size) sc += .15; else if (i === a.size) sc = Math.max(sc, 0.6 + 0.3 * i / b.size); return sc; }
  function candidates(desc, pool, price, unit) {
    const t = tok(desc);
    return pool.map(r => { let s = score(t, r._t || (r._t = tok(r.desc))); const c = parseFloat(r.cost);
      if (s > 0 && price && c && Math.abs(c - price) / price <= 0.1) s += 0.03; if (s > 0 && unit && uomOk(r, unit)) s += 0.08; return { r, s }; }).filter(x => x.s > 0.2).sort((a, b) => b.s - a.s).slice(0, 6);
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
    if (!window.INVOICE_CLOUD_OCR) return null;   // set window.INVOICE_CLOUD_OCR = true only if the scan-invoice Edge Function is deployed
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
      usedOcr = false;
      const files = [...$('invFile').files], pasted = $('invPaste').value.trim();
      let lines = [];
      if (pasted) lines = pasted.split('\n');
      else if (!files.length) return status('Choose a PDF or image first (you can pick several photos).');
      else for (const f of files) {
        status('Reading ' + f.name + '…');
        if (/\.pdf$/i.test(f.name)) {
          const buf = await f.arrayBuffer(), t = await pdfLines(buf.slice(0));
          if (parseLines(t).res.length) lines.push(...t);
          else for (const im of await pdfToImages(buf)) lines.push(...await ocrLines(im));
        } else lines.push(...await ocrLines(URL.createObjectURL(f)));
      }
      if (worker) { worker.terminate(); worker = null; }
      const { res, no } = parseLines(lines); rows = res; invNo = no;
      if (!rows.length) return status('Could not find item lines. Try a sharper photo, or paste the invoice text below.');
      match(); render(); status(`${rows.length} lines found${no ? ' — ' + no : ''} — please check Qty and Price`);
    } catch (e) { console.error(e); status('Error: ' + e.message); }
  }

  const fmt = v => (v === '' || v == null || isNaN(v)) ? '' : (Math.round(v * 1000) / 1000).toString();
  const money = v => isNaN(v) ? '' : (+v).toFixed(2);
  function render() {
    const sum = rows.reduce((a, x) => a + (x.amount || 0), 0);
    const opts = (x, i) => `<select data-i="${i}">${x.cands.map((c, k) => `<option value="${k}" ${k === x.pick ? 'selected' : ''}>${esc(c.r.desc)}${x.other ? ' (other supplier)' : ''} — ${esc(c.r.id)}</option>`).join('')}<option value="-1" ${x.pick < 0 ? 'selected' : ''}>— no match —</option></select>`;
    $('invBody').innerHTML = `<div class="iv-sum" id="invSum"></div>
<div class="iv-cards">${rows.map((x, i) => `<div class="iv-card" data-i="${i}">
  <div class="iv-r1"><span class="iv-code" data-f="code" data-i="${i}" data-copy="1"></span><span class="iv-cost" data-copy="1">${money(x.price)} <small>/ ${esc(x.unit)}</small></span></div>
  <div class="iv-desc" data-f="desc" data-i="${i}" data-copy="1"></div>
  <div class="iv-meta">Invoice: ${esc(x.desc)} · ${fmt(x.qty)} ${esc(x.unit)} · ${money(x.amount)}</div>
  <div class="iv-meta" data-f="chk" data-i="${i}"></div>
  <span class="iv-chg">Change item</span>${opts(x, i)}</div>`).join('')}</div>
<div class="iv-tblwrap"><table class="iv-tbl"><thead><tr><th>#</th><th>Our code (click to copy)</th><th>Our item</th><th>Invoice item</th><th>Qty</th><th>Invoice UOM</th><th>Our UOM</th><th>Invoice cost</th><th>Check</th><th>Amount</th></tr></thead><tbody>${rows.map((x, i) => `<tr><td>${i + 1}</td>
<td data-f="code" data-i="${i}" style="font:800 14px ui-monospace,monospace;color:var(--brand);white-space:nowrap"></td><td>${opts(x, i)}</td><td>${esc(x.desc)}</td><td>${fmt(x.qty)}</td><td>${esc(x.unit)}</td><td data-f="uom" data-i="${i}"></td><td>${money(x.price)}</td><td data-f="chk" data-i="${i}"></td><td>${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>
<p style="font-size:12px;color:var(--iv-muted)">Invoice net total: ${sum.toFixed(2)} — compare with your invoice. Tap a code, item or cost to copy it.</p>`;
    $('invBody').querySelectorAll('select').forEach(sel => sel.onchange = () => { rows[sel.dataset.i].pick = +sel.value; sys(+sel.dataset.i); sumUp(); });
    rows.forEach((_, i) => sys(i)); sumUp();
  }
  const issuesOf = x => {
    const c = x.pick >= 0 ? x.cands[x.pick] : null, out = []; if (!c) return ['no match'];
    if (c.r.um && !uomOk(c.r, x.unit)) out.push('UOM differs');
    return out;
  };
  function sumUp() {
    const bad = rows.filter(x => issuesOf(x).length).length;
    $('invSum').innerHTML = `<span class="iv-chip">${rows.length} lines</span><span class="iv-chip g">${rows.length - bad} OK</span>${bad ? `<span class="iv-chip a">${bad} to check</span>` : ''}<span class="iv-chip">Total ${rows.reduce((a, x) => a + (x.amount || 0), 0).toFixed(2)}</span>`;
  }
  function sys(i) {
    const x = rows[i], c = x.pick >= 0 ? x.cands[x.pick] : null, iss = issuesOf(x);
    const set = (f, html, cls) => $('invBody').querySelectorAll(`[data-f="${f}"][data-i="${i}"]`).forEach(el => { el.innerHTML = html; if (cls !== undefined) el.classList.toggle('none', cls); });
    set('code', c ? esc(c.r.id) : 'No match', !c); set('desc', c ? esc(c.r.desc) : '—'); set('uom', c ? esc(c.r.um || '—') : '');
    set('chk', iss.length ? `<span class="iv-warn">⚠ ${iss.join(', ')}</span>` : '<span class="iv-ok">✓ OK</span>');
  }
  const out = () => rows.map((x, i) => { const c = x.pick >= 0 ? x.cands[x.pick].r : null;
    return { '#': i + 1, 'Invoice No': invNo, 'Our Code': c ? c.id : '', 'Our Item': c ? c.desc : '(NO MATCH)', 'Invoice Item': x.desc, Qty: x.qty, 'Invoice UOM': x.unit, 'Our UOM': c ? c.um : '', 'Invoice Cost': x.price, 'System Cost': c ? c.cost : '', Amount: x.amount }; });
  function exportXls() { if (!rows.length) return; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out()), 'Invoice'); XLSX.writeFile(wb, `invoice-${invNo || 'matched'}.xlsx`); }
  function copyTable() { if (!rows.length) return; const o = out(); navigator.clipboard.writeText([Object.keys(o[0]).join('\t'), ...o.map(r => Object.values(r).join('\t'))].join('\n')).then(() => status('Copied — paste into Excel')); }

  window._invParse = parseLines;   // exposed for testing
})();
