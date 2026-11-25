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
        r.its.push({s: it.str.normalize ? it.str.normalize('NFKC') : it.str, l: x, r: x + it.width});
      });
      rows.sort((a, b) => b.y - a.y);
      pages.push(rows.map(r => {
        r.its.sort((a, b) => a.l - b.l);
        const toks = [];
        r.its.forEach(it => {
          const t = toks[toks.length - 1];
          if (t && it.l - t.r < 1.5) { t.s += it.s; t.r = it.r; } else toks.push({s: it.s, l: it.l, r: it.r});
        });
        return toks.map(t => ({s: t.s.trim(), l: t.l, r: t.r, y: r.y})).filter(t => t.s && !/^-+$/.test(t.s));
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

  // ================= 元大電子月對帳單（PDF）=================
  // 每筆兩行：上行「成交日期 交易類別 幣別 買賣 代號 … 股數 單價 成交金額 手續費 交易稅 客戶淨收（付）」，下行「交割日期 股票名稱」
  // 數字欄不一定和日期同一行（垂直置中），所以用兩個日期的高度圈出一筆的範圍
  function isYuantaStmt(pages) {
    const t = pages.flat().map(l => l.map(x => x.s).join('')).join('\n');
    return /客戶淨收/.test(t) && /(代繳交易稅|代繳)/.test(t) && /(交割日期|交易明細)/.test(t);
  }
  function parseYuantaStmt(pages) {
    const out = {broker: '元大證券', kind: '電子月對帳單', rows: [], warnings: [], check: null};
    const reDate = /^(\d{4}|\d{2,3})\/(\d{1,2})\/(\d{1,2})$/;
    const toDate = s => { const m = reDate.exec(s); if (!m) return ''; const y = m[1].length === 4 ? +m[1] : +m[1] + 1911; return y + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0'); };
    const isNum = s => /^\(?-?[\d,]+(\.\d+)?\)?$/.test(s);
    const nv = s => Number(String(s).replace(/[(),]/g, ''));
    let totAmt = 0, totFee = 0, totTax = 0, hasTot = false;
    pages.forEach((lines, pi) => {
      const toks = lines.flat();
      // 合計列
      lines.forEach(l => {
        const t = l.map(x => x.s).join('');
        if (/合計/.test(t) && /成交金額/.test(t)) {
          const g = re => { const m = re.exec(t); return m ? nv(m[1]) : 0; };
          totAmt += g(/成交金額[:：]?([\d,]+)/); totFee += g(/手續費[:：]?([\d,]+)/); totTax += g(/交易稅[:：]?([\d,]+)/); hasTot = true;
        }
      });
      // 左欄的日期，兩兩一組
      const dates = toks.filter(t => reDate.test(t.s)).sort((a, b) => b.y - a.y);
      if (!dates.length) return;
      const minL = Math.min(...dates.map(d => d.l));
      const left = dates.filter(d => d.l - minL < 20);
      for (let i = 0; i < left.length; i++) {
        const a = left[i], b = left[i + 1];
        const lh = b ? a.y - b.y : 0;
        if (!b || lh > 30 || lh <= 0) continue;
        i++;
        const lo = b.y - lh * 0.6, hi = a.y + lh * 0.6;
        const band = toks.filter(t => t.y >= lo && t.y <= hi && t !== a && t !== b).sort((p, q) => p.l - q.l);
        const r = {page: pi + 1, date: toDate(a.s), settle: toDate(b.s), issues: [], market: '', credit: false};
        const bs = band.find(t => /^(資|券|沖)?(買|賣)$/.test(t.s) || /^(現沖|當沖)(買|賣)$/.test(t.s));
        r.cd = bs ? bs.s : '';
        r.item = !bs ? '' : /資買/.test(bs.s) ? '融資買進' : /資賣/.test(bs.s) ? '融資賣出' : /券賣/.test(bs.s) ? '融券賣出' : /券買/.test(bs.s) ? '融券買進' : /買/.test(bs.s) ? '買進' : '賣出';
        r.credit = /資|券/.test(r.cd);
        r.dayTrade = /沖/.test(r.cd);
        const cat = band.find(t => /^(集中|櫃檯|櫃買|興櫃|上市|上櫃)$/.test(t.s));
        r.market = cat ? (/集中|上市/.test(cat.s) ? '上市' : /興櫃/.test(cat.s) ? '興櫃' : '上櫃') : '';
        const after = bs ? band.filter(t => t.l > bs.l) : band;
        const codeT = after.find(t => /^\d{4}[0-9A-Z]{0,2}$/.test(t.s) && !/,/.test(t.s));
        r.code = codeT ? codeT.s : '';
        const nameT = band.filter(t => /[一-鿿]/.test(t.s) && t !== cat && t !== bs && !/^TWD$/.test(t.s) && (!codeT || Math.abs((t.l + t.r) / 2 - (codeT.l + codeT.r) / 2) < 60));
        r.name = nameT.map(t => t.s).join('');
        const nums = after.filter(t => t !== codeT && isNum(t.s) && (!codeT || t.l > codeT.r - 1)).sort((p, q) => p.l - q.l);
        const v = nums.map(t => t.s);
        // 依序：股數、單價、成交金額、手續費、(交易稅)、客戶淨收付；用金額互相驗算選出正確的對應
        const tryMap = hasTax => {
          if (v.length < (hasTax ? 6 : 5)) return null;
          const shares = nv(v[0]), price = nv(v[1]), amt = nv(v[2]), fee = nv(v[3]), tax = hasTax ? nv(v[4]) : 0, netS = v[hasTax ? 5 : 4];
          const net = nv(netS), pay = /^\(/.test(netS);
          if (Math.abs(Math.round(shares * price) - amt) > 1) return null;
          const buy = /買/.test(r.item);
          const want = buy ? amt + fee : amt - fee - tax;
          if (want !== net) return null;
          return {shares, price, amt, fee, tax, net, pay};
        };
        const m = tryMap(true) || tryMap(false);
        if (m) Object.assign(r, m);
        else {
          r.shares = nv(v[0]) || 0; r.price = nv(v[1]) || 0; r.amt = nv(v[2]) || 0; r.fee = nv(v[3]) || 0; r.tax = 0; r.net = nv(v[v.length - 1]) || 0;
          r.issues.push('數字對不上，請確認（讀到：' + v.join(' ') + '）');
        }
        if (!r.item) r.issues.push('看不出是買還是賣');
        if (r.credit) r.issues.push('融資融券的匯入還在測試，請確認數字');
        if (m && /買/.test(r.item) !== m.pay && /買|賣/.test(r.item)) r.issues.push('買賣方向和收付不一致，請確認');
        out.rows.push(r);
      }
    });
    if (hasTot) {
      const s = f => out.rows.reduce((a, r) => a + (r[f] || 0), 0);
      out.check = [['amt', '成交金額', totAmt], ['fee', '手續費', totFee], ['tax', '交易稅', totTax]].map(([f, n, t]) => ({name: n, file: t, got: s(f), ok: t === s(f)}));
      out.check.filter(c => !c.ok).forEach(c => out.warnings.push(c.name + '合計對不上（對帳單 ' + c.file + '，讀到 ' + c.got + '）'));
    }
    if (!out.rows.length) out.warnings.push('沒有讀到交易明細（這個月可能沒有交易）');
    return out;
  }

  async function parseFile(file, password, opts) {
    const o = opts || {};
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { const e = new Error('請選擇 PDF 對帳單或投資先生截圖'); e.code = 'FORMAT'; throw e; }
    const pages = await readPdf(await file.arrayBuffer(), password, o.lib);
    let res;
    if (isCathay(pages)) {
      res = parseCathay(pages);
      res.rows.forEach(r => {
        const s = o.symbols ? resolveCode(r.name, r.market, o.symbols) : null;
        if (s) { r.code = s.code; r.fullName = s.name + '（' + s.code + '）'; if (r.market && s.market !== r.market) r.issues.push('市場別不同（對帳單：' + r.market + '，代號表：' + s.market + '）'); }
      });
    } else if (isYuantaStmt(pages)) {
      res = parseYuantaStmt(pages);
      res.rows.forEach(r => {
        const s = r.code && o.symbols ? o.symbols.find(x => x[0] === r.code) : null;
        if (s) r.fullName = s[1] + '（' + s[0] + '）';
        else if (r.code) r.issues.push('代號表裡找不到 ' + r.code + '，可能已下市或改名');
        else { const t = o.symbols ? resolveCode(r.name, r.market, o.symbols) : null; if (t) { r.code = t.code; r.fullName = t.name + '（' + t.code + '）'; } }
      });
    } else { const e = new Error('看不出是哪家券商的對帳單。目前支援國泰「客戶交易明細表」、元大「電子月對帳單」PDF'); e.code = 'UNKNOWN'; throw e; }
    markDayTrade(res.rows);
    return res;
  }

  // ================= 元大「投資先生」App 明細截圖 =================
  // 版面（以寬 1184 為基準的比例）：日期｜名稱（下面一行是交易類別，紅＝買、綠＝賣）｜價格／股數｜應收付／損益
  const YT_COLS = {date: [0, 0.144], name: [0.144, 0.38], num: [0.38, 0.612], net: [0.642, 0.93]};
  function rowMedian(img, y) {
    const a = [];
    for (let i = 0; i < 48; i++) { const x = Math.floor((i + 0.5) * img.w / 48), o = (y * img.w + x) * 4; a.push(Math.max(img.d[o], img.d[o + 1], img.d[o + 2])); }
    a.sort((p, q) => p - q); return a[24];
  }
  // 找列表範圍：表頭是一條比底色亮的漸層帶，底部「注意事項」是純黑
  function ytArea(img) {
    const m = []; for (let y = 0; y < img.h; y++) m.push(rowMedian(img, y));
    const k = img.w / 1184;
    const bgArr = m.slice(Math.floor(img.h * 0.45), Math.floor(img.h * 0.6)).slice().sort((a, b) => a - b);
    const bg = bgArr[Math.floor(bgArr.length / 2)];
    let top = -1, run = 0;
    for (let y = Math.floor(img.h * 0.15); y < img.h * 0.55; y++) {
      if (m[y] > bg + 12) run++; else { if (run > 40 * k) top = y; run = 0; }
      if (top > 0 && run === 0 && y > top + 5) break;
    }
    let bot = -1; run = 0;
    for (let y = Math.max(top, Math.floor(img.h * 0.5)); y < img.h; y++) { if (m[y] <= 2 && bg > 4) { run++; if (run > 20 * k) { bot = y - run; break; } } else run = 0; }
    if (top < 0) top = Math.round(img.h * 0.322);
    if (bot < 0) bot = Math.round(img.h * 0.869);
    return {top: top + 2, bot: bot - 2, dark: bg < 100};
  }
  // 白底黑字的二值化圖：彩色字取 RGB 最大值，所以紅綠字也會被當成字
  function ytStrip(img, x0, y0, x1, y1, dark) {
    x0 = Math.max(0, Math.round(x0)); x1 = Math.min(img.w, Math.round(x1)); y0 = Math.max(0, Math.round(y0)); y1 = Math.min(img.h, Math.round(y1));
    const w = x1 - x0, h = y1 - y0, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y + y0) * img.w + x + x0) * 4, v = Math.max(img.d[i], img.d[i + 1], img.d[i + 2]);
      const ink = dark ? v > 110 : v < 140, o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = ink ? 0 : 255; d[o + 3] = 255;
    }
    return {w: w, h: h, d: d, x0: x0, y0: y0};
  }
  function ytColor(img, x0, y0, x1, y1) {
    let r = 0, g = 0;
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(img.h, Math.round(y1)); y += 1) for (let x = Math.max(0, Math.round(x0)); x < Math.min(img.w, Math.round(x1)); x += 2) {
      const i = (y * img.w + x) * 4, R = img.d[i], G = img.d[i + 1], B = img.d[i + 2];
      if (R > 120 && R > G + 50 && R > B + 30) r++; else if (G > 120 && G > R + 50) g++;
    }
    return r > g * 2 && r > 20 ? 'red' : g > r * 2 && g > 20 ? 'green' : '';
  }
  // 某欄的文字行（用像素判斷，不靠文字辨識）
  function inkLines(img, x0, x1, y0, y1, dark, k) {
    const cnt = [];
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      let c = 0;
      for (let x = Math.round(x0); x < Math.round(x1); x += 2) { const i = (y * img.w + x) * 4, v = Math.max(img.d[i], img.d[i + 1], img.d[i + 2]); if (dark ? v > 110 : v < 140) c++; }
      cnt.push(c);
    }
    const out = []; let cur = null;
    cnt.forEach((c, i) => {
      const y = Math.round(y0) + i;
      if (c >= 2) { if (cur && y - cur.y1 <= 8 * k) cur.y1 = y; else { cur = {y0: y, y1: y}; out.push(cur); } }
    });
    return out.filter(l => l.y1 - l.y0 >= 12 * k);
  }
  const digits = s => String(s || '').replace(/[^\d]/g, '');
  function priceCands(t) {
    t = String(t || '').replace(/[^\d.,]/g, '');
    const out = new Set(), plain = digits(t);
    if (!plain) return [];
    if (/\./.test(t)) { const v = Number(t.replace(/,/g, '')); if (v > 0) out.add(v); }
    [1, 10, 100].forEach(f => { const v = Number(plain) / f; if (v > 0) out.add(Math.round(v * 100) / 100); });
    return [...out];
  }
  // 相似度：最長共同子序列 / 較長字串長度
  function sim(a, b) {
    const n = a.length, m = b.length; if (!n || !m) return 0;
    const dp = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return dp[n][m] / Math.max(n, m);
  }
  const cleanName = s => String(s || '').replace(/[\s*＊.。、,，'"`|]/g, '').replace(/(\d)[OoQ]$/, '$1').toUpperCase();
  async function ytResolve(name, date, price, list, priceOn) {
    const n = cleanName(name);
    const cands = list.map(x => ({x: x, s: sim(n, cleanName(x[1]))})).filter(c => c.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 12);
    for (const c of cands) {
      let ok = null;
      if (priceOn) { try { const cl = await priceOn(date, c.x[0]); if (cl) ok = Math.abs(price / cl - 1) < 0.12; } catch (e) {} }
      c.ok = ok;
    }
    // 名稱像、而且當天收盤價也對得上的；只有一檔符合就是它（例如「合晶」讀成「合唱」）
    const good = cands.filter(c => c.ok === true);
    const pick = good.length ? good[0] : cands.find(c => c.ok === null && c.s >= 0.85);
    const sure = good.length === 1 ? pick.s >= 0.5 : good.length > 1 ? pick.s >= 0.75 && pick.s > good[1].s : false;
    return pick ? {code: pick.x[0], name: pick.x[1], market: pick.x[2], sure: sure} : null;
  }
  async function parseYuantaShots(imgs, o) {
    const res = {broker: '元大證券', kind: '投資先生 App 明細截圖', rows: [], warnings: [], check: null};
    const per = [];
    for (let ii = 0; ii < imgs.length; ii++) {
      const img = imgs[ii], k = img.w / 1184, A = ytArea(img);
      if (o.progress) o.progress(ii, imgs.length);
      const L = {};
      for (const c of ['date', 'name', 'num', 'net']) {
        const [a, b] = YT_COLS[c];
        const st = ytStrip(img, a * img.w, A.top, b * img.w, A.bot, A.dark);
        const lines = await o.ocr(st, c === 'name' ? 'text' : 'digits');
        L[c] = lines.map(l => ({y0: l.y0 + st.y0, y1: l.y1 + st.y0, t: String(l.text || '').replace(/\s+/g, '').trim(), conf: l.conf})).filter(l => l.t).sort((p, q) => p.y0 - q.y0);
      }
      // 用圖片本身切出每一筆：「價格／股數」欄每筆固定兩行，筆與筆之間的間距比同一筆內大
      const ink = inkLines(img, YT_COLS.num[0] * img.w, YT_COLS.num[1] * img.w, A.top, A.bot, A.dark, k);
      const bands = [];
      for (let i = 0; i < ink.length; i++) {
        const a = ink[i], b = ink[i + 1];
        if (b && b.y0 - a.y0 < 104 * k) {
          const hs = ink.map(l => l.y1 - l.y0).sort((p, q) => p - q), hm = hs[Math.floor(hs.length / 2)] || 30 * k;
          const cutTop = a.y0 - A.top < 3 * k || a.y1 - a.y0 < hm * 0.7, cutBot = A.bot - b.y1 < 3 * k || b.y1 - b.y0 < hm * 0.7;
          bands.push({lo: a.y0 - 48 * k, hi: b.y1 + 42 * k, py: a, sy: b, cut: cutTop || cutBot, where: cutTop ? '最上面' : '最下面'}); i++;
        } else res.warnings.push('第 ' + (ii + 1) + ' 張' + (i === 0 ? '最上面' : '最下面') + '有一筆被截斷，沒有匯入');
      }
      const rowsHere = [];
      for (const bd of bands) {
        if (bd.cut) { res.warnings.push('第 ' + (ii + 1) + ' 張' + bd.where + '有一筆被截斷，沒有匯入'); continue; }
        const inB = arr => arr.filter(l => (l.y0 + l.y1) / 2 >= bd.lo && (l.y0 + l.y1) / 2 < bd.hi);
        const cell = async (c, mode) => {
          const [a, b] = YT_COLS[c], st = ytStrip(img, a * img.w, bd.lo, b * img.w, bd.hi, A.dark);
          return (await o.ocr(st, mode)).map(l => ({y0: l.y0 + st.y0, y1: l.y1 + st.y0, t: String(l.text || '').replace(/\s+/g, ''), conf: l.conf})).filter(l => l.t);
        };
        let dl = inB(L.date), nm = inB(L.name), nu = inB(L.num), ne = inB(L.net);
        const r = {issues: [], img: ii + 1};
        // 日期
        const getDate = arr => {
          const s2 = arr.map(l => l.t.replace(/[^\d/]/g, '')).join('/').replace(/\/+/g, '/');
          const m = /(20\d\d)\/?(\d{1,3})\/(\d{1,3})/.exec(s2);
          if (!m) return '';
          const mo = +m[2].slice(-2), da = +m[3].slice(0, 2);
          return mo >= 1 && mo <= 12 && da >= 1 && da <= 31 ? m[1] + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0') : '';
        };
        r.date = getDate(dl);
        if (!r.date) { dl = await cell('date', 'digits'); r.date = getDate(dl); }
        if (nm.length < 2) nm = await cell('name', 'text');
        if (nu.length < 2) nu = await cell('num', 'digits');
        if (!ne.length) ne = await cell('net', 'digits');
        if (!r.date) r.issues.push('日期讀不到');
        if (nm.length < 2 || nu.length < 2 || !ne.length) { r.issues.push('有欄位讀不到'); r.name = (nm[0] || {}).t || '?'; r.cd = ''; r.item = ''; r.shares = 0; r.price = 0; r.net = 0; rowsHere.push(r); continue; }
        // 名稱欄：最下面那行是交易類別，其餘是股票名稱（可能兩行）；類別那行靠「股數」那行的高度判斷
        nm.sort((p, q) => p.y0 - q.y0);
        let ti = nm.findIndex(l => Math.abs((l.y0 + l.y1) / 2 - (bd.sy.y0 + bd.sy.y1) / 2) < 30 * k);
        if (ti < 0) ti = nm.length - 1;
        const typeL = nm[ti];
        r.name = nm.filter((l, i) => i !== ti && (l.y1 <= typeL.y0 + 5 * k)).map(l => l.t).join('');
        r.cd = typeL.t;
        const col = ytColor(img, YT_COLS.name[0] * img.w, typeL.y0, YT_COLS.name[1] * img.w, typeL.y1);
        const tb = /買/.test(r.cd) ? 'buy' : /賣/.test(r.cd) ? 'sell' : '';
        const side = col === 'red' ? 'buy' : col === 'green' ? 'sell' : tb;
        if (!side) r.issues.push('看不出是買還是賣');
        if (tb && col && tb !== side) r.issues.push('交易類別和顏色不一致');
        r.item = side === 'buy' ? '買進' : side === 'sell' ? '賣出' : '';
        r.dayTrade = /沖/.test(r.cd);
        if (/資|券/.test(r.cd)) r.issues.push('融資融券的截圖匯入還不支援，請確認');
        r.net = Number(digits(ne[0].t)) || 0;
        r.pl = ne[1] ? ne[1].t : '';
        // 價格、股數：用「價格 × 股數」和應收付互相驗證，挑出合理的組合（修正小數點、千分位被讀錯）
        nu.sort((p, q) => p.y0 - q.y0); ne.sort((p, q) => p.y0 - q.y0);
        const sh = Number(digits(nu[1].t)) || 0, pcs = priceCands(nu[0].t);
        let best = null;
        pcs.forEach(p => {
          const amt = Math.round(p * sh); if (!amt) return;
          const diff = side === 'buy' ? r.net - amt : amt - r.net;
          const max = side === 'buy' ? Math.max(20, amt * 0.001425) + 1 : amt * 0.0045 + 21;
          if (diff >= 0 && diff <= max && (!best || diff < best.diff)) best = {p: p, amt: amt, diff: diff};
        });
        r.shares = sh;
        if (best) { r.price = best.p; r.amt = best.amt; r.cost = best.diff; }
        else { r.price = pcs[0] || 0; r.amt = Math.round(r.price * sh); r.cost = null; r.issues.push('價格 × 股數和應收付對不上，可能有數字讀錯'); }
        rowsHere.push(r);
      }
      per.push(rowsHere);
    }
    if (o.progress) o.progress(imgs.length, imgs.length);
    // 每張截圖裡日期應該由舊到新；跳回去的日期多半是讀錯（例如 11/23 讀成 1/23）
    per.forEach(rows => {
      let last = '';
      rows.forEach((r, i) => {
        const next = rows.slice(i + 1).find(x => x.date) || null;
        r.dateBad = !!((last && r.date < last) || (next && r.date > next.date && (!last || next.date >= last)));
        if (!r.dateBad) last = r.date;
      });
    });
    // 重疊的截圖：同一筆（買賣、價格、股數、應收付都一樣）在多張出現只算一次；同一張裡重複的保留
    const key = r => [r.item, r.price, r.shares, r.net].join('|');
    const groups = {};
    per.forEach((rows, ii) => { const c = {}; rows.forEach(r => { const kk = key(r); c[kk] = (c[kk] || 0) + 1; const g = groups[kk] || (groups[kk] = []); (g[c[kk] - 1] || (g[c[kk] - 1] = [])).push(r); }); });
    Object.keys(groups).forEach(kk => groups[kk].forEach(same => {
      const pick = same.find(r => !r.dateBad && !r.issues.length) || same.find(r => !r.dateBad) || same[0];
      const dates = new Set(same.filter(r => !r.dateBad).map(r => r.date));
      if (pick.dateBad) pick.issues.push('日期可能讀錯（讀到 ' + pick.date + '），請確認');
      else if (dates.size > 1) pick.issues.push('不同截圖讀到的日期不一樣，請確認');
      res.rows.push(pick);
    }));
    res.rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    // 股票代號、手續費與稅
    for (const r of res.rows) {
      r.fee = r.fee || 0; r.tax = r.tax || 0;
      if (!r.item || !r.price) continue;
      let s = await ytResolve(r.name, r.date, r.price, o.symbols || [], o.priceOn);
      if (!s && o.known && o.known.length && o.priceOn) {
        const hit = [];
        for (const c of o.known) { try { const cl = await o.priceOn(r.date, c); if (cl && Math.abs(r.price / cl - 1) < 0.05) hit.push(c); } catch (e) {} }
        if (hit.length === 1) { const x = (o.symbols || []).find(y => y[0] === hit[0]); if (x) s = {code: x[0], name: x[1], market: x[2], sure: false}; }
      }
      if (s) { r.code = s.code; r.fullName = s.name + '（' + s.code + '）'; if (!s.sure) r.issues.push('股票名稱是推測的（讀到「' + r.name + '」），請確認'); }
      if (r.cost === null || r.cost === undefined) { r.fee = 0; r.tax = 0; continue; }
      if (r.item === '買進') { r.fee = r.cost; r.tax = 0; }
      else {
        const etf = /^0/.test(r.code || '');
        const t = Math.floor(r.amt * (etf ? 0.001 : r.dayTrade ? 0.0015 : 0.003));
        r.tax = Math.min(t, r.cost); r.fee = r.cost - r.tax;
      }
    }
    res.rows.forEach(r => { r.market = ''; r.credit = false; });
    return res;
  }

  // 瀏覽器：用 tesseract.js 在裝置上辨識文字（不上傳），第一次使用會下載辨識模型
  let ocrP = null;
  function browserOcr() {
    if (ocrP) return ocrP;
    ocrP = new Promise((ok, no) => {
      if (root.Tesseract) return ok(root.Tesseract);
      const s = document.createElement('script'); s.src = BASE + 'vendor/tesseract/tesseract.min.js';
      s.onload = () => ok(root.Tesseract); s.onerror = () => no(new Error('辨識元件載入失敗，請確認網路')); document.head.appendChild(s);
    }).then(async T => {
      const simd = await (async () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; } })();
      const opt = {workerPath: BASE + 'vendor/tesseract/worker.min.js', corePath: BASE + 'vendor/tesseract/' + (simd ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js'),
        langPath: BASE + 'vendor/tesseract', gzip: true, cacheMethod: 'write', workerBlobURL: false};
      const wt = await T.createWorker('chi_tra', 1, opt), wd = await T.createWorker('chi_tra', 1, opt);
      await wt.setParameters({tessedit_pageseg_mode: '6'});
      await wd.setParameters({tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789.,-/'});
      return {wt: wt, wd: wd};
    });
    ocrP.catch(() => { ocrP = null; });
    return ocrP;
  }
  async function ocrStrip(st, mode) {
    const W = await browserOcr();
    const c = document.createElement('canvas'); c.width = st.w; c.height = st.h;
    c.getContext('2d').putImageData(new ImageData(st.d, st.w, st.h), 0, 0);
    const {data} = await (mode === 'text' ? W.wt : W.wd).recognize(c, {}, {blocks: true});
    const out = [];
    (data.blocks || []).forEach(B => B.paragraphs.forEach(p => p.lines.forEach(l => out.push({y0: l.bbox.y0, y1: l.bbox.y1, text: l.text, conf: l.confidence}))));
    return out;
  }
  const pxCache = {};
  function pricePxOn(date, code) {
    const ym = date.slice(0, 7);
    if (!pxCache[ym]) pxCache[ym] = fetch(BASE + 'data/px/' + ym + '.json').then(r => r.ok ? r.json() : null).catch(() => null);
    return pxCache[ym].then(j => {
      if (!j || !j.c || !j.c[code]) return null;
      const i = j.d.indexOf(date), a = j.c[code];
      if (i >= 0 && a[i]) return a[i];
      for (let t = Math.min(a.length - 1, i < 0 ? a.length - 1 : i); t >= 0; t--) if (a[t]) return a[t];
      return null;
    });
  }
  async function fileToImg(f) {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    return {w: c.width, h: c.height, d: d.data};
  }
  async function parseShots(files, opts) {
    const imgs = []; for (const f of files) imgs.push(await fileToImg(f));
    if (opts.progress) opts.progress(-1, files.length);
    const W = await browserOcr();
    // 名稱欄只允許股票名稱裡出現過的字，避免讀成不存在的字（例如「合晶」讀成「合唱」）
    if (opts.symbols && opts.symbols.length) {
      const wl = [...new Set(opts.symbols.map(x => x[1]).join('') + '盤中零股買進賣出普通現沖資券融當日後定期*0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-&.')].join('');
      await W.wt.setParameters({tessedit_char_whitelist: wl});
    }
    return parseYuantaShots(imgs, Object.assign({ocr: ocrStrip, priceOn: pricePxOn}, opts));
  }

  const api = {readPdf, parseCathay, isCathay, parseYuantaStmt, isYuantaStmt, resolveCode, markDayTrade, parseFile, parseYuantaShots, parseShots, ytArea, ytStrip};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ZQImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
