// 匯入券商對帳單：在你的裝置上讀檔、解析，不會上傳檔案或密碼
// 目前支援：國泰證券 App 匯出的「客戶交易明細表」PDF
(function (root) {
  'use strict';
  const BASE = (typeof document !== 'undefined' && document.currentScript) ? document.currentScript.src.replace(/[^/]*$/, '') : './';
  let pdfjsP = null;
  function pdfjs() {
    if (!pdfjsP) pdfjsP = import(BASE + 'vendor/pdfjs/pdf.min.mjs').then(m => {
      m.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdfjs/pdf.worker.min.mjs';
      return m;
    });
    return pdfjsP;
  }

  // 讀 PDF 的文字，依座標排成一行一行；同一行裡相鄰的字併成一個「詞」，保留左右邊界
  async function readPdf(buf, password, lib) {
    const P = lib || await pdfjs();
    let doc;
    try {
      doc = await P.getDocument({data: new Uint8Array(buf), password: password || undefined, cMapUrl: BASE + 'vendor/pdfjs/cmaps/', cMapPacked: true,
        isEvalSupported: false, disableFontFace: true, useSystemFonts: false}).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') { const x = new Error(e.code === 2 ? 'wrong-password' : 'need-password'); x.code = e.code === 2 ? 'WRONG_PW' : 'NEED_PW'; throw x; }
      throw e;
    }
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), tc = await page.getTextContent();
      const rows = [];
      tc.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const y = it.transform[5], x = it.transform[4];
        let r = rows.find(z => Math.abs(z.y - y) < 2);
        if (!r) rows.push(r = {y: y, its: []});
        r.its.push({s: it.str, l: x, r: x + it.width});
      });
      rows.sort((a, b) => b.y - a.y);
      pages.push(rows.map(r => {
        r.its.sort((a, b) => a.l - b.l);
        const toks = [];
        r.its.forEach(it => {
          const t = toks[toks.length - 1];
          if (t && it.l - t.r < 1.5) { t.s += it.s; t.r = it.r; } else toks.push({s: it.s, l: it.l, r: it.r});
        });
        return toks.map(t => ({s: t.s.trim(), l: t.l, r: t.r})).filter(t => t.s && !/^-+$/.test(t.s));
      }).filter(l => l.length));
      page.cleanup();
    }
    await doc.destroy();
    return pages;
  }

  const num = s => { const v = Number(String(s).replace(/,/g, '').replace(/\((收|付)\)$/, '')); return isFinite(v) ? v : NaN; };
  const roc = s => { const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(s); return m ? (+m[1] + 1911) + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : ''; };

  // 國泰「客戶交易明細表」
  // 欄位：交易日期 CD 股票名稱 股數 單價 手續費 交易稅 證所稅 融券手續費 利息 預收/留置款 價金 淨收付金額 委託書號
  // 數字都靠右對齊在表頭的右邊界，所以依右邊界把數字歸到對應的欄位
  const CATHAY_COLS = [['shares', '股數'], ['price', '單價'], ['fee', '手續費'], ['tax', '交易稅'], ['cgt', '證所稅'], ['sfee', '融券手續費'],
    ['int', '利息'], ['hold', '預收/留置款'], ['amt', '金'], ['net', '淨收付金額']];
  const CD = {'買': {item: '買進'}, '賣': {item: '賣出'}, '資買': {item: '融資買進', credit: true}, '資賣': {item: '融資賣出', credit: true},
    '券賣': {item: '融券賣出', credit: true}, '券買': {item: '融券買進', credit: true}};
  function isCathay(pages) {
    const t = pages.slice(0, 1).flat().map(l => l.map(x => x.s).join(' ')).join('\n');
    return /國泰綜合證券/.test(t) && /客戶交易明細表/.test(t);
  }
  function parseCathay(pages) {
    const out = {broker: '國泰證券', kind: '客戶交易明細表', rows: [], warnings: [], total: null, count: null, range: null};
    let cols = null;
    pages.forEach((lines, pi) => {
      lines.forEach(toks => {
        const text = toks.map(t => t.s).join(' ');
        if (/交易日期/.test(text) && /委託書號/.test(text) && /股數/.test(text)) {
          cols = CATHAY_COLS.map(([k, h]) => { const t = toks.find(x => x.s === h || x.s.replace(/\s/g, '') === h); return t ? {k: k, r: t.r} : null; }).filter(Boolean);
          return;
        }
        const rg = /交易日期[:：]\s*(\d{2,3}\/\d{1,2}\/\d{1,2})\s*-?\s*(\d{2,3}\/\d{1,2}\/\d{1,2})/.exec(text);
        if (rg) { out.range = [roc(rg[1]), roc(rg[2])]; return; }
        if (/^合\s*計/.test(text) && cols) {
          const tt = {};
          toks.slice(1).forEach(t => { const c = nearest(cols, t.r); if (c) tt[c] = num(t.s); });
          out.total = tt; return;
        }
        const cn = /交易筆數[:：]?\s*(\d+)/.exec(text);
        if (cn) { out.count = +cn[1]; return; }
        if (!cols || !toks.length || !roc(toks[0].s)) return;
        const r = {page: pi + 1, raw: text, date: roc(toks[0].s), cd: toks[1] ? toks[1].s : ''};
        // 股票名稱：CD 之後、第一個數字欄之前的字
        const firstNum = toks.findIndex((t, i) => i >= 2 && nearest(cols, t.r) && /^[\d,.]+(\((收|付)\))?$/.test(t.s));
        r.name = toks.slice(2, firstNum < 0 ? toks.length : firstNum).map(t => t.s).join('');
        toks.slice(firstNum < 0 ? toks.length : firstNum).forEach(t => {
          if (/^[A-Za-z]+-[\w-]+$/.test(t.s)) { r.orderNo = t.s; return; }
          const c = nearest(cols, t.r); if (!c) return;
          r[c] = num(t.s);
          if (c === 'net') r.sf = (/\((收|付)\)/.exec(t.s) || [])[1] || '';
        });
        const m = /^(集|OT|興|零)?(資買|資賣|券賣|券買|買|賣)$/.exec(r.cd);
        r.market = m ? ({'集': '上市', 'OT': '上櫃', '興': '興櫃'}[m[1]] || '') : '';
        const k = m ? CD[m[2]] : null;
        r.item = k ? k.item : '';
        r.credit = !!(k && k.credit);
        ['fee', 'tax', 'cgt', 'sfee', 'int', 'hold'].forEach(f => { if (!(r[f] >= 0)) r[f] = 0; });
        // 檢查：一般買賣的淨收付 = 價金 ± 手續費、稅
        r.issues = [];
        if (!r.item) r.issues.push('不認得的交易類別「' + r.cd + '」');
        if (!(r.shares > 0) || !(r.price > 0) || !(r.amt > 0)) r.issues.push('股數、價格或價金讀不到');
        else if (!r.credit) {
          const want = r.item === '買進' ? r.amt + r.fee : r.amt - r.fee - r.tax - r.cgt;
          if (want !== r.net) r.issues.push('淨收付金額對不上（' + r.net + '，應為 ' + want + '）');
          if (Math.abs(Math.round(r.shares * r.price) - r.amt) > 1) r.issues.push('股數 × 價格和價金不一致');
        } else r.issues.push('融資融券的匯入還在測試，請確認數字');
        if (r.int || r.hold || r.sfee || r.cgt) r.issues.push('有利息、融券費或預收款，請確認');
        out.rows.push(r);
      });
    });
    if (!cols) out.warnings.push('找不到表頭，可能不是國泰的「客戶交易明細表」');
    if (out.count !== null && out.count !== out.rows.length) out.warnings.push('對帳單寫 ' + out.count + ' 筆，但只讀到 ' + out.rows.length + ' 筆');
    if (out.total) {
      const s = f => out.rows.reduce((a, r) => a + (r[f] || 0), 0);
      out.check = [['fee', '手續費'], ['tax', '交易稅'], ['amt', '價金']].filter(([f]) => out.total[f] !== undefined)
        .map(([f, n]) => ({name: n, file: out.total[f], got: s(f), ok: out.total[f] === s(f)}));
      out.check.filter(c => !c.ok).forEach(c => out.warnings.push(c.name + '合計對不上（對帳單 ' + c.file + '，讀到 ' + c.got + '）'));
    }
    return out;
  }
  function nearest(cols, r) {
    let best = null, d = 9;
    cols.forEach(c => { const x = Math.abs(c.r - r); if (x < d) { d = x; best = c.k; } });
    return best;
  }

  // 股票名稱 → 代號（用全市場代號表）。名稱後面的 * 等符號會先去掉再比
  function resolveCode(name, market, list) {
    const clean = s => String(s).replace(/[*＊\s]/g, '');
    const n = clean(name);
    let hit = list.filter(x => clean(x[1]) === n);
    if (hit.length > 1 && market) hit = hit.filter(x => x[2] === market);
    return hit.length === 1 ? {code: hit[0][0], name: hit[0][1], market: hit[0][2]} : null;
  }

  // 當沖：一般股票賣出的交易稅是 0.15%（不是 0.3%），同一天同一檔的買進也一起標記
  function markDayTrade(rows) {
    const isEtf = c => /^0/.test(c || '');
    const dt = new Set();
    rows.forEach(r => {
      if (r.item !== '賣出' || !r.code || isEtf(r.code) || !(r.amt > 0)) return;
      const half = Math.floor(r.amt * 0.0015), full = Math.floor(r.amt * 0.003);
      if (r.tax === half && half !== full) { r.dayTrade = true; dt.add(r.date + '|' + r.code); }
    });
    rows.forEach(r => { if (r.item === '買進' && dt.has(r.date + '|' + r.code)) r.dayTrade = true; });
  }

  async function parseFile(file, password, opts) {
    const o = opts || {};
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { const e = new Error('目前只支援國泰證券 App 匯出的 PDF'); e.code = 'FORMAT'; throw e; }
    const pages = await readPdf(await file.arrayBuffer(), password, o.lib);
    if (!isCathay(pages)) { const e = new Error('看不出是哪家券商的對帳單。目前支援國泰證券 App 匯出的「客戶交易明細表」'); e.code = 'UNKNOWN'; throw e; }
    const res = parseCathay(pages);
    res.rows.forEach(r => {
      const s = o.symbols ? resolveCode(r.name, r.market, o.symbols) : null;
      if (s) { r.code = s.code; r.fullName = s.name + '（' + s.code + '）'; if (r.market && s.market !== r.market) r.issues.push('市場別不同（對帳單：' + r.market + '，代號表：' + s.market + '）'); }
    });
    markDayTrade(res.rows);
    return res;
  }

  const api = {readPdf, parseCathay, isCathay, resolveCode, markDayTrade, parseFile};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ZQImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
