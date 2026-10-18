/* Invoice Engine — numbers you can trust.
   Pure functions (no page access), so it can be tested on its own.

   Idea: an invoice is full of numbers that must agree with each other.
        qty × price = amount            (every line)
        Σ qty    = "Quantity" total     (Barakat prints it)
        Σ amount = "Sales subtotal"
        subtotal × 1.05 = invoice total (5% VAT)
   A blurry photo garbles digits ("38.00" → "36.00", "3.50" → "150", decimal point lost "6000").
   So for every line we list every number the garbled text could really be (each guess has a "cost" = how many look-alike
   swaps it needed), then pick the cheapest combination of lines that also makes the invoice totals add up. */
(function (root) {
  const r2 = x => Math.round(x * 100) / 100;
  const LETTERS = { O: '0', o: '0', '°': '0', Q: '0', D: '0', C: '0', I: '1', l: '1', '|': '1', '!': '1', i: '1', T: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };
  /* digits a scan often mixes up, with how likely (lower = more likely) */
  const PAIRS = [['6', '8', .7], ['3', '8', .9], ['0', '8', .9], ['0', '6', .9], ['5', '6', .9], ['1', '3', 1], ['1', '7', 1], ['0', '5', 1], ['4', '8', 1.1], ['3', '5', 1.1], ['8', '9', 1.1], ['4', '9', 1.2], ['0', '9', 1.2], ['2', '7', 1.2], ['3', '4', 1.2]];
  const ALT = {}; PAIRS.forEach(([a, b, c]) => { (ALT[a] = ALT[a] || []).push([b, c]); (ALT[b] = ALT[b] || []).push([a, c]); });
  const MAXC = 2.3;   // a guess needing more swaps than this is not worth listing

  /* ── every value a garbled token could be: [{v, c}] ── */
  function digitVariants(d, exact) {
    const out = new Map([[d, 0]]); if (exact) return out;
    const idx = [...d].map((ch, i) => i);
    idx.forEach(i => (ALT[d[i]] || []).forEach(([b, c]) => { const s = d.slice(0, i) + b + d.slice(i + 1); if (c <= MAXC && (!out.has(s) || out.get(s) > c)) out.set(s, c); }));
    const first = [...out].filter(([s]) => s !== d);
    first.forEach(([s, c1]) => idx.forEach(i => { if (s[i] !== d[i]) return; (ALT[s[i]] || []).forEach(([b, c2]) => { const t = s.slice(0, i) + b + s.slice(i + 1), c = c1 + c2; if (c <= MAXC && !out.has(t)) out.set(t, c); }); }));
    return out;
  }
  function numCands(raw, o = {}) {
    let t = String(raw == null ? '' : raw).trim();
    if (!t || /[%\/]/.test(t)) return [];
    t = t.replace(/^[^0-9A-Za-z.,|!°]+|[^0-9A-Za-z.,|!°]+$/g, '');
    if (!t) return [];
    let s = '', junk = 0;
    for (const ch of t) { if (/\d|[.,]/.test(ch)) s += ch; else if (LETTERS[ch]) { s += LETTERS[ch]; junk += .3; } else return []; }
    if (!/\d/.test(s) || junk > .7) return [];
    let m, intp, decp = null;
    if ((m = s.match(/^([\d.,]*\d)[.,](\d{1,2})$/))) { intp = m[1].replace(/[.,]/g, ''); decp = m[2]; }
    else if ((m = s.match(/^(\d{1,3}(?:[.,]\d{3})+)$/)) && /,/.test(s)) intp = m[1].replace(/[.,]/g, '');   // 1,321 → 1321
    else if (/[.,]/.test(s)) { if (/^\d*[.,]\d{3,}$/.test(s)) { decp = s.split(/[.,]/).pop(); intp = s.slice(0, s.length - decp.length - 1).replace(/[.,]/g, ''); decp = decp.slice(0, 2); } else intp = s.replace(/[.,]/g, ''); }
    else intp = s;
    if (!intp && decp == null) return [];
    const out = new Map(), put = (v, c) => { if (!(v > 0 && v < 1e7) || c > MAXC) return; v = r2(v); if (!out.has(v) || out.get(v) > c) out.set(v, c); };
    const base = o.exact ? 0 : junk;
    const digits = (intp || '0') + (decp != null ? decp : '');
    digitVariants(digits, o.exact).forEach((c, ds) => {
      const L = ds.length;
      if (decp != null) {   // the point is printed: use it  ("22.0" → 22.00)
        const di = L - decp.length, v = parseFloat(ds.slice(0, di) + '.' + ds.slice(di));
        put(v, base + c + (decp.length === 1 ? .1 : 0));
      } else if (L >= 3) {  // no point: invoices print 2 decimals, so the point was probably lost  ("6000" → 60.00)
        put(parseInt(ds, 10) / 100, base + c + .2); put(parseInt(ds, 10), base + c + 1.1);
        if (L === 3) put(parseInt(ds, 10) / 10, base + c + 1.4);
      } else if (L === 2) {
        put(parseInt(ds, 10), base + c + .3); put(parseInt(ds, 10) / 100, base + c + .7); put(parseInt(ds, 10) / 10, base + c + .9);
      } else put(parseInt(ds, 10), base + c + .2);
    });
    if (o.exact) { const v = parseFloat(String(raw)); if (v > 0) [-2, -1, 1, 2].forEach(k => put(v * Math.pow(10, k), 1.4 * Math.abs(k))); }   // an exact reading can still lose / gain a decimal point
    return [...out].map(([v, c]) => ({ v, c })).sort((a, b) => a.c - b.c);
  }
  const niceQ = q => q >= 0.05 && q <= 5000 && Math.abs(q * 20 - Math.round(q * 20)) < 1e-6;
  const niceP = p => p >= 0.05 && Math.abs(p * 100 - Math.round(p * 100)) < 1e-6;
  const pPen = p => (Math.abs(p - Math.round(p)) < 1e-6 ? 0 : Math.abs(p * 2 - Math.round(p * 2)) < 1e-6 ? .2 : Math.abs(p * 4 - Math.round(p * 4)) < 1e-6 ? .45 : .9);   // prices are usually whole numbers, then .5, then .25
  const qPen = q => (Math.abs(q * 2 - Math.round(q * 2)) < 1e-6 ? 0 : Math.abs(q * 10 - Math.round(q * 10)) < 1e-6 ? .25 : .6);   // quantities are usually whole / half kilos

  /* ── every sensible (qty, price, amount) for one line, cheapest first ──
     row.reads = one entry per reader pass: { q: "6000", n: ["600", "000", "360.00"], exact: false } */
  function rowTriples(row, keep = 12) {
    const reads = row.reads || [], Q = [], N = [];
    reads.forEach((rd, pi) => {
      const o = { exact: !!rd.exact }, last = (rd.n || []).length - 1;
      if (rd.q != null && rd.q !== '') numCands(rd.q, o).forEach(x => niceQ(x.v) && Q.push({ ...x, p: pi }));
      (rd.n || []).forEach((t, ti) => numCands(t, o).forEach(x => N.push({ ...x, p: pi, ti, last: ti === last, only: last === 0 })));
    });
    const best = new Map(), put = (q, p, a, c) => { if (!(c <= 4.2)) return; const k = q + '|' + p + '|' + a, e = best.get(k); if (!e || e.c > c) best.set(k, { q, p, a, c: Math.round(c * 100) / 100 }); };
    const byA = new Map(); N.forEach(x => { const k = Math.round(x.v * 100); (byA.get(k) || byA.set(k, []).get(k)).push(x); });
    Q.forEach(q => { if (q.c > 1.8) return; N.forEach(p => {
      if (p.c > 1.8 || q.c + p.c > 3.2 || p.v < .05 || (p.last && !p.only)) return;   // the right-most number is the amount, never the price
      const t = q.v * p.v, k0 = Math.round(t * 100);
      for (const d of [-1, 0, 1]) (byA.get(k0 + d) || []).forEach(a => {
        if (a.p === p.p && a.ti <= p.ti) return;           // within one reading the amount stands to the right of the price
        if (Math.abs(t - a.v) > .0105) return;
        put(q.v, p.v, a.v, q.c + p.c + a.c + pPen(p.v) + qPen(q.v) + (a.last ? 0 : .4));
      });
    }); });
    /* one of the three unreadable → work it out from the other two (a little dearer). The amount is the right-most number. */
    const lowQ = Q.filter(x => x.c <= 1.2), lowN = N.filter(x => x.c <= 1.2), hasLast = lowN.some(x => x.last && !x.only);
    lowQ.forEach(q => lowN.forEach(p => { if (p.last && !p.only) return; const a = r2(q.v * p.v); if (a > 0 && a < 1e6 && niceP(p.v)) put(q.v, p.v, a, q.c + p.c + 1.5 + (hasLast ? 1.4 : 0) + pPen(p.v) + qPen(q.v)); }));   // an amount WAS read: a worked-out amount that disagrees with it is unlikely
    lowQ.forEach(q => lowN.forEach(a => { if (!a.last) return; const p = a.v / q.v; if (r2(p) >= .5 && Math.abs(p - r2(p)) < 1e-6 && Math.abs(p * 2 - Math.round(p * 2)) < 1e-6) put(q.v, r2(p), a.v, q.c + a.c + 1.5 + pPen(p) + qPen(q.v)); }));
    lowN.forEach(p => lowN.forEach(a => { if (!a.last || a === p || a.v <= p.v || (a.p === p.p && a.ti <= p.ti)) return; const q = a.v / p.v; if (niceQ(r2(q)) && Math.abs(q - r2(q)) < 1e-6) put(r2(q), p.v, a.v, p.c + a.c + 1.6 + pPen(p.v) + qPen(r2(q))); }));
    return [...best.values()].sort((x, y) => x.c - y.c || y.a - x.a).slice(0, keep);
  }

  /* ── pick one reading per line so that the whole invoice adds up ──
     rows: [{cands:[{q,p,a,c}]}]  printed: { S:[{v,c}] subtotal, Q:[{v,c}] qty total }  → { picks:[index|-1], sumQ, sumA, sMatch, qMatch, cost } */
  const PEN_S = 6, PEN_Q = 3;
  function decode(rows, printed = {}) {
    let states = new Map([['0|0', { c: 0, pick: [] }]]);
    rows.forEach(r => {
      let opts = (r.tri || []).map((x, i) => ({ x, i }));
      if (!opts.length) { states.forEach(s => s.pick.push(-1)); return; }
      if (opts.length > 1 && opts[0].x.c <= .3 && opts[1].x.c - opts[0].x.c >= .8) opts = [opts[0]];   // a line that already multiplies out cleanly is left alone (so one missing line can never be hidden by bending others)   // very sure → no need to explore alternatives
      if (r.drop != null) opts = [...opts, { x: { q: 0, a: 0, c: r.drop }, i: -1 }];                      // a line seen only once may be a stray bit of text
      const next = new Map();
      states.forEach((s, key) => { const [qu, ac] = key.split('|').map(Number);
        opts.forEach(({ x, i }) => { const k = (qu + Math.round(x.q * 20)) + '|' + (ac + Math.round(x.a * 100)), c = s.c + x.c, e = next.get(k);
          if (!e || e.c > c) next.set(k, { c, pick: [...s.pick, i < 0 ? -2 : i] }); }); });
      states = next;
      if (states.size > 30000) states = new Map([...states].sort((a, b) => a[1].c - b[1].c).slice(0, 30000));
    });
    const S = printed.S || [], Qs = printed.Q || []; let best = null;
    states.forEach((s, key) => {
      const [qu, ac] = key.split('|').map(Number), sumQ = qu / 20, sumA = ac / 100;
      const sm = S.filter(x => Math.abs(x.v - sumA) <= .06).sort((a, b) => a.c - b.c)[0], qm = Qs.filter(x => Math.abs(x.v - sumQ) <= .006).sort((a, b) => a.c - b.c)[0];
      const total = s.c + (S.length ? (sm ? sm.c : PEN_S) : 0) + (Qs.length ? (qm ? qm.c : PEN_Q) : 0);
      if (!best || total < best.cost - 1e-9) best = { picks: s.pick, sumQ, sumA, sMatch: !!sm, qMatch: !!qm, cost: total, rowCost: s.c };
    });
    return best || { picks: rows.map(() => -1), sumQ: 0, sumA: 0, sMatch: false, qMatch: false, cost: 0, rowCost: 0 };
  }

  /* ── one text line of a table → a line with its raw readings (layout: [item no] name [date] qty UNIT price [disc] [disc%] amount [tax%]) ── */
  const UNIT = /^(k[a-z|1l9]{1,2}|kgs?|pcs?|pies|pkt|pk|box|bunch|ctn|ltr|ea|doz)\.?$/i;
  const UNITNAME = u => { u = u.toLowerCase(); return /^(pc|pie|ea)/.test(u) ? 'Pcs' : /^pk/.test(u) ? 'Pkt' : /^box/.test(u) ? 'Box' : /^bunch/.test(u) ? 'Bunch' : /^ltr/.test(u) ? 'Ltr' : /^ctn/.test(u) ? 'Carton' : /^doz/.test(u) ? 'Doz' : 'Kg'; };
  const SKIPLINE = /^(sub ?total|total|sales|tax|vat|grand|currency|amount|description|item|print|code|discount|quantity|charges|net|round)/i;
  const isDateTok = t => (t.match(/\//g) || []).length >= 2 || /^\/\d/.test(t) || /\/\d{3,4}\w?$/.test(t) || /^\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$/.test(t);
  function rowFromLine(raw) {
    const line = String(raw).replace(/\s+$/, ''); if (line.trim().length < 10 || SKIPLINE.test(line.trim())) return null;
    const toks = [...line.matchAll(/\S+/g)].map(m => ({ t: m[0].replace(/^[|\[(!]+|[|\])]+$/g, ''), i: m.index })).filter(x => x.t && !/^(jpe?g|png)$/i.test(x.t));   // pasted from a chat: image tags are not data
    for (let k = 1; k < toks.length - 1; k++) {
      if (!UNIT.test(toks[k].t)) continue;
      const qt = toks[k - 1].t; if (isDateTok(qt) || !numCands(qt).length) continue;
      let right = toks.slice(k + 1).map(x => x.t);
      while (right.length && /%/.test(right[right.length - 1])) right.pop();
      if (right.length && /^[5SsO0]$/.test(right[right.length - 1]) && right.length >= 3) right.pop();   // "5%" whose % was lost
      if (right.length >= 2 && /^\d{2,5}$/.test(right[right.length - 2]) && /^\d{2}$/.test(right[right.length - 1])) right.splice(-2, 2, right[right.length - 2] + '.' + right[right.length - 1]);   // "360 00" → 360.00
      right = right.filter(t => !/%/.test(t));
      const n = right.filter(t => !/^[0Oo]+([.,][0Oo]+)?$/.test(t) && numCands(t).length); if (!n.length) continue;   // 0.00 = discount column, not a number we need
      /* name = the run of word-like tokens left of the date / quantity */
      let left = toks.slice(0, k - 1).map(x => x.t), no = '';
      const di = left.findIndex(isDateTok); if (di >= 0) left = left.slice(0, di);
      if (left.length > 1 && /^[0-9A-Za-z|!]{5,7}$/.test(left[0]) && (left[0].match(/[0-9OTIlGSB|]/g) || []).length >= 4) no = left.shift().replace(/[OoQD]/g, '0').replace(/[TIl|!]/g, '1').replace(/[Ss]/g, '5').replace(/[Bb]/g, '8').replace(/\D/g, '');
      left = left.filter(t => (t.match(/[A-Za-z]/g) || []).length >= Math.max(2, t.length * .6));
      if (left.length > 1 && /^[TIl1OoVv]{1,3}$/.test(left[left.length - 1])) left.pop();   // garbled date
      const desc = left.join(' ').replace(/\s+/g, ' ').trim();
      if (!/[a-z]{3}/i.test(desc) || SKIPLINE.test(desc)) return null;
      return { desc, descs: [desc], itemNo: /^\d{5,7}$/.test(no) ? no : '', unit: UNITNAME(toks[k].t), reads: [{ q: qt, n }], raw: line.trim() };
    }
    return null;
  }

  /* ── the totals printed under the table: subtotal, VAT, total (and quantity total) ── */
  function parsePrinted(lines, vatRate = .05) {
    const toks = []; let on = false;
    lines.forEach((l, li) => {
      if (/al aweer|p\.?o\.? ?box: ?\d|@\w+\.\w+|contact@/i.test(l)) { on = false; return; }
      if (/sales\s*tax|subtotal|round|total|currency|net\s*amount|amount\s*origin|quantity|\bAED\b|SR\w{3,}/i.test(l)) on = true;
      if (!on) return;
      l.split(/\s+/).forEach(t => { const c = numCands(t.replace(/^[^\w]+|[^\w%]+$/g, '')); if (c.length) toks.push({ t, c, li }); });
    });
    const out = { S: [], Q: [], V: [], T: [] };
    if (!toks.length) return out;
    const all = []; toks.forEach((x, ti) => x.c.forEach(c => c.v >= 5 && all.push({ ...c, ti })));
    let bestPair = null;
    all.forEach(s => all.forEach(t => { if (s.ti === t.ti || t.v <= s.v) return;
      if (Math.abs(r2(s.v * (1 + vatRate)) - t.v) > .0105) return; const c = s.c + t.c; if (!bestPair || c < bestPair.c) bestPair = { s, t, c }; }));
    if (bestPair) {
      out.S.push({ v: bestPair.s.v, c: Math.max(0, bestPair.s.c - .5) }); out.T.push({ v: bestPair.t.v, c: bestPair.t.c }); out.V.push({ v: r2(bestPair.t.v - bestPair.s.v), c: 0 });
      /* the same subtotal read elsewhere on the page gives a second opinion (Barakat prints it three times) */
      all.forEach(x => { if (x.ti !== bestPair.s.ti && Math.abs(x.v - bestPair.s.v) < .006 && x.c <= .5) out.S[0].c = Math.max(0, out.S[0].c - .3); });
      /* quantity total: printed as  <amount origin> <QUANTITY> <sales tax amount>  — it is the number just left of the VAT figure */
      const vi = toks.findIndex(x => x.c.some(c => Math.abs(c.v - out.V[0].v) <= .2));
      if (vi > 0 && toks[vi - 1].li === toks[vi].li) toks[vi - 1].c.forEach(c => { if (c.v > .5 && c.v < bestPair.s.v && c.c <= 1.6) out.Q.push({ v: c.v, c: c.c + .3 }); });
      else all.forEach(x => { if (x.ti !== bestPair.s.ti && x.ti !== bestPair.t.ti && x.v > 0.5 && x.v < bestPair.s.v && x.c <= 1.2) out.Q.push({ v: x.v, c: x.c + 1.4 }); });
    } else {
      all.forEach(x => { if (x.c <= .6) out.S.push({ v: x.v, c: x.c + 2 }); });
    }
    const seen = new Set(); out.Q = out.Q.filter(x => { const k = x.v; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.c - b.c).slice(0, 25);
    return out;
  }

  /* ── the checks shown to the person (✓ / ✗) ── */
  function checks(rows, printed, vatRate = .05) {
    const sumQ = r2(rows.reduce((t, x) => t + (+x.qty || 0), 0)), sumA = r2(rows.reduce((t, x) => t + (+x.amount || 0), 0));
    const badLines = rows.filter(x => !(Math.abs(x.qty * x.price - x.amount) <= .02 + x.amount * .004));
    const vat = r2(sumA * vatRate), tot = r2(sumA + vat);
    const P = printed || {}, has = k => P[k] != null && P[k] !== '' && !isNaN(P[k]);
    const cmp = (label, got, want, tol) => ({ label, got, want: has(want) ? +P[want] : null, ok: has(want) ? Math.abs(got - P[want]) <= tol : null });
    const list = [
      { label: 'Every line: qty × price = amount', got: rows.length - badLines.length, want: rows.length, ok: badLines.length === 0, text: badLines.length ? badLines.length + ' line(s) do not multiply out' : 'all ' + rows.length + ' lines multiply out' },
      cmp('Quantity total', sumQ, 'qty', .006), cmp('Sales subtotal', sumA, 'subtotal', .06), cmp('VAT ' + Math.round(vatRate * 100) + '%', vat, 'vat', .06), cmp('Invoice total', tot, 'total', .06)
    ];
    return { list, sumQ, sumA, vat, tot, bad: badLines, allOk: list.every(x => x.ok !== false) && list.some((x, i) => i > 0 && x.ok === true) };
  }


  /* ── several reader passes of the same page → one list of lines (reads of the same line are put together) ── */
  const tri = s => { s = ' ' + String(s).toLowerCase().replace(/[^a-z]/g, '') + ' '; const m = new Map(); for (let i = 0; i < s.length - 2; i++) m.set(s.substr(i, 3), (m.get(s.substr(i, 3)) || 0) + 1); return m; };
  const dice = (a, b) => { const A = tri(a), B = tri(b); let i = 0, na = 0, nb = 0; A.forEach(v => na += v); B.forEach(v => nb += v); A.forEach((v, k) => i += Math.min(v, B.get(k) || 0)); return na + nb ? 2 * i / (na + nb) : 0; };
  const clean = r => { const set = new Set(); (r.reads || []).forEach(rd => (rd.n || []).concat(rd.q == null ? [] : [rd.q]).forEach(t => { const c = numCands(t); if (c[0] && c[0].c <= .35) set.add(c[0].v); })); return set; };
  function rowSim(a, b) {
    const L = s => (String(s).match(/[A-Za-z]/g) || []).length, d = L(a.desc) >= 3 && L(b.desc) >= 3 ? dice(a.desc, b.desc) : 0;
    const A = clean(a), B = clean(b); let sh = 0; A.forEach(v => { if (B.has(v)) sh++; }); const nm = sh ? sh / Math.max(1, Math.min(A.size, B.size)) : 0;
    let no = 0; if (a.itemNo && b.itemNo && a.itemNo.length === b.itemNo.length) { let e = 0; for (let i = 0; i < a.itemNo.length; i++) if (a.itemNo[i] === b.itemNo[i]) e++; no = e >= a.itemNo.length - 1 ? .9 : 0; }
    return Math.max(d, .45 * d + .55 * nm, no, nm * .8);
  }
  function mergeRows(base, more) {   // Needleman–Wunsch: keeps the order of the invoice, inserts lines only one pass saw
    const n = base.length, m = more.length, GAP = -.3, M = Array.from({ length: n + 1 }, () => new Float32Array(m + 1)), T = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
    for (let i = 1; i <= n; i++) { M[i][0] = i * GAP; T[i][0] = 1; } for (let j = 1; j <= m; j++) { M[0][j] = j * GAP; T[0][j] = 2; }
    const sc = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => rowSim(base[i], more[j])));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const diag = M[i - 1][j - 1] + (sc[i - 1][j - 1] >= .4 ? sc[i - 1][j - 1] * 2 - .2 : -1), up = M[i - 1][j] + GAP, left = M[i][j - 1] + GAP;
      if (diag >= up && diag >= left) { M[i][j] = diag; T[i][j] = 0; } else if (up >= left) { M[i][j] = up; T[i][j] = 1; } else { M[i][j] = left; T[i][j] = 2; }
    }
    const out = []; let i = n, j = m;
    while (i > 0 || j > 0) {
      const t = T[i][j];
      if (i > 0 && j > 0 && t === 0) { const a = base[i - 1], b = more[j - 1]; if (sc[i - 1][j - 1] >= .4) { a.reads.push(...b.reads); a.support = (a.support || 1) + (b.support || 1); if (b.desc.length > a.desc.length * .9 && /^[A-Z][a-z]/.test(b.desc) && dice(b.desc, a.desc) >= .2) a.descs = [...new Set([...(a.descs || [a.desc]), b.desc])]; if (!a.itemNo && b.itemNo) a.itemNo = b.itemNo; out.push(a); } else { out.push(b, a); } i--; j--; }
      else if (i > 0 && (j === 0 || t === 1)) { out.push(base[i - 1]); i--; } else { out.push(more[j - 1]); j--; }
    }
    return out.reverse();
  }
  /* The best reading of a line's name: the one most of the passes agree with */
  function bestDesc(r) {
    const ds = (r.descs && r.descs.length ? r.descs : [r.desc]); if (ds.length < 2) return ds[0];
    let b = ds[0], bs = -1; ds.forEach(d => { let s = 0; ds.forEach(e => { if (e !== d) s += dice(d, e); }); s += Math.min(L2(d), 14) * .01; if (s > bs) { bs = s; b = d; } }); return b;
  }
  const L2 = s => (String(s).match(/[A-Za-z]/g) || []).length;

  /* our own price list is a strong hint: a price close to what we normally pay is more likely right than one 10× off */
  function applyRef(row) {
    if (!row.ref || !(row.ref > 0) || !row.tri) return;
    row.tri.forEach(c => { if (c.ref === row.ref) return; const d = Math.abs(c.p - row.ref) / row.ref; c.ref = row.ref; c.c = Math.max(0, Math.round((c.c + (d <= .02 ? -1.3 : d <= .1 ? -.6 : d > .3 ? .9 : 0)) * 100) / 100); });
    row.tri.sort((a, b) => a.c - b.c);
  }

  /* totals still wrong after the best reading? maybe a whole line was never read: what would it have to be? */
  function missingLine(sumQ, sumA, P) {
    const wantA = P.S && P.S[0], wantQ = P.Q && P.Q[0]; if (!wantA) return null;
    const dA = r2(wantA.v - sumA); if (!(dA > .5)) return null;
    let dq = null; (P.Q || []).forEach(x => { const d = r2(x.v - sumQ); if (d > 0 && niceQ(d) && Math.abs(dA / d - Math.round(dA / d * 4) / 4) < 1e-6) { if (!dq || x.c < dq.c) dq = { d, c: x.c }; } });
    return dq ? { qty: dq.d, amount: dA, price: r2(dA / dq.d) } : { amount: dA };
  }
  function mergePrinted(list) {
    const out = { S: [], Q: [], V: [], T: [] };
    ['S', 'Q', 'V', 'T'].forEach(k => { const m = new Map(); list.forEach(p => (p[k] || []).forEach(x => { const e = m.get(x.v); if (!e) m.set(x.v, { v: x.v, c: x.c, n: 1 }); else { e.c = Math.min(e.c, x.c) - .2; e.n++; } })); out[k] = [...m.values()].map(x => ({ v: x.v, c: Math.max(0, x.c) })).sort((a, b) => a.c - b.c); if (k === 'Q') out[k] = out[k].slice(0, 20); });
    return out;
  }

  root.InvEngine = { applyRef, mergeRows, bestDesc, missingLine, mergePrinted, numCands, rowTriples, decode, rowFromLine, parsePrinted, checks, niceQ, niceP, r2 };
})(typeof window !== 'undefined' ? window : globalThis);
