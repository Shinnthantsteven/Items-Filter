/* Invoice Scanner v4 — upload a supplier invoice (PDF / photo), read it line by line, match each line to our item codes.
   Uses globals from index.html: db (items), imageMap, openLightbox, XLSX. Libraries load only when first used.
   Pipeline:  document enhancer (deskew · flatten shadows · 2 cleaned versions) → several OCR passes →
              line reader that repairs OCR digits using qty × price = amount → passes are merged line by line →
              total check against the invoice subtotal → smart matcher (fuzzy spelling, price, unit, learned picks). */
(function () {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
  let rows = [], invNo = '', recon = null, missingNo = [];

  const load = src => new Promise((ok, no) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const photoOf = id => { try { return (typeof imageMap !== 'undefined' && imageMap[id]) || ''; } catch (e) { return ''; } };

  /* ══════════════ ENGINE 1 — reading one invoice line ══════════════ */
  const DMAP = { O: '0', o: '0', '°': '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', '!': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };
  const rep = t => String(t).replace(/[OoQDIl|!iSsBZzG°]/g, c => DMAP[c] || c);
  /* "1,156.00" / "1.156,00" / "O.OO" / "5O.OO" → number, NaN if it is not a money-looking value (dates and % are rejected) */
  function fixNum(t) {
    t = String(t).trim(); if (/%|\//.test(t) || !/\d/.test(t)) return NaN;
    t = rep(t.replace(/[^0-9A-Za-z.,|!°]/g, '')); if (/[^\d.,]/.test(t)) return NaN;
    if (/\..*,|,.*\./.test(t)) { const d = Math.max(t.lastIndexOf('.'), t.lastIndexOf(',')); t = t.slice(0, d).replace(/[.,]/g, '') + '.' + t.slice(d + 1); }
    else if (/,\d{2}$/.test(t)) t = t.replace(',', '.'); else t = t.replace(/,/g, '');
    t = t.replace(/\.(?=.*\.)/g, '');
    return /^\d+\.\d{1,3}$/.test(t) ? parseFloat(t) : NaN;
  }
  /* quantity: may come as "1/00" or "20" or "5.0O" */
  function qtyNum(t) {
    t = String(t).trim().replace(/(\d)\/(\d{2})$/, '$1.$2'); if (!/\d/.test(t)) return NaN;
    t = rep(t).replace(',', '.'); if (/[^\d.]/.test(t)) return NaN;
    return /^\d{1,5}(\.\d{1,3})?$/.test(t) && parseFloat(t) >= 0.05 ? parseFloat(t) : NaN;
  }
  const tolA = a => 0.02 + a * 0.004;
  const niceQ = q => q >= 0.05 && q < 5000 && Math.abs(q * 20 - Math.round(q * 20)) < 0.02;
  const niceP = p => p >= 0.1 && Math.abs(p * 100 - Math.round(p * 100)) < 0.03;
  /* The "arithmetic judge": find qty, price, amount that satisfy qty × price = amount, using every number the OCR gave us. */
  /* A "group" = every number a garbled token could really be, cheapest guess first: [{v, c}] (c = how many look-alike swaps it took) */
  const G = v => [{ v, c: 0 }];
  function numGroup(t, qty) {
    t = String(t).trim(); if (/%/.test(t)) return null;
    if (qty) t = t.replace(/(\d)\/(\d{2})$/, '$1.$2'); else if (/\//.test(t)) return null;
    if (!/\d/.test(t)) return null;
    let junk = 0, s = rep(t.replace(/[^0-9A-Za-z.,|!°@€]/g, '')).replace(/[@€ea]/g, () => (junk++, '0'));
    if (/[^\d.,]/.test(s)) return null;
    const pos = []; for (let i = s.length - 1; i >= 0 && pos.length < 5; i--) if (s[i] === '6' || s[i] === '8') pos.push(i);
    const out = new Map();
    for (let m = 0; m < (1 << pos.length); m++) {
      let u = s.split(''), c = junk * .3; pos.forEach((p, k) => { if (m >> k & 1) { u[p] = '0'; c++; } }); u = u.join('');
      let v = qty ? qtyNum(u) : fixNum(u);
      if (isNaN(v) && !qty && /^\d{3,6}00$/.test(u)) v = parseInt(u, 10) / 100;
      if (v > 0 && (!out.has(v) || out.get(v) > c)) out.set(v, c);
    }
    return out.size ? [...out].map(([v, c]) => ({ v, c })).sort((x, y) => x.c - y.c) : null;
  }
  const baseV = g => g[0].v;
  function solve(cq, cn, loose) {
    let best = null; const put = o => { if (!best || o.s > best.s) best = o; };
    cn.forEach((pg, i) => cn.forEach((ag, j) => {
      if (i === j || (!loose && j < i)) return;
      const am = new Map(); ag.forEach(a => { const k = Math.round(a.v * 100); if (!am.has(k) || am.get(k).c > a.c) am.set(k, a); });
      pg.forEach(p => {
        cq.forEach(qg => qg.forEach(q => { const t = q.v * p.v;
          for (const d of [-1, 0, 1]) { const a = am.get(Math.round(t * 100) + d); if (a && (a.v >= p.v || q.v < 1) && Math.abs(t - a.v) <= .011) put({ qty: q.v, price: p.v, amount: a.v, ok: true, s: 100 - 2 * (q.c + p.c + a.c) - i * .1 }); }
          ag.forEach(a => { if (!q.c && !p.c && !a.c && (a.v >= p.v || q.v < 1) && Math.abs(t - a.v) <= tolA(a.v)) put({ qty: q.v, price: p.v, amount: a.v, ok: true, s: 99 - i * .1 }); });
        }));
        if (!cq.length) ag.forEach(a => { if (a.v < p.v) return; const q = a.v / p.v; if (niceQ(q)) put({ qty: Math.round(q * 1000) / 1000, price: p.v, amount: a.v, ok: true, s: 70 - 2 * (p.c + a.c) - i * .1 }); });   // qty unreadable → work it out
      });
    }));
    if (best) return best;
    const q0 = cq.map(baseV), n0 = cn.map(baseV);   // nothing fits exactly → best guess from the plainest reading
    n0.forEach((p, i) => n0.forEach((a, j) => { if (j <= i || a < p) return; const q = a / p;
      if (q0.length && Math.abs(q * 2 - Math.round(q * 2)) < .01) put({ qty: Math.round(q * 1000) / 1000, price: p, amount: a, ok: false, s: 40 - i * .1 }); }));
    q0.forEach(q => n0.forEach((a, j) => { const p = a / q; if (niceP(p)) put({ qty: q, price: Math.round(p * 100) / 100, amount: a, ok: false, s: 50 - (n0.length - 1 - j) * .1 }); }));
    if ((!best || best.s < 30) && q0.length && n0.length) put({ qty: q0[0], price: n0[0], amount: Math.round(q0[0] * n0[0] * 100) / 100, ok: false, s: 30 });
    if (!best && n0.length) put({ qty: q0[0] || 1, price: n0[0], amount: n0.length > 1 ? n0[n0.length - 1] : n0[0], ok: false, s: 10 });
    return best;
  }
  const TOKU = /^(kgs?|k[gqyc9o]|key|kay|kary|ke|pcs|pies|pc|pkt|box|bunch|ctn|ltr|ea|doz)\.?$/i;
  const unitName = u => { u = u.toLowerCase(); return /^(pcs|pies|pc|ea)/.test(u) ? 'Pcs' : /^pkt/.test(u) ? 'Pkt' : /^box/.test(u) ? 'Box' : /^bunch/.test(u) ? 'Bunch' : /^ltr/.test(u) ? 'Ltr' : /^ctn/.test(u) ? 'Carton' : /^doz/.test(u) ? 'Doz' : 'Kg'; };
  const SKIP = /^(sub ?total|total|sales|tax|vat|grand|currency|amount|description|item|print|code|discount)\b/i;
  const DATEJUNK = /^(to[mnts]{1,2}|tots?|vo\w{0,3}|ost|iost|ion|toa|t0\w*)$/i;
  const alphaSeg = s => { const a = (s.match(/[A-Za-z]/g) || []).length, n = s.replace(/\s/g, '').length; return a >= 3 && a / n >= .75; };
  /* text left of the unit = "<supplier item no> <description> <ship date> <qty>" — the wide gaps OCR keeps tell us where the name ends */
  function descFrom(left) {
    const L = left.trim(), segs = L.split(/\s{3,}/); let desc = '', no = '';
    if (segs.length >= 3) { const k = alphaSeg(segs[1]) ? 1 : segs.findIndex(alphaSeg); if (k >= 0) { desc = segs[k]; no = segs.slice(0, k).join(''); } }
    if (!desc) {
      const tk = L.split(/\s+/); let i = 0; if (tk.length > 1 && /\d/.test(tk[0])) { no = tk[0]; i = 1; }
      const out = []; for (; i < tk.length; i++) { if (/\d|\//.test(tk[i]) && tk[i] !== '/') break; out.push(tk[i]); }
      if (out.length > 1 && i < tk.length && DATEJUNK.test(out[out.length - 1])) out.pop();
      desc = out.join(' ');
    }
    desc = desc.replace(/[|—–_\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\d+\s+/, '').replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z)]+$/, '');
    no = rep(no).replace(/\D/g, ''); if (!/^\d{5,7}$/.test(no)) no = '';
    return { desc, no };
  }
  /* Faint photocopies: OCR garbles digits and the unit ("Kg" → "Key", "Ky"…). Anchor on the unit, then repair with qty × price = amount. */
  function parseTolerant(raw) {
    const line = raw.replace(/\s+$/, ''); if (line.trim().length < 8 || SKIP.test(line.trim())) return null;
    const toks = [...line.matchAll(/\S+/g)].map(m => ({ t: m[0], i: m.index }));
    let u = -1, qg = null;
    for (let pass = 0; pass < 2 && u < 0; pass++) for (let k = 1; k < toks.length; k++) {
      if (!TOKU.test(toks[k].t)) continue;
      if (!toks.slice(k + 1).some(x => numGroup(x.t))) continue;
      const g = numGroup(toks[k - 1].t, true); if (pass === 0 && !g) continue; u = k; qg = g; break;
    }
    if (u < 0) return null;
    const cn = toks.slice(u + 1).map(x => numGroup(x.t)).filter(Boolean), cq = qg ? [qg] : [];
    const { desc, no } = descFrom(line.slice(0, toks[u].i)); if (!/[a-z]{3}/i.test(desc) || SKIP.test(desc)) return null;
    const s = solve(cq, cn); if (!s) return null;
    return { desc, descs: [desc], itemNo: no, qty: s.qty, unit: unitName(toks[u].t), price: s.price, amount: s.amount, ok: s.ok, cq, cn };
  }

  /* AG-style row: "<SI no> <DESC> <UNIT> <qty> <price> <disc> <amount> <vat%> <vat> <total>".
     Three numbers confirm each other (amount = qty × price, vat = 5% of amount, total = amount + vat), so a faint digit can be repaired
     instead of guessed. We look for the amount that the most other numbers on the line agree with. */
  const cleanTok = t => String(t).replace(/^[|!\[\](){}]+|[|!\[\](){}.,:;]+$/g, '');
  /* the printed line number at the start of a row ("31 | JALEPENO…", "[6 BABY CORN") — 0 when there is none */
  function siOf(left) { const f = String(left).trim().match(/^[\[|!(]*\s*([0-9OoIl]{1,2})(?=\s|\||\]|$)/); if (!f) return 0; const v = parseInt(rep(f[1]), 10); return v > 0 && v < 100 ? v : 0; }
  function parseVatRow(raw) {
    const line = raw.replace(/\s+$/, ''); if (line.trim().length < 14 || SKIP.test(line.trim())) return null;
    const toks = [...line.matchAll(/\S+/g)].map(m => ({ t: m[0], c: cleanTok(m[0]), i: m.index })).filter(x => x.c);
    if (toks.length < 6) return null;
    let u = -1; for (let k = 1; k < toks.length - 3; k++) if (TOKU.test(toks[k].c) && !/^\d/.test(toks[k].c) && toks.slice(k + 1).filter(x => numGroup(x.c)).length >= 3) { u = k; break; }
    if (u < 0) { const f = toks.findIndex((x, k) => k > 0 && /\d[.,]\d/.test(x.t) && numGroup(x.c)); if (f < 2) return null; u = f - 1; }   // unit unreadable → numbers start at the first decimal number
    const hasUnit = TOKU.test(toks[u].c);
    const nums = toks.slice(hasUnit ? u + 1 : u + 1).map((x, k) => ({ k, g: numGroup(x.c, k === 0) || numGroup(x.c) })).filter(x => x.g);
    if (nums.length < 3) return null;
    const left = line.slice(0, hasUnit ? toks[u].i : toks[u + 1].i), d = descFrom(left).desc;
    if (!/[a-z]{3}/i.test(d) || SKIP.test(d)) return null;
    const si = siOf(left);
    const vals = []; nums.forEach(n => n.g.forEach(a => vals.push({ k: n.k, v: a.v, c: a.c })));
    const has = (x, k0, ex) => vals.some(y => y.k !== ex && (k0 == null || y.k > k0) && Math.abs(y.v - x) <= .011);
    /* possible amounts: every number on the line, plus amounts worked out from the others (total ÷ 1.05, vat × 20, qty × price) —
       so an amount that is itself too faint to read can still be rebuilt from the numbers around it */
    const cand = new Map(), r2 = x => Math.round(x * 100) / 100, add = (v, k, c) => { if (!(v >= .05 && v < 1e6)) return; const key = Math.round(v * 100), o = cand.get(key); if (!o || (k != null && o.k == null) || c < o.c) cand.set(key, { v: r2(v), k: k != null ? k : (o ? o.k : null), c: Math.min(c, o ? o.c : 9) }); };
    vals.forEach(x => { add(x.v, x.k, x.c); add(x.v / 1.05, null, x.c + .6); add(x.v * 20, null, x.c + .8); });
    vals.forEach(p => vals.forEach(q => { if (q.k < p.k && q.v >= .05 && q.v <= 5000 && p.v >= .1) add(q.v * p.v, null, q.c + p.c + .5); }));
    let best = null;
    cand.forEach(a => {
      const vat = r2(a.v * .05 + 1e-9), tot = r2(a.v + vat), after = a.k;
      const sv = has(vat, after, a.k) ? 2 : 0, st = has(tot, after, a.k) ? 2 : 0;
      let qp = null;
      vals.forEach(p => { if ((after != null && p.k >= after) || p.v < .1) return; vals.forEach(q => {
        if (q.k >= p.k || q.v < .05 || q.v > 5000) return;
        if (Math.abs(q.v * p.v - a.v) <= .011 && (!qp || q.c + p.c < qp.cost || (q.c + p.c === qp.cost && q.k < qp.q.k))) qp = { q, p, cost: q.c + p.c };
      }); });
      const s = sv + st + (qp ? 3 : 0) + (a.k != null ? .4 : 0) - 1.5 * a.c - (qp ? qp.cost : 0) + (sv && st ? .5 : 0);
      if (!best || s > best.s + 1e-9 || (Math.abs(s - best.s) < 1e-9 && a.k != null && (best.a.k == null || a.k < best.a.k))) best = { s, a, qp, sv, st };
    });
    if (!best || best.s < 2 || !(best.sv || best.st)) return null;   // no vat / total agreeing → not this layout; leave the line to the other readers
    const a = best.a.v; let q, p, ok = best.s >= 4;
    if (best.qp) { q = best.qp.q.v; p = best.qp.p.v; }
    else {   // amount is confirmed by vat/total only → work qty or price out from the numbers before it
      const lim = best.a.k == null ? 99 : best.a.k, before = vals.filter(x => x.k < lim && x.v > 0 && x.v !== 5), first = before.find(x => x.k === 0);
      if (first && niceP(a / first.v)) { q = first.v; p = Math.round(a / q * 1000) / 1000; }
      else { const pr = before.filter(x => x.k > 0).find(x => niceQ(a / x.v)); if (pr) { p = pr.v; q = Math.round(a / p * 1000) / 1000; } else { q = first ? first.v : 1; p = Math.round(a / q * 100) / 100; ok = false; } }
    }
    return { desc: d, descs: [d], itemNo: '', si, qty: q, unit: hasUnit ? unitName(toks[u].c) : 'Kg', price: p, amount: a, ok, cq: [G(q)], cn: [G(p), G(a)], vat: true };
  }

  /* clean text (PDF text layer): "<no> <desc> <date> <qty> <unit> <price> <amount>"  or  "<desc> <unit> <qty> <price> <amount>" */
  const NUM = '\\d[\\d,]*\\.\\d{1,4}';
  const ROW = new RegExp(`^(.*?)\\s+(${NUM})\\s+(\\S+)\\s+(${NUM})\\s+(${NUM})\\s*$`);
  const UOMS = 'KG|KGS|PCS|PC|PKT|PK|PACK|BOX|CTN|CARTON|BUNCH|TRAY|LTR|L|BAG|EACH|DOZ|TIN|CASE|SET|TUB|BTL|BOTTLE|PUNNET|CRATE|JAR|CAN';
  const UNIT_FIRST = new RegExp(`^(.*?)\\s+(${UOMS})\\s+((?:\\d[\\d,]*(?:\\.\\d+)?\\s+){2,}\\d[\\d,]*(?:\\.\\d+)?)\\s*$`, 'i');
  const KNOWN = new RegExp(`^(${UOMS})$`, 'i');
  const num = s => parseFloat(String(s).replace(/,/g, ''));
  function parseClean(l) {
    const ag = l.match(UNIT_FIRST);
    if (ag) {
      const n = ag[3].trim().split(/\s+/).map(num), prod = n[0] * n[1], net = n.slice(2).find(v => v > 0 && Math.abs(v - prod) <= 0.02 + prod * 0.01), d = ag[1].trim();
      if (/[a-z]{3}/i.test(d) && n[0] > 0 && !SKIP.test(d)) { const desc = d.replace(/^\d+\s+/, ''), amount = net ?? Math.round(prod * 100) / 100;
        return { desc, descs: [desc], itemNo: '', qty: n[0], unit: ag[2], price: n[1], amount, ok: net != null, cq: [G(n[0])], cn: [G(n[1]), G(amount)] }; }
      return null;
    }
    const m = l.match(ROW); if (!m) return null;
    let d = m[1].replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/g, ' ').replace(/^\s*\d{1,3}\s+(?=\S*\d)/, '').trim(), no = '';
    const first = d.split(' ')[0];
    if (/\d/.test(first) && /[a-z]/i.test(d.slice(first.length))) { no = first; d = d.slice(first.length).trim(); }
    if (!/[a-z]{3}/i.test(d) || SKIP.test(d)) return null;
    const qty = num(m[2]), price = num(m[4]), amount = num(m[5]);
    return { desc: d, descs: [d], itemNo: /^\d{5,7}$/.test(no) ? no : '', qty, unit: m[3], price, amount, ok: Math.abs(qty * price - amount) <= tolA(amount), cq: [G(qty)], cn: [G(price), G(amount)] };
  }
  function parseLines(lines) {
    const res = []; let no = '', last = -1;
    lines.forEach((rawLine, li) => {
      const l = rawLine.replace(/\s+/g, ' ').trim();
      const n = l.match(/\b\d{3,4}-SO-\d+\b/i); if (n && !no) no = n[0];
      let r = parseClean(l);
      if (!r || !r.ok) { const v = parseVatRow(rawLine); if (v) r = v; }   // AG layout (amount / vat / total cross-check) first
      if (!r) { const t = parseTolerant(rawLine); if (t) r = t; } else if (!r.ok && !r.vat) { const t = parseTolerant(rawLine); if (t && t.ok) r = t; }
      if (r) { r.raw = rawLine.trim(); if (!r.si) r.si = siOf(rawLine); res.push(r); last = li; }
    });
    /* on an AG-style page, a line that is not in the row layout (no SI number, no vat columns) is a stray header / address line, not an item */
    const nv = res.filter(r => r.vat).length;
    if (nv >= 3 && nv >= res.length * .5) { for (let i = res.length - 1; i >= 0; i--) if (!res[i].vat && !res[i].ok) res.splice(i, 1); }
    const foot = []; lines.slice(last + 1).forEach(l => l.split(/\s+/).forEach(t => { const v = fixNum(t); if (v >= 50) foot.push(v); }));
    return { res, no, foot };
  }
  window._invParse = parseLines;   // exposed for testing

  /* ── merging several OCR passes of the same page, line by line ── */
  const tri = s => { s = ' ' + String(s).toLowerCase().replace(/[^a-z]/g, '') + ' '; const m = new Map(); for (let i = 0; i < s.length - 2; i++) m.set(s.substr(i, 3), (m.get(s.substr(i, 3)) || 0) + 1); return m; };
  const triSim = (a, b) => { const A = tri(a), B = tri(b); let i = 0, na = 0, nb = 0; A.forEach(v => na += v); B.forEach(v => nb += v); A.forEach((v, k) => i += Math.min(v, B.get(k) || 0)); return na + nb ? 2 * i / (na + nb) : 0; };
  const rowSim = (a, b) => (a.itemNo && a.itemNo === b.itemNo) ? 1 : (a.si && a.si === b.si && (triSim(a.desc, b.desc) > .3 || Math.abs(a.amount - b.amount) < .05)) ? 1 : (a.ok && b.ok && a.qty === b.qty && a.price === b.price && Math.abs(a.amount - b.amount) < .005) ? 1 : Math.min(1, triSim(a.desc, b.desc) + (Math.abs(a.amount - b.amount) < .05 ? .3 : 0));
  const uniq = a => [...new Set(a)];
  function mergeParsed(a, b) {
    const res = a.res.map(r => ({ ...r, descs: [...r.descs] })); let last = -1;
    b.res.forEach(r => {
      let k = -1, bs = 0; for (let i = last + 1; i < res.length; i++) { const s = rowSim(res[i], r); if (s > bs) { bs = s; k = i; } }
      if (bs >= .6) {
        last = k; const x = res[k]; if (!x.si && r.si) x.si = r.si; if (alphaSeg(r.desc) && (triSim(x.desc, r.desc) > .25 || !alphaSeg(x.desc))) x.descs = uniq([...x.descs, ...r.descs]); if (!alphaSeg(x.desc) && alphaSeg(r.desc)) { x.desc = r.desc; }
        if (!x.ok && r.ok && r.vat) Object.assign(x, { qty: r.qty, price: r.price, amount: r.amount, ok: true, cq: r.cq, cn: r.cn, unit: r.unit || x.unit });
        else if (!x.ok) { const cq = [...x.cq, ...r.cq], cn = [...x.cn, ...r.cn], m = solve(cq, cn, true);
          if (m && (m.ok || r.ok)) Object.assign(x, { qty: m.qty, price: m.price, amount: m.amount, ok: m.ok, cq, cn }); }
      } else if (r.ok) { res.splice(last + 1, 0, { ...r }); last++; }
    });
    return { res, no: a.no || b.no, foot: uniq([...a.foot, ...b.foot]) };
  }
  /* The invoice's own subtotal is the final judge: do our lines add up to a number printed on the invoice? */
  function reconcile(rs, foot) {
    const sum = rs.reduce((t, x) => t + (x.amount || 0), 0), hit = foot.find(f => Math.abs(f - sum) <= 0.06);
    if (hit != null) return { sum, hit, state: 'ok' };
    const bad = rs.filter(x => !x.ok);   // exactly one doubtful line + a subtotal that fits → solve it from the subtotal
    if (bad.length === 1) { const rest = sum - bad[0].amount; for (const f of foot) { const need = Math.round((f - rest) * 100) / 100;
      if (need > 0 && need < f && Math.abs(need - bad[0].amount) > .05) { const q = bad[0].qty, p = need / q;
        if (foot.some(g => Math.abs(g - (rest + need)) < .06) && (niceP(p) || niceQ(need / bad[0].price))) { const x = bad[0];
          if (niceQ(need / x.price)) x.qty = Math.round(need / x.price * 1000) / 1000; else x.price = Math.round(p * 100) / 100; x.amount = need; x.ok = true; return { sum: rest + need, hit: f, state: 'fixed' }; } } } }
    const near = foot.length ? foot.reduce((a, b) => Math.abs(b - sum) < Math.abs(a - sum) ? b : a) : null;
    return { sum, hit: near, state: foot.length ? 'diff' : 'none' };
  }

  /* Pages of one invoice can come in any order (AG prints "page 2 of 2" first). Put them in order of their printed line numbers. */
  function orderParts(parts) {
    const mn = p => { const v = p.res.map(r => r.si).filter(x => x > 0); return v.length ? Math.min(...v) : null; };
    const m = parts.map(mn); if (parts.length < 2 || m.some(x => x == null)) return parts;
    return parts.map((p, i) => [p, m[i], i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(x => x[0]);
  }
  /* The printed line numbers run 1,2,3…  A number the reader got wrong is replaced by "previous + 1"; a jump in the numbers means a line was not read. */
  function fixSeq(rows) {
    const withSi = rows.filter(r => r.si > 0).length, missing = [];
    if (rows.length < 4 || withSi < rows.length * .6) return missing;
    let prev = 0;
    rows.forEach(r => {
      if (r.si === 1 && prev > 3) prev = 0;   // a new invoice starts
      if (!(r.si > prev && r.si <= prev + 3)) r.si = prev + 1;
      for (let k = prev + 1; k < r.si; k++) missing.push(k);
      prev = r.si;
    });
    return missing;
  }

  /* ══════════════ ENGINE 2 — choosing our item ══════════════ */
  const STOP = new Set(['kg', 'pcs', 'pc', 'pkt', 'fresh', 'the', 'of', 'and', 'by', 'size', 'pp']);
  const SYN = { capsicum: 'pepper', courgette: 'zucchini', aubergine: 'eggplant', brinjal: 'eggplant', rocket: 'arugula', coriander: 'cilantro', shiso: 'shisho', romain: 'romaine', cos: 'romaine', rockmelon: 'melon', cantaloupe: 'melon' };
  const LETTUCE_KINDS = ['romaine', 'iceberg', 'lollo', 'oak', 'butter', 'rosso', 'frisee', 'curly', 'batavia', 'green', 'red', 'mix', 'baby', 'lamb', 'little', 'gem', 'rossa', 'bionda', 'mesclun'];
  const stem = t => /oes$/.test(t) ? t.slice(0, -2) : /ies$/.test(t) && t.length > 4 ? t.slice(0, -3) + 'y' : t.length > 3 ? t.replace(/s$/, '') : t;
  const tok = (s, inv) => {
    const set = new Set(String(s).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)).map(stem).map(t => SYN[t] || t));
    if (inv && set.has('lettuce') && !LETTUCE_KINDS.some(k => set.has(k))) set.add('romaine');   // plain "lettuce" means Lettuce Romaine in our list
    return set;
  };
  const invUom = u => { u = String(u || '').toLowerCase(); return /^kg|kilo/.test(u) ? 'Kg' : /^(pcs|piece|each|pc)/.test(u) ? 'Pc' : /^(pk|pack)/.test(u) ? 'Pkt' : /^(ltr|litre|liter|l$)/.test(u) ? 'Ltr' : /bunch/.test(u) ? 'Bunch' : /box/.test(u) ? 'Box' : /tray/.test(u) ? 'Tray' : /carton|case|ctn/.test(u) ? 'Carton' : u; };
  const ourBase = r => String(r.um || '').split(' (')[0];
  const uomOk = (r, u) => !r.um || invUom(u).toLowerCase() === ourBase(r).toLowerCase() || (invUom(u) === 'Carton' && /case/i.test(r.um));

  /* Spelling distance where look-alike letters OCR mixes up (i/l, c/e, n/m, u/v…) cost less */
  const PAIRS = new Set('il li lt tl ce ec nm mn nr rn uv vu uo ou oe eo hb bh hn nh ao oa gq qg gy yg fp pf ri nt tn ij ji ft tf'.split(' '));
  function wed(a, b) {
    const n = a.length, m = b.length; if (!n || !m) return Math.max(n, m);
    let prev = Array.from({ length: m + 1 }, (_, j) => j), cur = new Array(m + 1);
    for (let i = 1; i <= n; i++) { cur[0] = i; for (let j = 1; j <= m; j++) { const x = a[i - 1], y = b[j - 1]; cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x === y ? 0 : PAIRS.has(x + y) ? .45 : 1)); } [prev, cur] = [cur, prev]; }
    return prev[m];
  }
  const tokSim = (a, b) => { if (a === b) return 1; if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 3) return 0; const s = 1 - wed(a, b) / Math.max(a.length, b.length); return s >= .6 ? s : 0; };

  /* Index of our item words, built once per item list */
  let IDX = null;
  function index() {
    if (IDX && IDX.n === db.length && IDX.first === db[0]) return IDX;
    const vocab = new Map();
    db.forEach(r => { r._ta = [...tok(r.desc)]; r._ta.forEach(t => (vocab.get(t) || vocab.set(t, []).get(t)).push(r)); });
    return IDX = { n: db.length, first: db[0], vocab, keys: [...vocab.keys()], fz: new Map() };
  }
  function fuzzy(t) {   // every word in our list that looks like this (possibly misspelled) word
    const ix = index(); let o = ix.fz.get(t); if (o) return o; o = [];
    if (ix.vocab.has(t)) o.push([t, 1]);
    if (t.length >= 4) ix.keys.forEach(k => { if (k !== t) { const s = tokSim(t, k); if (s) o.push([k, s]); } });
    ix.fz.set(t, o); return o;
  }
  /* What the user taught us before: remembers every manual pick */
  const LKEY = 'ivLearn_v1';
  const lget = () => { try { return JSON.parse(localStorage.getItem(LKEY) || '{}'); } catch (e) { return {}; } };
  const lkey = d => 'd:' + [...tok(d)].sort().join(' ');
  function learn(x, id) {
    if (!id) return; try { const L = lget(); L[lkey(x.desc)] = id; if (x.itemNo) L['n:' + x.itemNo] = id; localStorage.setItem(LKEY, JSON.stringify(L)); } catch (e) { }
  }
  function learned(x) { const L = lget(), id = (x.itemNo && L['n:' + x.itemNo]) || L[lkey(x.desc)]; return id ? db.find(r => r.id === id) : null; }

  function candidates(desc, allow, price, unit) {
    const A = [...tok(desc, true)]; if (!A.length) return [];
    const ix = index(), cand = new Map();
    A.forEach((t, ai) => fuzzy(t).forEach(([k, s]) => ix.vocab.get(k).forEach(r => {
      if (allow && !allow(r)) return; let a = cand.get(r); if (!a) cand.set(r, a = new Array(A.length).fill(0)); if (s > a[ai]) a[ai] = s;
    })));
    const out = [];
    cand.forEach((a, r) => {
      const hit = a.filter(v => v > 0).length, M = a.reduce((x, y) => x + y, 0);
      const eff = A.filter((t, i) => a[i] > 0 || t.length >= 4).length || 1, B = r._ta.length;   // short unmatched junk ("pp", "tom") is ignored
      let s = 2 * M / (eff + B);
      if (hit >= eff) { s = Math.max(s, .6 + .3 * M / B); if (B === eff && M >= eff - .01) s += .15; }
      const c = parseFloat(r.cost);
      if (s > .2 && price && c) { const d = Math.abs(c - price) / price; s += d <= .03 ? .12 : d <= .1 ? .07 : d <= .25 ? .02 : d > .6 ? -.08 : 0; }
      if (s > .2 && unit && uomOk(r, unit)) s += .06;
      if (s > .2) out.push({ r, s });
    });
    return out.sort((a, b) => b.s - a.s).slice(0, 8);
  }
  function match() {
    const sup = $('invSup').value.trim().toLowerCase(), pre = $('invPre').value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const inPool = r => (!sup || (r.sup || '').toLowerCase().includes(sup)) && (!pre.length || pre.some(p => (r.id || '').toLowerCase().startsWith(p)));
    rows.forEach(x => {
      const best = (allow) => { let c = []; (x.descs || [x.desc]).forEach(d => candidates(d, allow, x.price, x.unit).forEach(k => { const e = c.find(z => z.r === k.r); if (!e) c.push(k); else if (k.s > e.s) e.s = k.s; })); return c.sort((a, b) => b.s - a.s).slice(0, 8); };
      let c = best(inPool); x.other = false;
      if (!c.length || c[0].s < 0.5) { const c2 = best(null); if (c2.length && (!c.length || c2[0].s > c[0].s)) { c = c2; x.other = true; } }
      const L = learned(x); if (L) c = [{ r: L, s: 3 }, ...c.filter(k => k.r !== L)].slice(0, 8);
      x.cands = c; x.pick = c.length ? 0 : -1;
    });
  }
  /* The unit we show is always OUR item's unit. The invoice unit is only kept when it is a real unit and the item has none. */
  const uomOf = x => { const c = x.pick >= 0 ? x.cands[x.pick].r : null; if (c && c.um) return c.um; return KNOWN.test(String(x.unit)) ? invUom(x.unit) : 'Kg'; };
  window._invEngine = { render: () => render(), parseLines, solve, mergeParsed, reconcile, candidates, setRows: r => { rows = r; }, match, tok, fixNum, qtyNum, wed };

  /* ══════════════ DOCUMENT ENHANCER ══════════════ */
  const loadImg = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Could not open image')); i.src = src; });
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  /* Tilt of a phone photo: rotate test angles and keep the one where text rows line up best */
  function deskewAngle(img) {
    const w = 480, h = Math.round(img.height * w / img.width), c = mk(w, h), g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data, gr = new Float32Array(w * h); let mean = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) { gr[p] = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114; mean += gr[p]; } mean /= gr.length;
    let dark = 0; for (let p = 0; p < gr.length; p++) if (gr[p] < mean * .78) dark++;
    const xs = [], ys = [], step = Math.max(1, Math.ceil(dark / 40000)); let seen = 0;
    for (let p = 0; p < gr.length; p++) if (gr[p] < mean * .78 && (seen++ % step === 0)) { xs.push(p % w); ys.push((p / w) | 0); }
    if (xs.length < 300) return 0;
    const sc = a => { const t = a * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t), bins = new Float32Array(h * 2 + w + 8), off = w * .5 + 4;
      for (let i = 0; i < xs.length; i++) bins[(xs[i] * sn + ys[i] * cs + off) | 0]++; let s = 0; for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i]; return s; };
    let best = 0, bs = sc(0); const s0 = bs;
    for (let a = -5; a <= 5; a += .5) { const s = sc(a); if (s > bs) { bs = s; best = a; } }
    for (let a = best - .5; a <= best + .5; a += .1) { const s = sc(a); if (s > bs) { bs = s; best = a; } }
    return (Math.abs(best) >= .3 && bs > s0 * 1.03) ? best : 0;
  }
  /* Straighten → enlarge → flatten shadows / uneven light → stretch contrast → darken faint ink. Returns 3 versions for the reader. */
  async function enhanceVariants(src) {
    const img = typeof src === 'string' ? await loadImg(src) : src, k = img.width < 2200 ? Math.min(3, 2600 / img.width) : img.width > 3400 ? 3000 / img.width : 1;
    const W = Math.round(img.width * k), H = Math.round(img.height * k), ang = deskewAngle(img);
    const c = mk(W, H), g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.imageSmoothingQuality = 'high';
    if (ang) { g.translate(W / 2, H / 2); g.rotate(ang * Math.PI / 180); g.drawImage(img, -W / 2, -H / 2, W, H); g.setTransform(1, 0, 0, 1, 0, 0); } else g.drawImage(img, 0, 0, W, H);
    const plain = mk(W, H); plain.getContext('2d').drawImage(c, 0, 0);
    const bg = mk(Math.max(8, W >> 4), Math.max(8, H >> 4)), bgc = bg.getContext('2d', { willReadFrequently: true }); bgc.imageSmoothingQuality = 'high'; bgc.drawImage(c, 0, 0, bg.width, bg.height);
    const big = mk(W, H), bigc = big.getContext('2d', { willReadFrequently: true }); bigc.imageSmoothingQuality = 'high'; bigc.filter = 'blur(6px)'; bigc.drawImage(bg, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H), b = bigc.getImageData(0, 0, W, H).data, px = d.data, flat = new Uint8Array(W * H), hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      const y = px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114, back = Math.max(60, b[i] * .299 + b[i + 1] * .587 + b[i + 2] * .114), v = Math.min(255, y / back * 235) | 0; flat[p] = v; hist[v]++;
    }
    const tot = W * H; let lo = 0, hi = 255, acc = 0;
    while (lo < 254 && (acc += hist[lo]) < tot * .005) lo++; acc = 0; while (hi > lo + 1 && (acc += hist[hi]) < tot * .35) hi--;
    const lut = new Uint8Array(256); for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(Math.max(0, Math.min(1, (v - lo) / (hi - lo))), 1.7);
    const sh = new Uint32Array(256); for (let p = 0; p < flat.length; p++) { flat[p] = lut[flat[p]]; sh[flat[p]]++; }
    /* Otsu threshold for the black-and-white version, nudged up so thin faint strokes survive */
    let sumAll = 0; for (let v = 0; v < 256; v++) sumAll += v * sh[v]; let wB = 0, sB = 0, mx = 0, th = 128;
    for (let v = 0; v < 256; v++) { wB += sh[v]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += v * sh[v]; const mB = sB / wB, mF = (sumAll - sB) / wF, bt = wB * wF * (mB - mF) * (mB - mF); if (bt > mx) { mx = bt; th = v; } }
    th = Math.min(235, th * 1.12);
    const soft = mk(W, H), sg = soft.getContext('2d'), sd = sg.createImageData(W, H), bin = mk(W, H), bgx = bin.getContext('2d'), bd = bgx.createImageData(W, H);
    for (let p = 0, i = 0; p < flat.length; p++, i += 4) { const v = flat[p], t = v < th ? 0 : 255; sd.data[i] = sd.data[i + 1] = sd.data[i + 2] = v; sd.data[i + 3] = 255; bd.data[i] = bd.data[i + 1] = bd.data[i + 2] = t; bd.data[i + 3] = 255; }
    sg.putImageData(sd, 0, 0); bgx.putImageData(bd, 0, 0);
    return { soft, bin, plain, angle: ang };
  }
  async function pdfToImages(buf, width) {
    await load(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise, imgs = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p), v1 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: Math.min(5, (width || 3300) / v1.width) }), c = mk(vp.width, vp.height), g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); await pg.render({ canvasContext: g, viewport: vp }).promise; imgs.push(c);
    }
    return imgs;
  }
  async function pdfLines(buf) {
    await load(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise, out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const items = (await (await pdf.getPage(p)).getTextContent()).items.filter(i => i.str.trim()), byY = new Map();
      items.forEach(i => { const y = Math.round(i.transform[5] / 4); (byY.get(y) || byY.set(y, []).get(y)).push(i); });
      [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) => out.push(r.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str.trim()).join(' ')));
    }
    return out;
  }

  /* ══════════════ READERS ══════════════ */
  let worker = null;
  /* one OCR pass: text lines (wide gaps kept) + line boxes (used only to find where the table is) */
  async function ocrFull(canvas, psm) {
    if (!worker) { worker = await Tesseract.createWorker('eng'); }
    await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const { data } = await worker.recognize(canvas);
    return { lines: data.text.split('\n'), boxes: (data.lines || []).map(l => ({ text: String(l.text || ''), y0: l.bbox ? l.bbox.y0 : null, y1: l.bbox ? l.bbox.y1 : null })) };
  }
  const ocrOnce = async (canvas, psm) => (await ocrFull(canvas, psm)).lines;
  const cropTo = (c, x0, y0, x1, y1) => { const o = mk(Math.max(1, x1 - x0), Math.max(1, y1 - y0)); o.getContext('2d').drawImage(c, x0, y0, x1 - x0, y1 - y0, 0, 0, o.width, o.height); return o; };
  /* Where is the table? Rows are the lines that have a unit (Kg/Pcs…) and 3+ numbers. Take the biggest evenly-spaced block of them
     and cut the page there, so the logo, Arabic header, CO₂ box and address never reach the reader. */
  function locateTable(boxes, H) {
    const ys = boxes.filter(b => b.y0 != null && (() => { const t = b.text.trim().split(/\s+/); return t.some(x => TOKU.test(x)) && t.filter(x => /\d/.test(x)).length >= 3; })()).map(b => [b.y0, b.y1]).sort((a, b) => a[0] - b[0]);
    if (ys.length < 3) return null;
    const gaps = ys.slice(1).map((y, i) => y[0] - ys[i][0]).sort((a, b) => a - b), g = gaps[gaps.length >> 1] || 40;
    let runs = [[ys[0]]]; for (let i = 1; i < ys.length; i++) { if (ys[i][0] - ys[i - 1][0] <= g * 4) runs[runs.length - 1].push(ys[i]); else runs.push([ys[i]]); }
    const run = runs.sort((a, b) => b.length - a.length)[0]; if (run.length < 3) return null;
    return { y0: Math.max(0, Math.round(run[0][0] - g * 2)), y1: Math.min(H, Math.round(run[run.length - 1][1] + g * 4)), rows: run.length };
  }
  /* Find the table, cut the page down to it, then several passes on differently cleaned copies; each pass fills the gaps / repairs the numbers of the others. */
  async function ocrPage(v, label) {
    status(label + ': finding the table…');
    /* The first pass reads the page as scanned (just straightened + enlarged): on thin, faint print the heavy clean-up versions can erase
       digits, so they come after, as extra opinions that fill the gaps of the first. */
    const first = await ocrFull(v.plain, 6), base = parseLines(first.lines), T = locateTable(first.boxes, v.plain.height);
    let work = v, best = null, from = 0;
    if (T) { const W = v.plain.width, cut = c => cropTo(c, Math.round(W * .03), T.y0, Math.round(W * .995), T.y1); work = { soft: cut(v.soft), bin: cut(v.bin), plain: cut(v.plain) }; status(`${label}: table found (${T.rows}+ rows) — reading it closely…`); }
    else { best = base; from = 1; }
    const plan = [['plain', 6], ['soft', 6], ['bin', 6], ['plain', 4], ['soft', 4]];
    const good = b => {   // every line adds up, the line numbers have no gaps, and (if the page prints one) the total matches
      if (!b || !b.res.length || !b.res.every(r => r.ok)) return false;
      const si = b.res.map(r => r.si).filter(x => x > 0); if (si.length > 2 && si.some((x, i) => i && x - si[i - 1] > 1)) return false;
      const foot = uniq([...b.foot, ...base.foot]), sum = b.res.reduce((t, r) => t + (r.amount || 0), 0);
      return !foot.length || foot.some(f => Math.abs(f - sum) <= .06) || !foot.some(f => f > sum * .8 && f < sum * 1.3);
    };
    for (let n = from; n < plan.length; n++) {
      status(`${label}: reading pass ${n + 1} of ${plan.length}${best ? ' — ' + best.res.length + ' lines so far' : ''}…`);
      const p = parseLines(await ocrOnce(work[plan[n][0]], plan[n][1])); best = best ? mergeParsed(best, p) : p;
      if (good(best) && (best.res.length >= 4 || n >= 1)) break;
    }
    return T ? mergeParsed(best, base) : best;   // the full-page pass adds the totals printed under the table + any row the crop missed
  }
  /* "AI eyes": Google Gemini reads the picture directly (free key from aistudio.google.com). Result is still checked by qty × price = amount. */
  const AIK = 'ivGeminiKey', AIM = 'ivGeminiModel';
  const aiKey = () => { try { return localStorage.getItem(AIK) || ''; } catch (e) { return ''; } };
  const aiModel = () => { try { return localStorage.getItem(AIM) || 'gemini-2.5-flash'; } catch (e) { return 'gemini-2.5-flash'; } };
  const AI_NUM = { type: 'NUMBER', nullable: true };
  const AI_SCHEMA = { type: 'OBJECT', properties: { invoice_no: { type: 'STRING', nullable: true }, subtotal: AI_NUM, lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { item_no: { type: 'STRING', nullable: true }, description: { type: 'STRING' }, qty: AI_NUM, unit: { type: 'STRING', nullable: true }, price: AI_NUM, amount: AI_NUM }, required: ['description'] } } }, required: ['lines'] };
  const aiPrompt = (k, n) => 'This image is part ' + k + ' of ' + n + ' of a supplier invoice page for fresh fruit and vegetables (may be a faint photocopy). The parts overlap a little, so a line can appear twice - that is fine. ' +
    'Typical layouts: Barakat = Item number, Description, Ship date, Quantity, Unit, Sales price, Discount, Discount percent, Amount, Print code (5%); AG = SI no, Description, Unit, Qty, Price, Disc, Amount, VAT%, VAT, Total. The rows are small and faint: look at each digit carefully, and remember qty x price = amount. ' +
    'Return every product line you can see, in order, and nothing else (ignore logos, addresses, headings, footers, phone numbers). For each: item_no (supplier item number, string), description (product name only), qty (number), unit (Kg, Pcs, Box…), price (unit price), amount (line total before VAT). ' +
    'Some lines may be partly covered by a printed banner: still return the line, and use null for any number you cannot actually read - never guess a number. ' +
    'Also return invoice_no (e.g. 1101-SO-002844463) if visible, and subtotal = the "Sales subtotal"/"Net amount" before VAT only if this part shows it, otherwise null. Read numbers exactly; do not invent lines.';
  async function aiCall(canvas, k, n) {
    const key = aiKey(), model = aiModel(), b64 = canvas.toDataURL('image/jpeg', .9).split(',')[1];
    const body = { contents: [{ parts: [{ text: aiPrompt(k, n) }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: AI_SCHEMA } };
    for (let t = 0; ; t++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if ((r.status === 429 || r.status === 503) && t < 2) { await new Promise(z => setTimeout(z, 4000 * (t + 1))); continue; }
      if (!r.ok) throw new Error('AI reader: ' + (await r.text()).slice(0, 160));
      return JSON.parse(((await r.json()).candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '{}');
    }
  }
  function aiRows(j) {
    return (j.lines || []).map(l => {
      const itemNo = String(l.item_no || '').replace(/\D/g, ''), d = String(l.description || '').trim() || (itemNo ? 'Item ' + itemNo : ''); if (!/[a-z]{3}/i.test(d)) return null;
      const cq = [+l.qty].filter(v => v > 0).map(G), cn = [+l.price, +l.amount].filter(v => v > 0).map(G); if (!cq.length && !cn.length) return null;
      const s = solve(cq, cn) || { qty: +l.qty || 1, price: +l.price || 0, amount: +l.amount || 0, ok: false };
      return { desc: d, descs: [d], itemNo, qty: s.qty, unit: unitName(l.unit || 'kg'), price: s.price, amount: s.amount, ok: s.ok, cq, cn, raw: '(AI) ' + d, ai: true };
    }).filter(Boolean);
  }
  /* The page goes to the AI in 2–3 overlapping slices at full resolution (one small picture of the whole page loses thin ink). */
  async function aiReadTiles(canvas, label) {
    if (!aiKey()) return null;
    const W = canvas.width, H = canvas.height, ratio = H / W, n = ratio > 1.2 ? 3 : ratio > .8 ? 2 : 1, step = Math.ceil(H / n), ov = Math.round(H * .06);
    const res = [], foot = []; let no = '';
    for (let k = 0; k < n; k++) {
      status(`${label}: AI reader is looking at part ${k + 1} of ${n}…`);
      const y0 = Math.max(0, k * step - (k ? ov : 0)), y1 = Math.min(H, (k + 1) * step + (k < n - 1 ? ov : 0));
      const j = await aiCall(n === 1 ? canvas : cropTo(canvas, 0, y0, W, y1), k + 1, n);
      const key = r => (r.itemNo || r.desc.toLowerCase()) + '|' + r.amount, tail = res.slice(-10).map(key);
      aiRows(j).forEach(r => { const i = tail.indexOf(key(r)); if (i >= 0) tail[i] = null; else res.push(r); });   // a line seen in two overlapping slices is kept once
      if (!no && j.invoice_no) no = String(j.invoice_no); if (j.subtotal > 0) foot.push(+j.subtotal);
    }
    return { res, no, foot };
  }
  /* AI first; the built-in OCR only runs when the AI result does not add up (or there is no key). */
  async function readPage(src, label) {
    const v = await enhanceVariants(src); let ai = null;
    if (aiKey()) { try { ai = await aiReadTiles(v.soft, label); } catch (e) { console.warn(e); status(String(e.message).slice(0, 120)); } }
    if (ai && ai.res.length) {
      const sum = ai.res.reduce((t, x) => t + (x.amount || 0), 0), sure = ai.res.every(r => r.ok) && (!ai.foot.length || ai.foot.some(f => Math.abs(f - sum) <= .06));
      if (sure) return ai;
    }
    await load(TESS); const ocr = await ocrPage(v, label);
    return ai && ai.res.length ? mergeParsed(ai, ocr) : ocr;   // AI lines first (best names), OCR repairs / adds
  }
  const status = t => { const s = $('invStatus'); if (s) s.textContent = t; };
  window._invEnh = enhanceVariants;   // exposed for testing
  window._invT = { orderParts, fixSeq, parseVatRow, locateTable, aiRows, aiReadTiles, mergeParsed, reconcile, parseLines };

  /* ══════════════ UI ══════════════ */
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
.iv-scroll{flex:1;overflow:auto;padding:20px 24px calc(96px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain}
.iv-wrap{max-width:1180px;margin:0 auto}
.iv-drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 16px;border:1.5px dashed var(--glass-edge);border-radius:20px;background:var(--iv-soft);cursor:pointer;text-align:center}
.iv-drop.on{border-color:var(--brand)}.iv-drop small{color:var(--iv-muted);font-size:12px;word-break:break-all}
.iv-ctl{display:flex;gap:12px;margin:16px 0 8px;flex-wrap:wrap}
.iv-ctl select{flex:1;min-width:220px;padding:13px 14px;border-radius:14px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:600 14px inherit}
.iv-go,.iv-sec{padding:13px 24px;border:none;border-radius:14px;font:800 15px inherit;cursor:pointer}
.iv-go{background:var(--brand);color:#fff}.iv-sec{background:var(--iv-soft);color:var(--text)}.iv-go[disabled]{opacity:.6}
.iv-paste summary,.iv-enh summary,.iv-ai summary,.iv-raw summary{cursor:pointer;font-size:12px;color:var(--iv-muted);margin:6px 0}
.iv-paste textarea,.iv-ai input{width:100%;border-radius:14px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);padding:12px;font:500 13px inherit;margin-top:6px}
.iv-ai p{font-size:12px;color:var(--iv-muted);margin:6px 0}.iv-ai a{color:var(--brand)}
.iv-enh .iv-pv{display:flex;gap:12px;flex-wrap:wrap}.iv-enh canvas{max-width:100%;width:calc(50% - 6px);border-radius:12px;border:1px solid var(--glass-edge)}
.iv-st{font-size:13px;color:var(--iv-muted);margin:8px 2px 14px;min-height:18px}
.iv-sum{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.iv-chip{padding:7px 14px;border-radius:50px;background:var(--iv-soft);font-size:12px;font-weight:700}.iv-chip.a{color:var(--iv-warn)}.iv-chip.g{color:var(--iv-ok)}
.iv-bar{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:center;gap:10px;padding:12px 24px calc(12px + env(safe-area-inset-bottom,0px));background:var(--bg-color);border-top:1px solid var(--glass-edge)}
.iv-bar button{flex:1;max-width:260px;padding:14px;border-radius:14px;border:none;font:800 14px inherit;cursor:pointer;background:var(--iv-soft);color:var(--text)}
.iv-bar button.p{background:var(--brand);color:#fff}
.iv-ph{width:52px;height:52px;border-radius:12px;object-fit:cover;background:var(--iv-soft);cursor:zoom-in;flex:none;display:flex;align-items:center;justify-content:center;font-size:20px}
.iv-code{font:800 14px ui-monospace,monospace;color:var(--brand);cursor:pointer;white-space:nowrap}.iv-code.none{color:#dc2626}
.iv-uom{display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:20px;background:rgba(16,185,129,.12);color:var(--iv-ok)}
.iv-q,.iv-pick select,.iv-pick input{width:100%;margin-top:6px;padding:9px 12px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:600 13px inherit}
.iv-nums{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px}.iv-nums label{font-size:10px;font-weight:700;color:var(--iv-muted)}.iv-nums input{margin-top:2px}
.iv-pick{display:none}.edit>.iv-pick,.edit .iv-pick{display:block}
.iv-chg{display:inline-block;margin-top:6px;font-size:12px;color:var(--iv-muted);text-decoration:underline;cursor:pointer}
.warn{box-shadow:inset 3px 0 0 var(--iv-warn)}.warn .amt{color:var(--iv-warn)}
/* desktop: table */
.iv-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
.iv-tbl th{text-align:left;font-size:11px;font-weight:700;color:var(--iv-muted);padding:10px 12px;border-bottom:1px solid var(--glass-edge);position:sticky;top:-20px;background:var(--bg-color);z-index:2}
.iv-tbl td{padding:12px;border-bottom:1px solid var(--glass-edge);vertical-align:middle}
.iv-tbl tr:hover td{background:var(--iv-soft)}.iv-tbl .r{text-align:right;font-variant-numeric:tabular-nums}
.iv-tbl .it{display:flex;gap:12px;align-items:flex-start;min-width:340px}.iv-tbl .it>div{flex:1;min-width:0}
.iv-tbl .nm{font-weight:700;margin-bottom:2px}.iv-sub{font-size:12px;color:var(--iv-muted)}
/* phone: cards */
.iv-cards{display:none}
.iv-card{background:var(--card-bg,#0d1829);border:1px solid var(--glass-edge);border-radius:18px;padding:14px;margin-bottom:12px}
.iv-c1{display:flex;gap:12px;align-items:flex-start}.iv-c1 .iv-ph{width:64px;height:64px;border-radius:14px}
.iv-c1>div{flex:1;min-width:0}.iv-card .nm{font-weight:700;font-size:15px;line-height:1.3;cursor:pointer}
.iv-c2{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px}
.iv-c2 .iv-code{font-size:16px;background:rgba(16,185,129,.12);padding:6px 12px;border-radius:12px}
.iv-cost{font-weight:800;font-size:18px;cursor:pointer}.iv-card .iv-sub{margin-top:8px}
.iv-raw pre{white-space:pre-wrap;font:11px ui-monospace,monospace;color:var(--iv-muted);margin:6px 0}
@media(max-width:899px){.iv-tblwrap{display:none}.iv-cards{display:block}.iv-scroll{padding:16px 14px calc(96px + env(safe-area-inset-bottom,0px))}.iv-go,.iv-sec{flex:1}.iv-enh canvas{width:100%}}`;
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
  <details class="iv-enh" id="invEnh"><summary>Enhanced document (what the reader sees)</summary><div id="invEnhOut" class="iv-pv"></div></details>
  <details class="iv-ai" ${aiKey() ? '' : 'open'}><summary>🤖 AI reader (free, recommended) — reads faint scans and photocopies</summary>
    <p>Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>, paste it here. It stays only in this browser. The invoice picture is sent to Google when it is on. It reads first; the built-in reader only steps in when the numbers do not add up. Leave empty to use the built-in reader only.</p>
    <input id="invAiKey" type="password" placeholder="Gemini API key (optional)" autocomplete="off"></details>
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
    $('invAiKey').value = aiKey(); $('invAiKey').onchange = () => { try { localStorage.setItem(AIK, $('invAiKey').value.trim()); } catch (e) { } status($('invAiKey').value.trim() ? 'AI reader is ON.' : 'AI reader is off.'); };
    $('invPreset').onchange = () => { const P = { barakat: ['Barakat', 'BkVg,BkFr'], ag: ['AG Veg', 'VgCh,FrCh'], any: ['', ''] }[$('invPreset').value]; $('invSup').value = P[0]; $('invPre').value = P[1]; if (rows.length) { match(); render(); } };
    $('invBody').addEventListener('click', e => {
      if (e.target.closest('select,input')) return;
      const ph = e.target.closest('.iv-ph[data-full]'); if (ph) { if (typeof openLightbox === 'function') openLightbox(ph.dataset.full, ph.dataset.label || '', ph.dataset.code || ''); return; }
      const del = e.target.closest('.iv-del'); if (del) { const i = +del.closest('[data-i]').dataset.i; rows.splice(i, 1); recon = recon && { ...recon }; render(); status('Line removed.'); return; }
      const chg = e.target.closest('.iv-chg'); if (chg) { chg.closest('.iv-card,tr').classList.toggle('edit'); return; }
      const el = e.target.closest('[data-copy]'); if (!el) return;
      const t = el.innerText.trim().replace(/\s*\/\s*\w+$/, ''); if (!t) return;
      navigator.clipboard.writeText(t).then(() => status('Copied: ' + t));
    });
    $('invRun').onclick = run; $('invXls').onclick = exportXls; $('invCopy').onclick = copyTable; $('invEnhBtn').onclick = previewEnhance;
  }
  window.openInvoiceScanner = function () { build(); $('invModal').classList.add('open'); if (!db.length) status('Load the item list first.'); };
  document.addEventListener('DOMContentLoaded', build);

  async function previewEnhance() {
    const f = [...$('invFile').files][0]; if (!f) return status('Choose a photo or scanned PDF first.');
    try {
      status('Enhancing…'); let src;
      if (/\.pdf$/i.test(f.name)) src = (await pdfToImages(await f.arrayBuffer(), 1800))[0]; else src = URL.createObjectURL(f);
      const v = await enhanceVariants(src), o = $('invEnhOut'); o.innerHTML = ''; o.appendChild(v.soft); o.appendChild(v.bin); $('invEnh').open = true;
      status('Enhanced' + (v.angle ? ` (straightened ${v.angle.toFixed(1)}°)` : '') + ' — left: soft version, right: black & white. The reader uses both.');
    } catch (e) { status('Error: ' + e.message); }
  }

  async function run() {
    if (!db.length) return status('Load the item list first.');
    const btn = $('invRun'); btn.disabled = true;
    try {
      const files = [...$('invFile').files], pasted = $('invPaste').value.trim(); let parts = [];
      if (pasted) parts.push(parseLines(pasted.split('\n')));
      else if (!files.length) return status('Choose a PDF or image first (you can pick several photos).');
      else for (const f of files) {
        status('Reading ' + f.name + '…'); const mine = [];
        if (/\.pdf$/i.test(f.name)) {
          const buf = await f.arrayBuffer(), p = parseLines(await pdfLines(buf.slice(0)));
          if (p.res.length) mine.push(p);
          else { const pages = await pdfToImages(buf); for (let i = 0; i < pages.length; i++) mine.push(await readPage(pages[i], `${f.name} p${i + 1}`)); }
        } else { mine.push(await readPage(URL.createObjectURL(f), f.name)); }
        parts.push(...orderParts(mine));
      }
      if (worker) { worker.terminate(); worker = null; }
      rows = parts.flatMap(p => p.res); missingNo = fixSeq(rows); invNo = (parts.find(p => p.no) || {}).no || '';
      if (!rows.length) return status('Could not find item lines. Try the ✨ Enhance preview, a sharper photo, the AI reader, or paste the invoice text.');
      recon = reconcile(rows, parts.flatMap(p => p.foot)); window._invRaw = parts.flatMap(p => p.res.map(r => r.raw));
      match(); render(); status(`${rows.length} lines found${invNo ? ' — ' + invNo : ''}${missingNo.length ? ' — line ' + missingNo.join(', ') + ' not read' : ''}`);
    } catch (e) { console.error(e); status('Error: ' + e.message); }
    finally { btn.disabled = false; }
  }

  const fmt = v => (v === '' || v == null || isNaN(v)) ? '' : (Math.round(v * 1000) / 1000).toString();
  const money = v => isNaN(v) ? '' : (+v).toFixed(2);
  const bad = x => !(Math.abs(x.qty * x.price - x.amount) <= tolA(x.amount));
  const picker = i => `<div class="iv-pick"><select data-i="${i}"></select><input class="iv-q" data-i="${i}" placeholder="Search all items…">
<div class="iv-nums"><label>Qty<input type="number" step="any" data-k="qty" data-i="${i}"></label><label>Cost<input type="number" step="any" data-k="price" data-i="${i}"></label><label>Amount<input type="number" step="any" data-k="amount" data-i="${i}"></label></div></div>`;
  function render() {
    $('invBody').innerHTML = `<div class="iv-sum" id="invSum"></div>
<div class="iv-cards">${rows.map((x, i) => `<div class="iv-card" data-i="${i}">
  <div class="iv-c1"><span class="iv-ph" data-f="ph" data-i="${i}"></span><div><div class="nm" data-f="desc" data-i="${i}" data-copy="1"></div><div class="iv-sub">Invoice: ${esc(x.desc)}</div></div></div>
  <div class="iv-c2"><span class="iv-code" data-f="code" data-i="${i}" data-copy="1"></span><span class="iv-uom" data-f="uom" data-i="${i}"></span><span class="iv-cost" data-f="price" data-i="${i}" data-copy="1"></span></div>
  <div class="iv-sub"><span data-f="qty" data-i="${i}"></span> qty · amount <span class="amt" data-f="amount" data-i="${i}"></span></div>
  <span class="iv-chg">Change item / edit</span> <span class="iv-chg iv-del">Remove line</span>${picker(i)}</div>`).join('')}</div>
<div class="iv-tblwrap"><table class="iv-tbl"><thead><tr><th>#</th><th>Our item</th><th>Code</th><th>Invoice item</th><th class="r">Qty</th><th>UOM</th><th class="r">Cost</th><th class="r">Amount</th></tr></thead><tbody>${rows.map((x, i) => `<tr data-i="${i}"><td>${i + 1}</td>
<td><div class="it"><span class="iv-ph" data-f="ph" data-i="${i}"></span><div><div class="nm" data-f="desc" data-i="${i}" data-copy="1"></div><span class="iv-chg">Change / edit</span> <span class="iv-chg iv-del">Remove</span>${picker(i)}</div></div></td>
<td><span class="iv-code" data-f="code" data-i="${i}" data-copy="1"></span></td><td>${esc(x.desc)}</td><td class="r" data-f="qty" data-i="${i}"></td><td><span class="iv-uom" data-f="uom" data-i="${i}"></span></td><td class="r" data-f="price" data-i="${i}" data-copy="1"></td><td class="r amt" data-f="amount" data-i="${i}"></td></tr>`).join('')}</tbody></table></div>
<p class="iv-sub"><button class="iv-sec" id="invAdd" style="padding:9px 16px;font-size:13px">+ Add line</button> Tap a code, item or cost to copy it. Tap a photo to enlarge. A line that is not on the invoice? Press Remove.</p>
<details class="iv-raw"><summary>What the reader saw (for checking)</summary><pre>${esc((window._invRaw || []).join('\n'))}</pre></details>`;
    $('invBody').querySelectorAll('select').forEach(sel => sel.onchange = () => { const i = +sel.dataset.i; rows[i].pick = +sel.value; if (rows[i].pick >= 0) learn(rows[i], rows[i].cands[rows[i].pick].r.id); sys(i); sumUp(); });
    $('invAdd').onclick = () => { rows.push({ desc: '', descs: [''], itemNo: '', qty: 1, unit: 'Kg', price: 0, amount: 0, ok: false, cq: [], cn: [], raw: '(added by hand)', cands: [], pick: -1, edit: true }); render(); const t = $('invBody').querySelectorAll('tr[data-i],.iv-card[data-i]'); t.forEach(el => { if (+el.dataset.i === rows.length - 1) el.classList.add('edit'); }); status('Line added at the bottom — search the item, then set qty and cost.'); };
    $('invBody').querySelectorAll('.iv-q').forEach(q => q.oninput = () => search(+q.dataset.i, q.value));
    $('invBody').querySelectorAll('.iv-nums input').forEach(n => n.onchange = () => { const i = +n.dataset.i, v = parseFloat(n.value); if (isNaN(v)) return; rows[i][n.dataset.k] = v;
      const x = rows[i]; if (n.dataset.k !== 'amount') x.amount = Math.round(x.qty * x.price * 100) / 100; sys(i); sumUp(); });
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
    rows[i].cands = hit.map(r => ({ r, s: 1 })); rows[i].pick = 0; learn(rows[i], hit[0].id); opts(i); sys(i); sumUp();
  }
  function sumUp() {
    const nm = rows.filter(x => x.pick < 0).length, sum = rows.reduce((a, x) => a + (x.amount || 0), 0); let rc = '';
    if (recon) { const hit = recon.hit != null && Math.abs(recon.hit - sum) <= .06;
      rc = hit ? `<span class="iv-chip g">✓ Total matches invoice ${recon.hit.toFixed(2)}</span>` : recon.state === 'diff' || recon.state === 'fixed' ? `<span class="iv-chip a">Invoice shows ${recon.hit.toFixed(2)} — check amber lines</span>` : ''; }
    $('invSum').innerHTML = `<span class="iv-chip">${rows.length} lines</span>${missingNo.length ? `<span class="iv-chip a">Invoice line ${missingNo.join(', ')} not read — use + Add line</span>` : ''}${rows.some(bad) ? `<span class="iv-chip a">${rows.filter(bad).length} doubtful (amber)${aiKey() ? '' : ' — AI reader would fix these'}</span>` : ''}${nm ? `<span class="iv-chip a">${nm} no match</span>` : ''}<span class="iv-chip">Total ${sum.toFixed(2)}</span>${rc}`;
  }
  function sys(i) {
    const x = rows[i], c = x.pick >= 0 ? x.cands[x.pick].r : null, B = $('invBody');
    const set = (f, html, cls) => B.querySelectorAll(`[data-f="${f}"][data-i="${i}"]`).forEach(el => { el.innerHTML = html; if (cls !== undefined) el.classList.toggle('none', cls); });
    set('code', c ? esc(c.id) : 'No match', !c); set('desc', c ? esc(c.desc) : '— pick an item —'); set('uom', esc(uomOf(x)));
    set('qty', fmt(x.qty)); set('price', money(x.price)); set('amount', money(x.amount));
    B.querySelectorAll(`.iv-card[data-i="${i}"],tr[data-i="${i}"]`).forEach(el => el.classList.toggle('warn', bad(x)));
    B.querySelectorAll(`.iv-nums input[data-i="${i}"]`).forEach(n => { if (document.activeElement !== n) n.value = x[n.dataset.k]; });
    const url = c ? photoOf(c.id) : '';
    B.querySelectorAll(`[data-f="ph"][data-i="${i}"]`).forEach(el => {
      if (url) { el.outerHTML = `<img class="iv-ph" data-f="ph" data-i="${i}" src="${esc(url)}" data-full="${esc(url)}" data-label="${esc(c.desc)}" data-code="${esc(c.id)}" loading="lazy" alt="">`; }
      else { el.className = 'iv-ph'; el.removeAttribute('data-full'); el.textContent = '📦'; }
    });
  }
  const out = () => rows.map((x, i) => { const c = x.pick >= 0 ? x.cands[x.pick].r : null;
    return { '#': i + 1, 'Invoice No': invNo, 'Our Code': c ? c.id : '', 'Our Item': c ? c.desc : '(NO MATCH)', 'Invoice Item': x.desc, Qty: x.qty, UOM: uomOf(x), 'Invoice Cost': x.price, 'System Cost': c ? c.cost : '', Amount: x.amount }; });
  function exportXls() { if (!rows.length) return; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out()), 'Invoice'); XLSX.writeFile(wb, `invoice-${invNo || 'matched'}.xlsx`); }
  function copyTable() { if (!rows.length) return; const o = out(); navigator.clipboard.writeText([Object.keys(o[0]).join('\t'), ...o.map(r => Object.values(r).join('\t'))].join('\n')).then(() => status('Copied — paste into Excel')); }
})();
