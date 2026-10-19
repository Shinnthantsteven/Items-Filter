/* Invoice Scanner v13 (+ invoice-engine.js: number checks, totals, step-2 'check the numbers') — upload a supplier invoice (PDF / photo), read it line by line, match each line to our item codes.
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
  /* wide rows (Barakat / Gemini / Excel copy):  <item no> <desc> <date> <qty> <unit> <price> <discount> <discount %> <amount> <print code %> */
  function parseWide(l) {
    const toks = l.split(/\s+/), isN = t => /^\d[\d,]*(\.\d+)?$/.test(t); let u = -1;
    for (let k = 1; k < toks.length - 2; k++) if (KNOWN.test(toks[k]) && isN(toks[k - 1])) { u = k; break; }
    if (u < 0) return null;
    const after = toks.slice(u + 1), nums = after.filter(isN).map(num);
    if (nums.length < 2 || !(nums.length >= 3 || after.some(t => /%$/.test(t)))) return null;   // plain "qty unit price amount" rows stay with the old readers
    const qty = num(toks[u - 1]), price = nums[0], amount = nums[nums.length - 1], disc = nums.length >= 3 ? nums[1] : 0;
    let left = toks.slice(0, u - 1).filter(t => !/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(t)), no = '';
    if (left.length && /^\d{5,7}$/.test(left[0])) no = left.shift();
    const d = left.join(' ').replace(/^\d{1,3}\s+(?=[A-Za-z])/, '').trim();
    if (!/[a-z]{3}/i.test(d) || SKIP.test(d) || !(qty > 0)) return null;
    return { desc: d, descs: [d], itemNo: no, qty, unit: toks[u], price, amount, ok: Math.abs(qty * price - disc - amount) <= tolA(amount), cq: [G(qty)], cn: [G(price), G(amount)] };
  }
  function parseClean(l) {
    const ag = l.match(UNIT_FIRST);
    if (ag) {
      const n = ag[3].trim().split(/\s+/).map(num), prod = n[0] * n[1], net = n.slice(2).find(v => v > 0 && Math.abs(v - prod) <= 0.02 + prod * 0.01), d = ag[1].trim();
      if (/[a-z]{3}/i.test(d) && n[0] > 0 && !SKIP.test(d)) { const desc = d.replace(/^\d+\s+/, ''), amount = net ?? Math.round(prod * 100) / 100;
        return { desc, descs: [desc], itemNo: '', qty: n[0], unit: ag[2], price: n[1], amount, ok: net != null, cq: [G(n[0])], cn: [G(n[1]), G(amount)] }; }
      return null;
    }
    const w = parseWide(l); if (w) return w;
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
  const SYN = { capsicum: 'pepper', courgette: 'zucchini', aubergine: 'eggplant', brinjal: 'eggplant', rocket: 'arugula', coriander: 'cilantro', shiso: 'shisho', romain: 'romaine', cos: 'romaine', rockmelon: 'melon', cantaloupe: 'melon', zuchini: 'zucchini', zucchinis: 'zucchini', capsicums: 'pepper', cauli: 'cauliflower', broc: 'broccoli', cuc: 'cucumber', cucum: 'cucumber', strawbery: 'strawberry', rasp: 'raspberry', lemmon: 'lemon' };
  const LETTUCE_KINDS = ['romaine', 'iceberg', 'lollo', 'oak', 'butter', 'rosso', 'frisee', 'curly', 'batavia', 'green', 'red', 'mix', 'baby', 'lamb', 'little', 'gem', 'rossa', 'bionda', 'mesclun'];
  const stem = t => /oes$/.test(t) ? t.slice(0, -2) : /ies$/.test(t) && t.length > 4 ? t.slice(0, -3) + 'y' : t.length > 3 ? t.replace(/s$/, '') : t;
  const tok = (s, inv) => {
    const set = new Set(String(s).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)).map(stem).map(t => SYN[t] || t));
    if (inv && set.has('lettuce') && !LETTUCE_KINDS.some(k => set.has(k))) set.add('romaine');   // plain "lettuce" means Lettuce Romaine in our list
    return set;
  };
  const MOD = ['baby', 'mini', 'jumbo', 'organic', 'large', 'small', 'fresh', 'local', 'bell'];   // size / style words: never the item itself
  const COLOR = ['red', 'green', 'yellow', 'orange', 'purple', 'white', 'gold', 'black', 'brown', 'pink'];
  const COLOR_ALIAS = { orange: ['gold', 'yellow'], gold: ['orange', 'yellow'] };   // "Cauliflower Orange" is "Cauliflower Gold" in our list
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
    if (t.length >= 3 && !ix.vocab.has(t)) {   // invoice abbreviation: "Cap" = capsicum = pepper, "Yell" = yellow, "Caul" = cauliflower
      const seen = new Set(o.map(z => z[0])), add = (k, s) => { if (ix.vocab.has(k) && !seen.has(k)) { seen.add(k); o.push([k, s]); } };
      Object.keys(SYN).forEach(w => { if (w.startsWith(t)) add(SYN[w], .9); });
      ix.keys.filter(k => k.startsWith(t) && k.length > t.length).sort((a, b) => a.length - b.length).slice(0, 4).forEach(k => add(k, .88 - Math.min(.2, (k.length - t.length) * .02)));
    }
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
    const isMod = t => MOD.includes(t), isCol = t => COLOR.includes(t);
    let N = A.filter(t => !isMod(t) && !isCol(t) && t.length >= 3); if (!N.length) N = A.filter(t => !isMod(t)); if (!N.length) N = A;   // the item's NAME words
    const ix = index(), cand = new Map();
    A.forEach((t, ai) => {
      fuzzy(t).forEach(([k, s]) => ix.vocab.get(k).forEach(r => {
        if (allow && !allow(r)) return; let a = cand.get(r); if (!a) cand.set(r, a = new Array(A.length).fill(0)); if (s > a[ai]) a[ai] = s;
      }));
      (COLOR_ALIAS[t] || []).forEach(k => (ix.vocab.get(k) || []).forEach(r => {
        if (allow && !allow(r)) return; let a = cand.get(r); if (!a) cand.set(r, a = new Array(A.length).fill(0)); if (.8 > a[ai]) a[ai] = .8;
      }));
    });
    const out = [];
    cand.forEach((a, r) => {
      const W = i => isMod(A[i]) ? 0 : isCol(A[i]) ? 1 : 2.5;   // name word counts most, colour next, "baby" nothing
      const rt = r._ta.filter(t => !isMod(t)), B = rt.reduce((x, t) => x + (isCol(t) ? 1 : 2.5), 0);
      let M = 0, T = 0; A.forEach((t, i) => { const w = W(i); if (!w) return; if (a[i] > 0 || t.length >= 4) T += w; M += w * a[i]; });
      if (!M) return;
      const nameHit = N.some(n => { const i = A.indexOf(n); return a[i] > 0; });
      if (!nameHit) return;   // never offer an item that does not even contain the invoice item's name word (Carrot / Zucchini for Capsicum)
      let s = 2 * M / ((T || 1) + (B || 1));
      if (M >= T - .01) s = Math.max(s, .6 + .3 * M / (B || 1));   // everything on the invoice line was found
      if (Math.abs(M - B) < .01 && M >= T - .01) s += .15;          // and nothing extra in ours
      
      const ib = A.includes('baby'), rb = r._ta.includes('baby'); if (ib && rb) s += .08; else if (ib !== rb) s -= .03;   // tie-break only
      const c = parseFloat(r.cost);
      if (s > .2 && price && c) { const d = Math.abs(c - price) / price; s += d <= .03 ? .12 : d <= .1 ? .07 : d <= .25 ? .02 : d > .6 ? -.02 : 0; }
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
      if (!c.length && x.price > 0) c = db.filter(r => inPool(r) && parseFloat(r.cost) > 0 && Math.abs(parseFloat(r.cost) - x.price) / x.price <= .01).slice(0, 6).map(r => ({ r, s: .3 }));   // name unreadable → items with exactly this price
      if (!c.length || c[0].s < 0.5) { const c2 = best(null); if (c2.length && (!c.length || c2[0].s > c[0].s)) { c = c2; x.other = true; } }
      if (c.length > 1 && x.price > 0) { const top = c[0].s, near = c.filter(k => k.s >= top - .16), rest = c.filter(k => k.s < top - .16), dist = k => { const v = parseFloat(k.r.cost); return v > 0 ? Math.abs(v - x.price) / x.price : 9; }; near.sort((a, b) => dist(a) - dist(b) || b.s - a.s); c = [...near, ...rest]; }   // 2–3 codes with the same name: pick the closest price
      const L = learned(x) || (x.itemNo && db.find(r => r.manu && String(r.manu).replace(/\D/g, '') === x.itemNo)); if (L) c = [{ r: L, s: 3 }, ...c.filter(k => k.r !== L)].slice(0, 8);
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
  /* every pass also goes through the number engine (invoice-engine.js): rows keep their raw garbled readings, the engine decides later */
  function engPass(lines) {
    const E = window.InvEngine, rows = [], idx = [];
    if (!E) return { rows, printed: { S: [], Q: [], V: [], T: [] } };
    lines.forEach((l, i) => { const r = E.rowFromLine(l); if (r) { r.support = 1; rows.push(r); idx.push(i); } });
    return { rows, printed: E.parsePrinted(lines.slice(idx.length ? idx[idx.length - 1] + 1 : 0)) };
  }
  async function ocrPage(v, label) {
    status(label + ': finding the table…');
    /* The first pass reads the page as scanned (just straightened + enlarged): on thin, faint print the heavy clean-up versions can erase
       digits, so they come after, as extra opinions that fill the gaps of the first. */
    const first = await ocrFull(v.plain, 6), base = parseLines(first.lines), T = locateTable(first.boxes, v.plain.height);
    let work = v, best = null, from = 0;
    const eng = { passes: [], printed: [] }, addEng = lines => { const p = engPass(lines); if (p.rows.length) eng.passes.push(p.rows); eng.printed.push(p.printed); };
    addEng(first.lines);
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
      const lines = await ocrOnce(work[plan[n][0]], plan[n][1]), p = parseLines(lines); addEng(lines); best = best ? mergeParsed(best, p) : p;
      if (good(best) && (best.res.length >= 4 || n >= 1)) break;
    }
    const res = T ? mergeParsed(best, base) : best;   // the full-page pass adds the totals printed under the table + any row the crop missed
    const E = window.InvEngine; res.eng = { rows: E && eng.passes.length ? eng.passes.reduce((acc, p) => acc ? E.mergeRows(acc, p) : p, null) : [], printed: E ? E.mergePrinted(eng.printed) : null };
    res.head = first.lines.slice(0, 45).join(' ');
    return res;
  }
  /* "AI eyes": Google Gemini reads the picture directly (free key from aistudio.google.com). Result is still checked by qty × price = amount. */
  const AIK = 'ivGeminiKey', AIM = 'ivGeminiModel';
  /* The Gemini key lives on the server (Supabase Edge Function 'read-invoice', secret GEMINI_API_KEY). The app sends the picture plus the person's login. */
  const readerUrl = () => SUPABASE_URL + '/functions/v1/read-invoice';   // the function lives in the app's own Supabase project
  const aiKey = () => { try { localStorage.removeItem(AIK); localStorage.removeItem(AIM); } catch (e) { } return ''; };   // v13: an old key/model saved in this browser made the app call Google directly with a retired model. Always use the server function now.   // optional own key (developer use); normally empty → the server function is used
  const AI_MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3-flash', 'gemini-2.5-flash'];   // newest first: Google retires old models, so on "404 no longer available" the next one is tried automatically
  let aiGood = null;
  const aiModel = () => { try { return aiGood || localStorage.getItem(AIM) || AI_MODELS[0]; } catch (e) { return aiGood || AI_MODELS[0]; } };
  const AI_NUM = { type: 'NUMBER', nullable: true };
  const AI_SCHEMA = { type: 'OBJECT', properties: { invoice_no: { type: 'STRING', nullable: true }, subtotal: AI_NUM, qty_total: AI_NUM, vat: AI_NUM, total: AI_NUM, lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { item_no: { type: 'STRING', nullable: true }, description: { type: 'STRING' }, qty: AI_NUM, unit: { type: 'STRING', nullable: true }, price: AI_NUM, amount: AI_NUM }, required: ['description'] } } }, required: ['lines'] };
  const aiPrompt = (k, n) => 'This image is part ' + k + ' of ' + n + ' of a supplier invoice page for fresh fruit and vegetables (may be a faint photocopy). The parts overlap a little, so a line can appear twice - that is fine. ' +
    'Return every product line you can see, in order, and nothing else (ignore logos, addresses, headings, footers, phone numbers). For each: item_no (supplier item number, string), description (product name only), qty (number), unit (Kg, Pcs, Box…), price (unit price), amount (line total before VAT). ' +
    'Some lines may be partly covered by a printed banner: still return the line, and use null for any number you cannot actually read - never guess a number. ' +
    'Also return invoice_no (e.g. 1101-SO-002844463) if visible, and - only if this part shows them, otherwise null - subtotal = the "Sales subtotal"/"Net amount" before VAT, qty_total = the printed "Quantity" total, vat = "Sales tax amount", total = the final invoice "Total". Read numbers exactly; do not invent lines.';
  async function aiCall(canvas, k, n) {
    const key = aiKey(); let model = aiModel(); const b64 = canvas.toDataURL('image/jpeg', .9).split(',')[1];
    const body = { contents: [{ parts: [{ text: aiPrompt(k, n) }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: AI_SCHEMA } };
    for (let t = 0; ; t++) {
      let r;
      if (key) r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      else {
        let tok = ''; try { tok = (await sb.auth.getSession()).data.session.access_token; } catch (e) { }
        if (!tok) throw new Error('Please log in to the app first');
        try { r = await fetch(readerUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tok }, body: JSON.stringify({ model, body }) }); }
        catch (e) { throw new Error('AI reader unreachable (' + e.message + ') — check the Supabase function'); }
      }
      if (r.status === 404) { const nx = AI_MODELS[AI_MODELS.indexOf(model) + 1] || (AI_MODELS.includes(model) ? null : AI_MODELS[0]); if (nx) { try { localStorage.removeItem(AIM); } catch (e) { } model = nx; continue; } }
      if (r.ok) aiGood = model;
      if ((r.status === 429 || r.status === 503) && t < 2) { await new Promise(z => setTimeout(z, 4000 * (t + 1))); continue; }
      if (!r.ok) { const tx = await r.text(); let m = tx; try { m = JSON.parse(tx).error || (JSON.parse(tx).error && JSON.parse(tx).error.message) || tx; } catch (e) { } throw new Error(`AI reader (HTTP ${r.status}): ${String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 160)}`); }
      return JSON.parse(((await r.json()).candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '{}');
    }
  }
  function aiRows(j) {
    return (j.lines || []).map(l => {
      const itemNo = String(l.item_no || '').replace(/\D/g, ''), d = String(l.description || '').trim() || (itemNo ? 'Item ' + itemNo : ''); if (!/[a-z]{3}/i.test(d)) return null;
      const cq = [+l.qty].filter(v => v > 0).map(G), cn = [+l.price, +l.amount].filter(v => v > 0).map(G); if (!cq.length && !cn.length) return null;
      const s = solve(cq, cn) || { qty: +l.qty || 1, price: +l.price || 0, amount: +l.amount || 0, ok: false };
      const nz = v => (v != null && +v > 0) ? String(+v) : null;
      return { desc: d, descs: [d], itemNo, qty: s.qty, unit: unitName(l.unit || 'kg'), price: s.price, amount: s.amount, ok: s.ok, cq, cn, raw: '(AI) ' + d, ai: true, reads: [{ q: nz(l.qty), n: [nz(l.price), nz(l.amount)].filter(Boolean), exact: true }] };
    }).filter(Boolean);
  }
  /* The page goes to the AI in 2–3 overlapping slices at full resolution (one small picture of the whole page loses thin ink). */
  async function aiReadTiles(canvas, label) {
    const W = canvas.width, H = canvas.height, ratio = H / W, n = ratio > 1.2 ? 3 : ratio > .8 ? 2 : 1, step = Math.ceil(H / n), ov = Math.round(H * .06);
    const res = [], foot = [], pr = { S: [], Q: [], V: [], T: [] }; let no = '';
    for (let k = 0; k < n; k++) {
      status(`${label}: AI reader is looking at part ${k + 1} of ${n}…`);
      const y0 = Math.max(0, k * step - (k ? ov : 0)), y1 = Math.min(H, (k + 1) * step + (k < n - 1 ? ov : 0));
      const j = await aiCall(n === 1 ? canvas : cropTo(canvas, 0, y0, W, y1), k + 1, n);
      const key = r => (r.itemNo || r.desc.toLowerCase()) + '|' + r.amount, tail = res.slice(-10).map(key);
      aiRows(j).forEach(r => { const i = tail.indexOf(key(r)); if (i >= 0) tail[i] = null; else res.push(r); });   // a line seen in two overlapping slices is kept once
      if (!no && j.invoice_no) no = String(j.invoice_no); if (j.subtotal > 0) { foot.push(+j.subtotal); pr.S.push({ v: +j.subtotal, c: 0 }); } if (j.qty_total > 0) pr.Q.push({ v: +j.qty_total, c: 0 }); if (j.vat > 0) pr.V.push({ v: +j.vat, c: 0 }); if (j.total > 0) pr.T.push({ v: +j.total, c: 0 });
    }
    return { res, no, foot, printed: pr };
  }
  /* Strong OCR + the number checks first. The AI (Supabase function) is only used when the OCR result does not add up — e.g. a Barakat photo. */
  const ocrSure = o => { if (!o || !o.res.length || !o.res.every(r => r.ok)) return false; const sum = o.res.reduce((t, r) => t + (r.amount || 0), 0); return !o.foot.length || o.foot.some(f => Math.abs(f - sum) <= .06) || !o.foot.some(f => f > sum * .8 && f < sum * 1.3); };
  async function readPage(src, label) {
    const v = await enhanceVariants(src); let ocr = null, ai = null;
    try { await load(TESS); ocr = await ocrPage(v, label); } catch (e) { console.warn(e); }
    if (ocrSure(ocr)) return ocr;
    let aiErr = ''; window._invAiErr = '';
    status(label + ': hard to read — asking the AI reader…'); try { ai = await aiReadTiles(v.soft, label); } catch (e) { console.warn(e); aiErr = String(e.message).slice(0, 200); }
    window._invAiErr = aiErr;
    if (!(ai && ai.res.length)) { if (!ocr) throw new Error('Could not read this picture' + (aiErr ? ' — ' + aiErr : '')); status(aiErr ? aiErr + ' — showing the OCR result; check the amber lines against the paper.' : 'AI reader found no lines — check the amber lines against the paper.'); return ocr; }
    const sum = ai.res.reduce((t, x) => t + (x.amount || 0), 0), sumQ = ai.res.reduce((t, x) => t + (x.qty || 0), 0), sure = ai.res.every(r => r.ok) && (!ai.foot.length || ai.foot.some(f => Math.abs(f - sum) <= .06)) && (!ai.printed.Q.length || ai.printed.Q.some(f => Math.abs(f.v - sumQ) <= .006));
    if (ocr) ai.head = ocr.head;
    if (sure || !ocr) return ai;
    const m = mergeParsed(ai, ocr); m.eng = ocr.eng; m.printed = ai.printed; m.aiRows = ai.res; m.head = ocr.head; return m;   // AI lines first (best names), OCR repairs / adds
  }
  const status = t => { const s = $('invStatus'); if (s) s.textContent = t; };
  window._invEnh = enhanceVariants;   // exposed for testing
  window._invT = { orderParts, fixSeq, parseVatRow, locateTable, aiRows, aiReadTiles, mergeParsed, reconcile, parseLines };

  /* ══════════════ STEP 2 — CHECK THE NUMBERS (before any matching) ══════════════
     rows are read → the engine fixes digits with qty × price = amount and the printed totals → the person confirms 3 numbers from the paper → match. */
  let stage = 'check', printedC = null, typed = {}, ignored = [], decoded = null, origPages = [];
  const fmt2 = v => (v == null || isNaN(v)) ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toNum = v => { const n = parseFloat(String(v).replace(/,/g, '').trim()); return isNaN(n) ? null : n; };
  const qOf = () => { const P = printedC || { Q: [] }; return P.Q.length === 1 || (P.Q.length > 1 && P.Q[0].c + .25 < P.Q[1].c) ? [P.Q[0]] : []; };   // a quantity total read with doubt is not trusted
  function decodeInput() {
    const P = printedC || { S: [], Q: [], T: [] }, S = [], Q = [];
    if (typed.subtotal != null) S.push({ v: typed.subtotal, c: 0 });
    else if (typed.total != null) S.push({ v: window.InvEngine.r2(typed.total / 1.05), c: 0 });
    else S.push(...P.S);
    if (typed.qty != null) Q.push({ v: typed.qty, c: 0 }); else Q.push(...qOf());
    return { S, Q };
  }
  function uiPrinted() {   // the four boxes: what the person typed, else the photo's best guess
    const P = printedC || { S: [], Q: [], V: [], T: [] }, g = (k, l) => typed[k] != null ? { v: typed[k], typed: true } : (l && l[0] ? { v: l[0].v, typed: false } : null);
    const u = { qty: g('qty', qOf()), subtotal: g('subtotal', P.S), total: g('total', P.T) }, S = u.subtotal ? u.subtotal.v : null, T = u.total ? u.total.v : null;
    u.vat = typed.vat != null ? { v: typed.vat, typed: true } : (S != null && T != null ? { v: window.InvEngine.r2(T - S), typed: false } : S != null ? { v: window.InvEngine.r2(S * .05), typed: false } : null);
    return u;
  }
  const printedNums = () => { const u = uiPrinted(), o = {}; Object.keys(u).forEach(k => { if (u[k]) o[k] = u[k].v; }); return o; };

  function partRows(p) {   // which lines of this page to trust: the old reader when it already adds up, else the engine's lines
    const E = window.InvEngine, legacy = p.res, sum = legacy.reduce((t, r) => t + (r.amount || 0), 0);
    if (!E || (legacy.length >= 3 && legacy.every(r => r.ok) && (!p.foot.length || p.foot.some(f => Math.abs(f - sum) <= .06)))) return legacy;
    const ocr = p.eng && p.eng.rows.length ? p.eng.rows : [], ai = legacy.filter(r => r.ai && r.reads);
    if (ai.length && ocr.length) return E.mergeRows(ai.map(r => ({ ...r, reads: [...r.reads], support: 2 })), ocr);
    if (ai.length) return legacy;
    return ocr.length >= Math.max(3, legacy.length) ? ocr : legacy;
  }
  function triOf(x) {
    const E = window.InvEngine;
    if (x.reads && x.reads.length) { const t = E.rowTriples(x); if (t.length) return t; }
    return [x.qty, x.price, x.amount].every(Number.isFinite) ? [{ q: x.qty, p: x.price, a: x.amount, c: x.ok ? 0 : 2.5 }] : [];
  }
  function refPrice(x) {   // what we normally pay for this item (from our own list) — a strong hint for the price
    if (!db.length) return 0; let best = null;
    (x.descs || [x.desc]).forEach(d => { const c = candidates(d, null)[0]; if (c && (!best || c.s > best.s)) best = c; });
    const v = best && best.s >= .6 ? parseFloat(best.r.cost) : 0; return v > 0 ? v : 0;
  }
  function solveRows() {
    const E = window.InvEngine; if (!E) return;
    rows.forEach(x => {
      if (x.locked) { x.tri = [{ q: x.qty, p: x.price, a: x.amount, c: 0 }]; x.drop = undefined; return; }
      if (!x.tri0) x.tri0 = triOf(x);
      x.tri = x.tri0.map(t => ({ q: t.q, p: t.p, a: t.a, c: t.c, c0: t.c }));
      x.ref = refPrice(x); E.applyRef(x);
      x.drop = (!x.ai && !x.vat && x.reads && (x.support || 2) <= 1) ? 1.2 : undefined;   // a line only one pass saw may be stray text
    });
    const inp = decodeInput(), D = E.decode(rows, inp), keep = []; ignored = [];
    rows.forEach((x, i) => {
      const k = D.picks[i];
      if (k === -2) { ignored.push(x); return; }
      const t = k >= 0 ? x.tri[k] : null;
      if (t) { x.qty = t.q; x.price = t.p; x.amount = t.a; x.conf = x.locked ? 0 : (t.c0 != null ? t.c0 : t.c); /* confidence ignores the price-list bonus */ x.alt = x.tri.filter((_, j) => j !== k).slice(0, 2); }
      else { x.conf = 9; x.alt = []; if (!Number.isFinite(x.qty)) x.qty = 1; if (!Number.isFinite(x.price)) x.price = 0; if (!Number.isFinite(x.amount)) x.amount = 0; }
      if (x.descs && x.descs.length > 1) x.name = E.bestDesc(x); else x.name = x.name || x.desc;
      keep.push(x);
    });
    rows = keep; decoded = D; decoded.missing = E.missingLine(D.sumQ, D.sumA, inp);
  }
  window._invDbg = () => JSON.stringify({ printed: printedC, rows: rows.map(x => ({ n: x.name, ref: x.ref, sup: x.support, q: x.qty, p: x.price, a: x.amount, c: x.conf, tri: (x.tri || []).slice(0, 4) })) }, null, 0);
  const arithOk = x => Math.abs(x.qty * x.price - x.amount) <= .011 + x.amount * .001;
  const rowNote = x => {
    const n = [];
    if (!arithOk(x)) n.push(`qty × price = ${fmt2(x.qty * x.price)}, not ${fmt2(x.amount)}`);
    if (x.qty >= 250) n.push('very large quantity — was a decimal point lost?');
    if (!n.length && !x.locked && x.conf > 1.0 && !(x.reads && x.reads[0] && (() => { const r0 = x.reads[0], f = v => parseFloat(String(v).replace(/,/g, '')), ns = (r0.n || []).map(f); return f(r0.q) === x.qty && ns.includes(x.price) && ns.includes(x.amount); })())) { const r0 = x.reads && x.reads[0]; n.push('adjusted by the checks' + (r0 ? ' (first read: ' + r0.q + ' × ' + (r0.n || []).join(' / ') + ')' : '') + ' — compare with the paper'); }
    return n.join(' · ');
  };
  const checkOk = () => { const C = window.InvEngine.checks(rows, printedNums()); return C.allOk && !rows.some(x => !arithOk(x)); };
  function renderCheck() {
    const E = window.InvEngine, P = uiPrinted(), PN = printedNums(), C = E.checks(rows, PN);
    const box = (k, label, got, tol) => { const u = P[k], want = u ? u.v : null, ok = want == null ? null : Math.abs(got - want) <= tol;
      return `<label class="ck-box ${ok === true ? 'good' : ok === false ? 'badbox' : ''}"><span class="ck-l">${label}</span><input inputmode="decimal" data-ck="${k}" value="${want == null ? '' : want}" placeholder="from the paper"><span class="ck-s">${ok === true ? '✓ ' : ok === false ? '✗ ' : ''}lines give ${fmt2(got)}${u && !u.typed ? ' · read from photo' : ''}${k === 'qty' && !u && printedC && printedC.Q.length ? ' · maybe ' + printedC.Q.slice(0, 3).map(x => fmt2(x.v)).join(' / ') : ''}</span></label>`; };
    const miss = decoded && decoded.missing, wrong = C.list.filter(x => x.ok === false).length;
    $('invBody').innerHTML = `<div class="ck-top"><div class="ck-title">Step 2 · Check the numbers</div><span class="iv-chip ${checkOk() ? 'g' : 'a'}">${checkOk() ? (P.qty ? '✓ everything adds up' : '✓ adds up — also type the quantity total') : wrong ? '✗ ' + wrong + ' total(s) differ' : 'type the totals printed on the invoice'}</span></div>
<div class="ck-tot">${box('qty', 'Quantity total', C.sumQ, .006)}${box('subtotal', 'Sales subtotal', C.sumA, .06)}${box('vat', 'VAT 5%', C.vat, .06)}${box('total', 'Invoice total', C.tot, .06)}</div>
${miss ? `<div class="ck-card warnc">The invoice totals are higher than your lines. A line may be missing${miss.qty ? `: <b>${fmt2(miss.qty)} × ${fmt2(miss.price)} = ${fmt2(miss.amount)}</b>` : `: worth <b>${fmt2(miss.amount)}</b>`} <button class="iv-sec" id="ckMiss" style="padding:6px 12px;font-size:12px">+ Add it</button></div>` : ''}
${ignored.length ? `<div class="ck-card">Ignored as stray text: ${ignored.map(x => esc(x.name || x.desc)).join(', ')}</div>` : ''}
<div class="ck-list">${rows.map((x, i) => { const note = rowNote(x), warn = !arithOk(x) || (!x.locked && x.conf > 1.0 && !checkOk()) || x.qty >= 250;
      return `<div class="ck-row ${warn ? 'warn' : ''}" data-i="${i}"><span class="ck-n">${i + 1}</span><input class="ck-d" data-f="name" value="${esc(x.name || x.desc)}" aria-label="item name">
<div class="ck-nums"><label>Qty<input inputmode="decimal" data-f="qty" value="${fmt(x.qty)}"></label><span class="ck-u">${esc(x.unit || 'Kg')}</span><label>Price<input inputmode="decimal" data-f="price" value="${fmt(x.price)}"></label><label>Amount<input inputmode="decimal" data-f="amount" value="${fmt(x.amount)}"></label></div>
<span class="ck-st">${warn ? '⚠️' : x.locked ? '✏️' : '✓'}</span><button class="ck-x" data-del title="Remove line">✕</button>
${note || (x.alt && x.alt.length && warn) ? `<div class="ck-note">${esc(note)}${warn && x.alt ? x.alt.slice(0, 2).map((t, j) => `<button data-alt="${j}">${fmt(t.q)} × ${fmt(t.p)} = ${fmt(t.a)}</button>`).join('') : ''}</div>` : ''}</div>`; }).join('')}</div>
<p class="iv-sub" style="margin-top:12px">Change any number and the other lines re-adjust to the totals. Lines you edit stay exactly as you set them.</p>
${origPages.length ? `<details class="iv-raw" open><summary>Original photo / page (tap to enlarge)</summary><div class="ck-orig">${origPages.map((u, i) => `<img src="${u}" data-orig="${i}" alt="page ${i + 1}">`).join('')}</div></details>` : ''}
<div class="iv-sum" style="margin-top:12px"><button class="iv-sec" id="ckJpg" style="padding:9px 14px;font-size:13px">⬇ Clean invoice (JPG)</button><button class="iv-sec" id="ckPdf" style="padding:9px 14px;font-size:13px">🖨 Clean invoice (PDF)</button></div>`;
    status(`${rows.length} lines${invNo ? ' — ' + invNo : ''} · check the four boxes against the paper, then match codes`);
  }
  function ckEdit(i, f, val) {
    const x = rows[i]; if (!x) return;
    if (f === 'name') { x.name = val; x.desc = val; x.descs = [val]; return; }
    const v = toNum(val); if (v == null) return;
    x[f] = v; if (f !== 'amount') x.amount = Math.round(x.qty * x.price * 100) / 100; x.locked = true;
    solveRows(); render();
  }
  function ckWire() {
    const B = $('invBody'); if (B._ck) return; B._ck = 1;
    B.addEventListener('change', e => {
      const t = e.target; if (!t.closest || stage !== 'check') return;
      if (t.dataset.ck) { const v = toNum(t.value); if (v == null) delete typed[t.dataset.ck]; else typed[t.dataset.ck] = v; solveRows(); render(); return; }
      const row = t.closest('.ck-row'); if (row && t.dataset.f) ckEdit(+row.dataset.i, t.dataset.f, t.value);
    });
    B.addEventListener('click', e => {
      { const t0 = e.target, im0 = t0.closest && t0.closest('[data-orig]'); if (im0 && typeof openLightbox === 'function') { openLightbox(im0.src, 'Original page ' + (+im0.dataset.orig + 1), invNo); return; } if (t0.closest && t0.closest('#ckJpg')) { cleanJpg(); return; } if (t0.closest && t0.closest('#ckPdf')) { cleanPdf(); return; } }
      if (stage !== 'check') return; const t = e.target, row = t.closest && t.closest('.ck-row'), i = row ? +row.dataset.i : -1;
      if (t.closest('[data-del]') && i >= 0) { rows.splice(i, 1); solveRows(); render(); return; }
      const alt = t.closest('[data-alt]'); if (alt && i >= 0) { const a = rows[i].alt[+alt.dataset.alt]; if (a) { Object.assign(rows[i], { qty: a.q, price: a.p, amount: a.a, locked: true }); solveRows(); render(); } return; }
      if (t.closest('#ckMiss')) { const m = decoded.missing; rows.push({ desc: 'Missing line', name: 'Missing line', descs: ['Missing line'], itemNo: '', qty: m.qty || 1, unit: 'Kg', price: m.price || m.amount, amount: m.amount, ok: true, locked: true, cq: [], cn: [], raw: '(added from totals)' }); solveRows(); render(); return; }
      const im = t.closest('[data-orig]'); if (im && typeof openLightbox === 'function') openLightbox(im.src, 'Original page ' + (+im.dataset.orig + 1), invNo);
      if (t.closest('#ckJpg')) cleanJpg(); if (t.closest('#ckPdf')) cleanPdf();
    });
  }
  function addBlankLine() { rows.push({ desc: '', name: '', descs: [''], itemNo: '', qty: 1, unit: 'Kg', price: 0, amount: 0, ok: false, locked: true, cq: [], cn: [], raw: '(added by hand)', cands: [], pick: -1 }); solveRows(); render(); }
  /* A bad read is never shown as if it were the invoice. */
  let held = [];
  function unreadable(why) {
    rows = []; const ai = window._invAiErr;
    $('invBody').innerHTML = `<div class="ck-card" style="margin:12px 0;padding:16px"><b>Could not read this invoice reliably.</b><br>I am not showing guesses.<br><span class="iv-sub">${esc(String(why || '').replace(/^Error:\s*/, ''))}${ai && !String(why || '').includes(ai) ? '<br>AI reader: ' + esc(ai) : ''}</span><br><br>Try a sharper photo, the original PDF, or paste the invoice table in the box above.${held.length ? ' <span class="iv-chg" id="ckShowAnyway">Show what was read anyway (not reliable)</span>' : ''}</div>`;
    const b = document.querySelector('#invModal .iv-bar'); if (b) b.style.display = 'none'; status('Could not read this invoice reliably.');
    const a = $('ckShowAnyway'); if (a) a.onclick = () => { rows = held; stage = 'check'; solveRows(); render(); };
  }
  window._invUnreadable = unreadable;
  function confirmCheck() {
    rows.forEach(x => { if (x.name) { x.descs = [x.name, ...(x.descs || []).filter(d => d !== x.name)]; x.desc = x.name; } });
    match(); stage = 'match'; render(); status(`${rows.length} lines matched — check the codes, then copy or export`);
  }
  function setBar() {
    const b = document.querySelector('#invModal .iv-bar'); if (!b) return;
    if (!rows.length) { b.style.display = 'none'; return; } b.style.display = '';
    b.innerHTML = stage === 'check' ? `<button id="ckAdd">＋ Add line</button><button class="p" id="ckGo">${checkOk() ? '✔ Looks right — match codes' : 'Match codes anyway'}</button>`
      : `<button id="ckBack">← Check numbers</button><button class="p" id="invQb">Copy list for QuickBooks</button><button id="invXls">⬇ Excel</button><button id="invCopy">Copy all</button>`;
    const on = (id, f) => { const el = $(id); if (el) el.onclick = f; };
    on('ckAdd', addBlankLine); on('ckGo', confirmCheck); on('ckBack', () => { stage = 'check'; render(); }); on('invXls', exportXls); on('invCopy', copyTable); on('invQb', copyQb);
  }
  /* a clean, machine-made copy of what was read: downloadable picture, or print → PDF */
  const cleanRows = () => rows.map((x, i) => [i + 1, x.name || x.desc, fmt(x.qty), x.unit || 'Kg', money(x.price), money(x.amount)]);
  function cleanJpg() {
    const C = window.InvEngine.checks(rows, printedNums()), R = cleanRows(), W = 1240, rh = 44, H = 260 + R.length * rh + 260, c = mk(W, H), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#0f172a'; g.font = '700 38px sans-serif'; g.fillText('Invoice — clean copy', 60, 80);
    g.font = '400 24px sans-serif'; g.fillStyle = '#475569'; g.fillText('Invoice no: ' + (invNo || '—') + '     lines: ' + R.length, 60, 124);
    const cx = [60, 130, 760, 840, 980, 1180]; g.font = '700 22px sans-serif'; g.fillStyle = '#0f172a'; ['#', 'Item', 'Qty', 'Unit', 'Price', 'Amount'].forEach((h, k) => { g.textAlign = k >= 2 && k !== 3 ? 'right' : 'left'; g.fillText(h, k === 2 ? 800 : k === 4 ? 1060 : k === 5 ? 1180 : cx[k], 180); }); g.textAlign = 'left';
    g.strokeStyle = '#cbd5e1'; g.beginPath(); g.moveTo(50, 196); g.lineTo(1190, 196); g.stroke();
    R.forEach((r, i) => { const y = 236 + i * rh; g.font = '400 24px sans-serif'; g.fillStyle = '#0f172a'; g.fillText(String(r[0]), 60, y); g.fillText(String(r[1]).slice(0, 38), 130, y); g.textAlign = 'right'; g.fillText(r[2], 800, y); g.fillText(r[4], 1060, y); g.fillText(r[5], 1180, y); g.textAlign = 'left'; g.fillText(r[3], 840, y); });
    let y = 236 + R.length * rh + 30; g.strokeStyle = '#0f172a'; g.beginPath(); g.moveTo(50, y - 24); g.lineTo(1190, y - 24); g.stroke();
    const line = (a, b) => { g.font = '700 26px sans-serif'; g.fillStyle = '#0f172a'; g.fillText(a, 60, y); g.textAlign = 'right'; g.fillText(b, 1180, y); g.textAlign = 'left'; y += 44; };
    line('Quantity total', fmt2(C.sumQ)); line('Sales subtotal', fmt2(C.sumA)); line('VAT 5%', fmt2(C.vat)); line('Invoice total', fmt2(C.tot));
    g.font = '400 20px sans-serif'; g.fillStyle = C.allOk ? '#047857' : '#b45309'; g.fillText(C.allOk ? '✓ all totals match the printed invoice' : 'Totals not yet confirmed against the printed invoice', 60, y + 20);
    c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `invoice-${invNo || 'clean'}.jpg`; document.body.appendChild(a); a.click(); a.remove(); }, 'image/jpeg', .92);
  }
  function cleanPdf() {
    const C = window.InvEngine.checks(rows, printedNums()), R = cleanRows(), f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0'; document.body.appendChild(f);
    f.srcdoc = `<html><head><title>Invoice ${esc(invNo)}</title><style>body{font:14px sans-serif;margin:24px}table{width:100%;border-collapse:collapse}th,td{padding:6px;border-bottom:1px solid #ddd;text-align:left}.r{text-align:right}</style></head><body><h2>Invoice — clean copy</h2><p>Invoice no: ${esc(invNo || '—')}</p><table><tr><th>#</th><th>Item</th><th class="r">Qty</th><th>Unit</th><th class="r">Price</th><th class="r">Amount</th></tr>${R.map(r => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td><td class="r">${r[2]}</td><td>${esc(r[3])}</td><td class="r">${r[4]}</td><td class="r">${r[5]}</td></tr>`).join('')}</table><h3>Quantity total ${fmt2(C.sumQ)} · Subtotal ${fmt2(C.sumA)} · VAT ${fmt2(C.vat)} · Total ${fmt2(C.tot)}</h3></body></html>`;
    f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { status('Could not open print: ' + e.message); } setTimeout(() => f.remove(), 60000); };
  }

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
.iv-bar{z-index:20;position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:center;gap:10px;padding:12px 24px calc(12px + env(safe-area-inset-bottom,0px));background:var(--bg-color);border-top:1px solid var(--glass-edge)}
.iv-bar button{flex:1;max-width:260px;padding:14px;border-radius:14px;border:none;font:800 14px inherit;cursor:pointer;background:var(--iv-soft);color:var(--text)}
.iv-bar button.p{background:var(--brand);color:#fff}
.iv-pw{width:56px;height:56px;margin:0;isolation:isolate}.iv-ph,.prod-photo-wrap{isolation:isolate}.iv-c1 .iv-pw{width:64px;height:64px;border-radius:14px}.iv-c1 .iv-pw .prod-photo-bg,.iv-c1 .iv-pw .prod-photo-img{border-radius:14px}.iv-c1 .iv-pw .prod-photo-emoji{font-size:28px}
.iv-ph{width:52px;height:52px;border-radius:12px;object-fit:cover;background:var(--iv-soft);cursor:zoom-in;flex:none;display:flex;align-items:center;justify-content:center;font-size:20px}
.iv-code{font:800 14px ui-monospace,monospace;color:var(--brand);cursor:pointer;white-space:nowrap}.iv-code.none{color:#dc2626}
.iv-uom{display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:20px;background:rgba(16,185,129,.12);color:var(--iv-ok)}
.iv-q,.iv-pick select,.iv-pick input{width:100%;margin-top:6px;padding:9px 12px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:600 13px inherit}
.iv-nums{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px}.iv-nums label{font-size:10px;font-weight:700;color:var(--iv-muted)}.iv-nums input{margin-top:2px}
.iv-pick{display:none}.edit>.iv-pick,.edit .iv-pick{display:block}
.iv-chg{display:inline-block;margin-top:6px;font-size:12px;color:var(--iv-muted);text-decoration:underline;cursor:pointer}
.warn{box-shadow:inset 3px 0 0 var(--iv-warn)}.warn .amt{color:var(--iv-warn)}
/* desktop: table */
.iv-tbl{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:14px}.iv-tbl th:nth-child(1),.iv-tbl td:nth-child(1){width:34px;padding-left:10px;padding-right:4px}.iv-tbl th:nth-child(2){width:27%}.iv-tbl th:nth-child(3){width:118px}.iv-tbl th:nth-child(5){width:56px}.iv-tbl th:nth-child(6){width:64px}.iv-tbl th:nth-child(7){width:78px}.iv-tbl th:nth-child(8){width:92px}
.iv-tbl th{text-align:left;font-size:11px;font-weight:700;color:var(--iv-muted);padding:10px 12px;border-bottom:1px solid var(--glass-edge);position:sticky;top:-20px;background:var(--bg-color);z-index:2}
.iv-tbl td{padding:12px;border-bottom:1px solid var(--glass-edge);vertical-align:middle}
.iv-tbl tr:hover td{background:var(--iv-soft)}.iv-tbl .r{text-align:right;font-variant-numeric:tabular-nums}
.iv-tbl .it{display:flex;gap:12px;align-items:flex-start}.iv-tbl td.inv{white-space:normal;overflow-wrap:break-word;word-break:normal;line-height:1.35;font-weight:600}.iv-tbl td{padding:12px 8px}.iv-tot{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin:14px 0 4px}.iv-tot div{padding:10px 16px;border-radius:14px;background:var(--iv-soft);font-size:13px;font-weight:700}.iv-tot b{font-size:15px;margin-left:6px}.iv-tot .g{color:var(--iv-ok)}.iv-tot .a{color:var(--iv-warn)}.iv-tbl .it>div{flex:1;min-width:0}
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
.ck-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}.ck-title{font-weight:800;font-size:16px;flex:1}
.ck-tot{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 14px}
.ck-box{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1.5px solid var(--glass-edge);border-radius:14px;background:var(--iv-soft)}.ck-box.good{border-color:var(--iv-ok)}.ck-box.badbox{border-color:var(--iv-warn)}
.ck-l{font-size:11px;font-weight:800;color:var(--iv-muted);text-transform:uppercase;letter-spacing:.4px}
.ck-box input{width:100%;padding:8px 10px;border-radius:10px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:800 16px ui-monospace,monospace}
.ck-s{font-size:11px;color:var(--iv-muted)}.ck-box.good .ck-s{color:var(--iv-ok)}.ck-box.badbox .ck-s{color:var(--iv-warn)}
.ck-list{display:flex;flex-direction:column;gap:8px}
.ck-row{display:grid;grid-template-columns:26px minmax(0,1fr) auto 26px 30px;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--glass-edge);border-radius:14px;background:var(--card-bg,#0d1829)}
.ck-row.warn{box-shadow:inset 3px 0 0 var(--iv-warn)}
.ck-nums{display:grid;grid-template-columns:84px 40px 84px 100px;gap:8px;align-items:center}
.ck-row input{width:100%;min-width:0;padding:8px;border-radius:9px;border:1px solid var(--glass-edge);background:var(--input-bg);color:var(--text);font:600 16px inherit}
.ck-row label{display:flex;flex-direction:column;font-size:9px;font-weight:800;color:var(--iv-muted);text-transform:uppercase;gap:2px}
.ck-row .ck-d{font-weight:700}.ck-n{font-weight:800;color:var(--iv-muted);text-align:center;font-size:12px}.ck-u{font-size:12px;font-weight:800;color:var(--iv-ok);text-align:center}
.ck-st{font-size:16px;text-align:center}.ck-x{border:none;background:none;color:var(--iv-muted);font-size:16px;cursor:pointer;padding:6px}
.ck-note{grid-column:2/-1;font-size:12px;color:var(--iv-warn)}.ck-note button{border:none;background:var(--iv-soft);color:var(--text);padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;margin-left:6px}
.ck-card{padding:12px 14px;border:1px solid var(--glass-edge);border-radius:14px;margin:0 0 12px;font-size:13px;background:var(--iv-soft)}.ck-card.warnc{border-color:var(--iv-warn)}
.ck-orig{display:flex;gap:8px;overflow-x:auto;padding:6px 0}.ck-orig img{height:120px;border-radius:10px;border:1px solid var(--glass-edge);cursor:zoom-in}
@media(max-width:899px){.ck-tot{grid-template-columns:repeat(2,1fr)}.ck-row{grid-template-columns:24px minmax(0,1fr) 26px 30px;grid-template-areas:"n d s x" "m m m m"}.ck-row>.ck-n{grid-area:n}.ck-row>.ck-d{grid-area:d}.ck-row>.ck-st{grid-area:s}.ck-row>.ck-x{grid-area:x}.ck-row>.ck-nums{grid-area:m;grid-template-columns:1fr 36px 1fr 1fr}.ck-note{grid-column:1/-1}}
@media(max-width:899px){.iv-tblwrap{display:none}.iv-cards{display:block}.iv-scroll{padding:16px 14px calc(96px + env(safe-area-inset-bottom,0px))}.iv-go,.iv-sec{flex:1}.iv-enh canvas{width:100%}}`;
    document.head.appendChild(st);
    const m = document.createElement('div'); m.id = 'invModal';
    m.innerHTML = `<div class="iv-top"><h2>📄 Invoice Scanner <small style="font-size:11px;opacity:.6;font-weight:600">v13</small></h2><button class="iv-x" onclick="document.getElementById('invModal').classList.remove('open')">✕</button></div>
<div class="iv-scroll"><div class="iv-wrap">
  <label class="iv-drop" id="invDrop"><span style="font-size:26px">⬆️</span><b>Tap to choose invoice</b><small id="invFiles">PDF or photo — you can pick several pages</small>
    <input type="file" id="invFile" accept=".pdf,image/*" multiple hidden></label>
  <div class="iv-ctl">
    <button class="iv-go" id="invRun">Scan &amp; Match</button>
  </div>
  <input type="hidden" id="invSup" value=""><input type="hidden" id="invPre" value="">
  <details class="iv-paste"><summary>📋 Paste invoice table — e.g. the list a free AI chat (Gemini / ChatGPT) extracted from the photo</summary><textarea id="invPaste" rows="5" placeholder="Strawberry Pp  10/07/2026  3.00 Kg 50.00 150.00"></textarea></details>
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
    $('invBody').addEventListener('click', e => {
      if (e.target.closest('select,input')) return;
      const ph = e.target.closest('.iv-ph[data-full]'); if (ph) { if (typeof openLightbox === 'function') openLightbox(ph.dataset.full, ph.dataset.label || '', ph.dataset.code || ''); return; }
      const del = e.target.closest('.iv-del'); if (del) { const i = +del.closest('[data-i]').dataset.i; rows.splice(i, 1); recon = recon && { ...recon }; render(); status('Line removed.'); return; }
      const chg = e.target.closest('.iv-chg'); if (chg) { chg.closest('.iv-card,tr').classList.toggle('edit'); return; }
      const el = e.target.closest('[data-copy]'); if (!el) return;
      const t = el.innerText.trim().replace(/\s*\/\s*\w+$/, ''); if (!t) return;
      navigator.clipboard.writeText(t).then(() => status('Copied: ' + t));
    });
    $('invRun').onclick = run; setBar();
  }
  window.openInvoiceScanner = function () { build(); $('invModal').classList.add('open'); if (!db.length) status('Load the item list first.'); };
  document.addEventListener('DOMContentLoaded', build);


  async function run() {
    if (!db.length) return status('Load the item list first.');
    const btn = $('invRun'); btn.disabled = true;
    try {
      const files = [...$('invFile').files], pasted = $('invPaste').value.trim(); let parts = [];
      const pagePics = []; const withPr = (p, lines) => { if (window.InvEngine) { const e = engPass(lines); e.rows.forEach(r => r.support = 3); p.printed = e.printed; p.eng = { rows: e.rows, printed: [] }; } return p; };   // typed / pasted / PDF-text lines are exact: no stray-line dropping
      if (pasted) parts.push(withPr(parseLines(pasted.split('\n')), pasted.split('\n')));
      else if (!files.length) return status('Choose a PDF or image first (you can pick several photos).');
      else for (const f of files) {
        status('Reading ' + f.name + '…'); const mine = [];
        if (/\.pdf$/i.test(f.name)) {
          const buf = await f.arrayBuffer(), tl = await pdfLines(buf.slice(0)), p = withPr(parseLines(tl), tl); p.head = tl.slice(0, 45).join(' ');
          if (p.res.length) mine.push(p);
          else { const pages = await pdfToImages(buf); for (let i = 0; i < pages.length; i++) { pagePics.push(pages[i].toDataURL('image/jpeg', .6)); mine.push(await readPage(pages[i], `${f.name} p${i + 1}`)); } }
        } else { const u = URL.createObjectURL(f); pagePics.push(u); mine.push(await readPage(u, f.name)); }
        parts.push(...orderParts(mine));
      }
      if (worker) { worker.terminate(); worker = null; }
      const E = window.InvEngine;
      { const head = parts.map(p => p.head || '').join(' ') + ' ' + files.map(f => f.name).join(' '), P = /barakat|100009274|importers of fresh/i.test(head) ? ['Barakat', 'BkVg,BkFr'] : /gholami|\bAG\s*veg/i.test(head) ? ['AG Veg', 'VgCh,FrCh'] : ['', ''];   // supplier recognised from the invoice itself
        $('invSup').value = P[0]; $('invPre').value = P[1]; }
      rows = parts.flatMap(p => partRows(p)); missingNo = E ? [] : fixSeq(rows); invNo = (parts.find(p => p.no) || {}).no || '';
      if (!rows.length) return status('Could not find item lines. Try a sharper photo, the AI reader, or paste the invoice text.');
      printedC = E ? E.mergePrinted(parts.flatMap(p => [p.printed, p.eng && p.eng.printed].filter(Boolean))) : null; typed = {}; recon = null;
      window._invRaw = parts.flatMap(p => p.res.map(r => r.raw)); stage = 'check'; origPages = pagePics;
      rows.forEach(x => { if (!x.descs) x.descs = [x.desc]; });
      if (E) solveRows();
      { const U = uiPrinted(), sumA = rows.reduce((t, x) => t + (x.amount || 0), 0);
        if (!rows.every(arithOk) || (U.subtotal && Math.abs(U.subtotal.v - sumA) > .06)) { held = rows; return unreadable(rows.some(x => !arithOk(x)) ? 'some lines do not multiply out' : `the lines add up to ${sumA.toFixed(2)} but the invoice says ${U.subtotal.v.toFixed(2)}`); } }
      confirmCheck(); try { $('invBody').scrollIntoView({ block: 'start' }); } catch (e) { }
    } catch (e) { console.error(e); unreadable(e.message); }
    finally { btn.disabled = false; }
  }

  const fmt = v => (v === '' || v == null || isNaN(v)) ? '' : (Math.round(v * 1000) / 1000).toString();
  const money = v => isNaN(v) ? '' : (+v).toFixed(2);
  const bad = x => !(Math.abs(x.qty * x.price - x.amount) <= tolA(x.amount));
  const picker = i => `<div class="iv-pick"><select data-i="${i}"></select><input class="iv-q" data-i="${i}" placeholder="Search all items…">
<div class="iv-nums"><label>Qty<input type="number" step="any" data-k="qty" data-i="${i}"></label><label>Cost<input type="number" step="any" data-k="price" data-i="${i}"></label><label>Amount<input type="number" step="any" data-k="amount" data-i="${i}"></label></div></div>`;
  function render() { ckWire(); if (stage === 'check') renderCheck(); else renderMatch(); setBar(); }
  const origBlock = () => `${origPages.length ? `<details class="iv-raw" open><summary>Original page (tap to enlarge)</summary><div class="ck-orig">${origPages.map((u, i) => `<img src="${u}" data-orig="${i}" alt="page ${i + 1}">`).join('')}</div></details>` : ''}<div class="iv-sum" style="margin:8px 0"><button class="iv-sec" id="ckPdf" style="padding:9px 14px;font-size:13px">🖨 Clean invoice (PDF)</button><button class="iv-sec" id="ckJpg" style="padding:9px 14px;font-size:13px">⬇ Clean invoice (JPG)</button></div>`;
  function renderMatch() {
    $('invBody').innerHTML = `${origBlock()}<div class="iv-sum" id="invSum"></div>
<div class="iv-cards">${rows.map((x, i) => `<div class="iv-card" data-i="${i}">
  <div class="iv-c1"><span class="iv-ph" data-f="ph" data-i="${i}"></span><div><div class="nm" data-f="desc" data-i="${i}" data-copy="1"></div><div class="iv-sub">Invoice: ${esc(x.desc)}</div></div></div>
  <div class="iv-c2"><span class="iv-code" data-f="code" data-i="${i}" data-copy="1"></span><span class="iv-uom" data-f="uom" data-i="${i}"></span><span class="iv-cost" data-f="price" data-i="${i}" data-copy="1"></span></div>
  <div class="iv-sub"><span data-f="qty" data-i="${i}"></span> qty · amount <span class="amt" data-f="amount" data-i="${i}"></span> <span data-f="pnote" data-i="${i}"></span></div>
  <span class="iv-chg">Change item / edit</span> <span class="iv-chg iv-del">Remove line</span>${picker(i)}</div>`).join('')}</div>
<div class="iv-tblwrap"><table class="iv-tbl"><thead><tr><th>#</th><th>Our item</th><th>Code</th><th>Invoice item</th><th class="r">Qty</th><th>UOM</th><th class="r">Cost</th><th class="r">Amount</th></tr></thead><tbody>${rows.map((x, i) => `<tr data-i="${i}"><td>${i + 1}</td>
<td><div class="it"><span class="iv-ph" data-f="ph" data-i="${i}"></span><div><div class="nm" data-f="desc" data-i="${i}" data-copy="1"></div><span class="iv-chg">Change / edit</span> <span class="iv-chg iv-del">Remove</span>${picker(i)}</div></div></td>
<td><span class="iv-code" data-f="code" data-i="${i}" data-copy="1"></span></td><td class="inv">${esc(x.desc)} <span class="iv-sub" data-f="pnote" data-i="${i}"></span></td><td class="r" data-f="qty" data-i="${i}"></td><td><span class="iv-uom" data-f="uom" data-i="${i}"></span></td><td class="r" data-f="price" data-i="${i}" data-copy="1"></td><td class="r amt" data-f="amount" data-i="${i}"></td></tr>`).join('')}</tbody></table></div>
<div class="iv-tot" id="invTot"></div>
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
    if (window.InvEngine && printedC) { const C = window.InvEngine.checks(rows, printedNums()), wr = C.list.filter(x => x.ok === false); rc = C.list.slice(1).map(x => `<span class="iv-chip ${x.ok === false ? 'a' : x.ok ? 'g' : ''}">${x.ok === true ? '✓ ' : x.ok === false ? '✗ ' : ''}${x.label} ${fmt2(x.got)}${x.ok === false && x.want != null ? ' (invoice ' + fmt2(x.want) + ')' : ''}</span>`).join(''); }
    else if (recon) { const hit = recon.hit != null && Math.abs(recon.hit - sum) <= .06;
      rc = hit ? `<span class="iv-chip g">✓ Total matches invoice ${recon.hit.toFixed(2)}</span>` : recon.state === 'diff' || recon.state === 'fixed' ? `<span class="iv-chip a">Invoice shows ${recon.hit.toFixed(2)} — check amber lines</span>` : ''; }
    { const T = $('invTot'); if (T) { const q = rows.reduce((a, x) => a + (+x.qty || 0), 0), vat = Math.round(sum * 5) / 100, tot = sum + vat, P = (typeof printedNums === 'function' && printedC) ? printedNums() : {}, cls = (v, w) => w == null ? '' : Math.abs(v - w) <= .06 ? 'g' : 'a';
      T.innerHTML = `<div>Qty total<b>${(Math.round(q * 1000) / 1000)}</b></div><div class="${cls(sum, P.subtotal)}">Sales subtotal<b>${sum.toFixed(2)}</b></div><div class="${cls(vat, P.vat)}">VAT 5%<b>${vat.toFixed(2)}</b></div><div class="${cls(tot, P.total)}">Invoice total<b>${tot.toFixed(2)}</b></div>`; } }
    $('invSum').innerHTML = `<span class="iv-chip">${rows.length} lines</span>${missingNo.length ? `<span class="iv-chip a">Invoice line ${missingNo.join(', ')} not read — use + Add line</span>` : ''}${rows.some(bad) ? `<span class="iv-chip a">${rows.filter(bad).length} doubtful (amber)</span>` : ''}${nm ? `<span class="iv-chip a">${nm} no match</span>` : ''}<span class="iv-chip">Total ${sum.toFixed(2)}</span>${rc}`;
  }
  function sys(i) {
    const x = rows[i], c = x.pick >= 0 ? x.cands[x.pick].r : null, B = $('invBody');
    const set = (f, html, cls) => B.querySelectorAll(`[data-f="${f}"][data-i="${i}"]`).forEach(el => { el.innerHTML = html; if (cls !== undefined) el.classList.toggle('none', cls); });
    set('code', c ? esc(c.id) : 'No match', !c); set('desc', c ? esc(c.desc) : '— pick an item —'); set('uom', esc(uomOf(x)));
    set('qty', fmt(x.qty)); set('price', money(x.price)); set('amount', money(x.amount));
    set('pnote', '');   // our list price is only a hint for choosing between look-alike codes — never a warning
    B.querySelectorAll(`.iv-card[data-i="${i}"],tr[data-i="${i}"]`).forEach(el => el.classList.toggle('warn', bad(x)));
    B.querySelectorAll(`.iv-nums input[data-i="${i}"]`).forEach(n => { if (document.activeElement !== n) n.value = x[n.dataset.k]; });
    B.querySelectorAll(`[data-f="ph"][data-i="${i}"]`).forEach(el => setPhoto(el, c));
  }
  /* Same photo box as the item list (gradient + emoji while loading, image map first, then the web look-up and the saved cache) */
  function setPhoto(el, c) {
    if (!c) { el.className = 'iv-ph'; el.removeAttribute('data-id'); el.onclick = null; el.innerHTML = '📦'; return; }
    if (el.dataset.id === c.id && el.classList.contains('prod-photo-wrap')) return;   // already showing this item
    let grad = 'linear-gradient(135deg,#1e293b,#334155)', emoji = '📦', q = c.desc;
    try { if (typeof getCatStyle === 'function') [grad, emoji] = getCatStyle(c.desc, c.cat, c.brand); if (typeof buildQuery === 'function') q = buildQuery(c); } catch (e) { }
    el.className = 'prod-photo-wrap iv-pw'; el.dataset.q = q; el.dataset.id = c.id; el.dataset.desc = c.desc; delete el.dataset.obs;
    el.innerHTML = `<div class="prod-photo-bg" style="background:${grad}"></div><div class="prod-photo-emoji">${emoji}</div><img class="prod-photo-img" src="" alt="${esc(c.desc)}"><div class="photo-spinner"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="rgba(255,255,255,0.12)" stroke-width="2"/><path d="M10 2a8 8 0 0 1 8 8" stroke="var(--brand)" stroke-width="2" stroke-linecap="round"/></svg></div><div class="photo-live-dot"></div>`;
    el.onclick = e => { if (typeof handlePhotoClick === 'function') handlePhotoClick(e, el); };
    try { if (typeof rowObserver !== 'undefined') rowObserver.observe(el); } catch (e) { }
  }
  const out = () => rows.map((x, i) => { const c = x.pick >= 0 ? x.cands[x.pick].r : null;
    return { '#': i + 1, 'Invoice No': invNo, 'Our Code': c ? c.id : '', 'Our Item': c ? c.desc : '(NO MATCH)', 'Invoice Item': x.desc, Qty: x.qty, UOM: uomOf(x), 'Invoice Cost': x.price, 'System Cost': c ? c.cost : '', Amount: x.amount }; });
  function exportXls() { if (!rows.length) return; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out()), 'Invoice');
    if (window.InvEngine) { const C = window.InvEngine.checks(rows, printedNums()), P = printedNums(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Check: 'Quantity total', Lines: C.sumQ, Invoice: P.qty ?? '' , OK: C.list[1].ok == null ? '' : C.list[1].ok ? 'YES' : 'NO' }, { Check: 'Sales subtotal', Lines: C.sumA, Invoice: P.subtotal ?? '', OK: C.list[2].ok == null ? '' : C.list[2].ok ? 'YES' : 'NO' }, { Check: 'VAT 5%', Lines: C.vat, Invoice: P.vat ?? '', OK: C.list[3].ok == null ? '' : C.list[3].ok ? 'YES' : 'NO' }, { Check: 'Invoice total', Lines: C.tot, Invoice: P.total ?? '', OK: C.list[4].ok == null ? '' : C.list[4].ok ? 'YES' : 'NO' }]), 'Checks'); } XLSX.writeFile(wb, `invoice-${invNo || 'matched'}.xlsx`); }
  /* One line per item, tab-separated, no header: Code · Item · Qty · UOM · Rate · Amount — paste into a sheet or a QuickBooks grid. */
  function copyQb() {
    if (!rows.length) return; const t = rows.map(x => { const c = x.pick >= 0 ? x.cands[x.pick].r : null; return [c ? c.id : '', c ? c.desc : (x.name || x.desc), fmt(x.qty), uomOf(x), money(x.price), money(x.amount)].join('\t'); }).join('\n'), unm = rows.filter(x => x.pick < 0).length;
    const done = () => status(`Copied ${rows.length} lines (Code · Item · Qty · UOM · Rate · Amount)${unm ? ` — ${unm} without a matching item` : ''}. Now paste.`);
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(done, () => { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { } ta.remove(); });
  }
  function copyTable() { if (!rows.length) return; const o = out(); navigator.clipboard.writeText([Object.keys(o[0]).join('\t'), ...o.map(r => Object.values(r).join('\t'))].join('\n')).then(() => status('Copied — paste into Excel')); }
})();
