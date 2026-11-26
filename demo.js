// 示範模式：在瀏覽器裡產生假資料，模擬後端回應（不會連到任何伺服器，也不會儲存）
(function () {
  // 固定亂數種子，每次看到的示範資料都一樣
  let seed = 7;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const gauss = (m, s) => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const ms = 864e5;
  const toD = s => new Date(s + 'T00:00:00Z');
  const isoD = d => d.toISOString().slice(0, 10);
  // 資料以 2026-11-24 為最後一天；平移整數週，讓最後一天靠近今天、星期幾不變
  const base = toD('2026-11-24');
  const now = new Date(); const today = toD(now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'));
  let shift = Math.floor((today - base) / ms / 7) * 7;
  const sh = s => isoD(new Date(toD(s).getTime() + shift * ms));
  const fee = amt => Math.max(20, Math.floor(amt * 0.001425 * 0.6));

  const S = {'2330': '台積電（2330）', '0050': '元大台灣50（0050）', '2317': '鴻海（2317）', '3189': '景碩（3189）',
    '2454': '聯發科（2454）', '00878': '國泰永續高股息（00878）', '1303': '南亞（1303）'};
  const T = [['2026-01-08', '買進', '0050', 2000, 168.4, false, 1], ['2026-01-20', '買進', '2330', 100, 1015, false, 1],
    ['2026-02-05', '買進', '2317', 1000, 198.5, false, 1], ['2026-03-11', '買進', '1303', 2000, 41.2, false, 1],
    ['2026-03-25', '買進', '2454', 100, 1180, false, 1], ['2026-04-22', '賣出', '1303', 2000, 48.6, false, 1],
    ['2026-05-14', '買進', '0050', 1000, 176.2, false, 1], ['2026-06-10', '賣出', '2454', 100, 1312, false, 1],
    ['2026-06-29', '買進', '3189', 150, 520, false, 1], ['2026-07-16', '現金股利', '0050', 3000, 1.8, false, 1],
    ['2026-08-05', '買進', '2330', 100, 1040, false, 1], ['2026-08-27', '買進', '00878', 5000, 21.3, false, 1],
    ['2026-09-18', '現金股利', '2317', 1000, 5.4, false, 1], ['2026-10-14', '賣出', '00878', 5000, 22.05, false, 1],
    ['2026-10-21', '現金股利', '2330', 200, 5.0, false, 1], ['2026-11-04', '買進', '2454', 100, 1255, false, 2],
    ['2026-11-12', '賣出', '2454', 100, 1198, false, 2], ['2026-11-18', '買進', '3189', 1000, 505, true, 2],
    ['2026-11-18', '賣出', '3189', 1000, 512, true, 2], ['2026-11-20', '買進', '0050', 500, 188.6, false, 1]];
  const NOTES = {4: '看好天璣新晶片，法說會前先布局', 7: '跌破季線，照停利計畫出場', 15: '法說會前布局', 16: '跌破停損價 1,200，紀律出場',
    17: '開盤爆量突破前高，當沖', 18: '量縮拉回，獲利了結', 19: '大盤回檔到月線，加碼'};
  const records = T.map((t, i) => {
    const [d, item, code, u, p, dtf, b] = t;
    const etf = code.startsWith('00');
    const amt = (item === '買進' || item === '賣出') ? Math.floor(u * p) : 0;
    let f = 0, tx = 0, net;
    if (item === '買進') { f = fee(amt); net = -(amt + f); }
    else if (item === '賣出') { f = fee(amt); tx = Math.floor(amt * (etf ? 0.001 : dtf ? 0.0015 : 0.003)); net = amt - f - tx; }
    else net = Math.floor(u * p);
    return {row: 3 + i, d: sh(d), item: item, name: S[code], units: u, price: p, amt: amt || null, fee: amt ? f : null, tax: amt ? tx : null, net: net, batch: b, dayTrade: dtf, note: NOTES[i] || ''};
  });
  const realized = records.filter(r => r.item === '賣出').map(r => {
    const buy = records.filter(x => x.name === r.name && x.item === '買進' && x.d <= r.d && x.batch === r.batch).pop();
    const cost = -buy.net * r.units / buy.units, pl = Math.round(r.net - cost);
    return {d: r.d, item: '賣出', name: r.name, units: r.units, price: r.price, batch: r.batch, dt: !!r.dayTrade, pl: pl, r: pl / cost, cost: Math.round(cost), out: r.net};
  }).sort((a, b) => a.d < b.d ? 1 : -1);
  const holdings = [
    {name: '元大台灣50（0050）', batch: 1, code: '0050', units: 3500, price: 196.2, avg: 173.9},
    {name: '台積電（2330）', batch: 1, code: '2330', units: 200, price: 1185, avg: 1028.4},
    {name: '鴻海（2317）', batch: 1, code: '2317', units: 1000, price: 221.5, avg: 198.8},
    {name: '景碩（3189）', batch: 1, code: '3189', units: 150, price: 498, avg: 520.4}];
  const DAY = {'0050': 0.0124, '2330': 0.0215, '2317': -0.0089, '3189': -0.0315};   // 示範：今日漲跌
  holdings.forEach(h => {
    h.prev = Math.round(h.price / (1 + DAY[h.code]) * 100) / 100; h.dayR = h.price / h.prev - 1; h.dayPl = Math.round((h.price - h.prev) * h.units);
    h.mv = Math.round(h.units * h.price); h.cost = Math.round(h.units * h.avg);
    h.pl = h.mv - h.cost - fee(h.mv) - Math.floor(h.mv * (h.code.startsWith('00') ? 0.001 : 0.003)); h.r = h.pl / h.cost;
    h.div = ({'0050': 6115, '2330': 1990})[h.code] || 0;   // 示範：這批已領的現金股利
    Object.assign(h, {short: false, mt: 0, loan: 0, self: 0, collat: 0, margin: 0, mtDue: ''});
  });
  const MV_END = holdings.reduce((s, h) => s + h.mv, 0);
  // 每日資產
  const holi = ['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-09'];
  const flows = {};
  records.forEach(r => { if (r.item === '買進' || r.item === '賣出') flows[r.d] = (flows[r.d] || 0) - r.net; });
  const daily = [];
  let inv = 0, nav = 100, tx = 22800, e50 = 160;
  for (let t = toD('2026-01-02').getTime(); t <= base.getTime(); t += ms) {
    const d = new Date(t), wd = d.getUTCDay(), k0 = isoD(d);
    if (wd === 0 || wd === 6 || holi.indexOf(k0) >= 0) continue;
    const k = sh(k0); inv += flows[k] || 0;
    const m = gauss(0.0009, 0.011); nav *= 1 + m;
    tx *= 1 + m * 0.85 + gauss(0, 0.004); e50 *= 1 + m * 0.9 + gauss(0, 0.003);
    daily.push({d: k, inv: inv, nav: nav, tx: tx, e50: e50});
  }
  daily.forEach(x => x.mv = x.inv > 0 ? x.inv * x.nav / 100 : 0);
  const kk = MV_END / daily[daily.length - 1].mv;
  let prev = null;
  daily.forEach((x, i) => {
    x.mv = Math.round(x.mv * (1 + (kk - 1) * (i / daily.length)));
    x.pl = x.mv - x.inv; x.dpl = x.pl - (prev ? prev.pl : 0); x.r = prev && prev.mv ? x.dpl / prev.mv : 0; prev = x;
  });
  const LAST = daily[daily.length - 1].d;

  function overview(f, t) {
    const rows = daily.filter(x => x.d <= t), last = rows[rows.length - 1];
    const before = rows.filter(x => x.d < f), inr = rows.filter(x => x.d >= f);
    const b = before.length ? before[before.length - 1] : {pl: 0, nav: 100, tx: inr[0].tx, e50: inr[0].e50};
    const ra = (a, c) => a / c - 1;
    return {status: '完整', asOf: last.d, updated: md(last.d) + ' 15:32', mv: last.mv, todayPl: last.dpl, todayR: last.r, benchTx: true, benchE50: true,
      rangePl: last.pl - b.pl, rangeR: ra(last.nav, b.nav), tx: ra(last.tx, b.tx), e50: ra(last.e50, b.e50),
      series: inr.map(x => ({d: x.d, mv: x.mv, pl: x.pl - b.pl, r: ra(x.nav, b.nav), tx: ra(x.tx, b.tx), e50: ra(x.e50, b.e50)}))};
  }
  function md(s) { return +s.slice(5, 7) + '/' + +s.slice(8, 10); }
  function performance(f, t) {
    const keys = []; records.filter(r => r.item === '買進').forEach(r => { const k = r.name + '|' + r.batch; if (keys.indexOf(k) < 0) keys.push(k); });
    const out = [];
    keys.forEach(k => {
      const [name, bs] = k.split('|'), b = +bs;
      const rs = records.filter(r => r.name === name && r.batch === b);
      const s = rs.reduce((m, r) => r.d < m ? r.d : m, rs[0].d);
      const h = holdings.find(x => x.name === name && x.batch === b);
      const sells = rs.filter(r => r.item === '賣出');
      const e = h ? '' : sells.length ? sells.reduce((m, r) => r.d > m ? r.d : m, sells[0].d) : '';
      if (s > t || (e && e < f)) return;
      const inv = rs.filter(r => r.item === '買進').reduce((a, r) => a - r.net, 0);
      const real = realized.filter(x => x.name === name && x.batch === b).reduce((a, x) => a + x.pl, 0);
      const div = b === 1 ? records.filter(r => r.name === name && r.item === '現金股利').reduce((a, r) => a + r.net, 0) : 0;
      const unreal = h ? h.pl : 0, pl = real + div + unreal;
      out.push({name: name, batch: b, start: s, end: e, hold: !!h, inv: inv, div: div, real: real, unreal: unreal, pl: pl, r: inv ? pl / inv : null});
    });
    return out.sort((a, b) => b.pl - a.pl);
  }
  const ACCTS = [{id: 'main', name: '示範帳戶', url: ''}];
  let OPT = {nhi: true}, FEES = [{from: '1990-01-01', disc: 6}, {from: '2021-11-03', disc: 2.8}];
  let PLANS = [{id: 'p1', name: '元大台灣50（0050）', days: [6, 16], amount: 3000, start: sh('2026-09-01'), active: true, acct: 'main'}];
  const SETTINGS = () => ({fees: FEES, minFee: 20, minOdd: 1, plans: PLANS, sheetUrl: '',
    dismissed: 0, credit: {mp: 6, ss: 9, si: 0.001, sf: 0.0008, mi: 0.0645}, accounts: ACCTS, nhi: OPT.nhi});
  const SYMS = [['0050', '元大台灣50', '上市', 196.2], ['2330', '台積電', '上市', 1185], ['2317', '鴻海', '上市', 221.5], ['3189', '景碩', '上櫃', 498],
    ['2454', '聯發科', '上市', 1210], ['00878', '國泰永續高股息', '上市', 21.9], ['1303', '南亞', '上市', 47.8], ['2303', '聯電', '上市', 52.1],
    ['2308', '台達電', '上市', 990], ['2882', '國泰金', '上市', 66.3], ['2891', '中信金', '上市', 41.5], ['006208', '富邦台50', '上市', 112.4]];

  window.demoCall = function (fn, args) {
    const a = args || [];
    switch (fn) {
      case 'appOverview': return overview(a[0], a[1]);
      case 'appHoldings': return holdings.map(h => Object.assign({}, h));
      case 'appRealized': return realized.filter(x => a[0] <= x.d && x.d <= a[1]);
      case 'appPerformance': return performance(a[0], a[1]);
      case 'appRecords': return records.filter(x => a[0] <= x.d && x.d <= a[1]).sort((x, y) => x.d === y.d ? y.row - x.row : (x.d < y.d ? 1 : -1));
      case 'appCalendar': return {days: daily.filter(x => a[0] <= x.d && x.d <= a[1]).map(x => ({d: x.d, pl: x.dpl, r: x.r})),
        trades: window.demoCall('appRecords', a), realized: window.demoCall('appRealized', a)};
      case 'appMeta': {
        const held = {}; holdings.forEach(h => held[h.name] = h.units);
        return {stocks: Object.keys(S).map(c => ({name: S[c], code: c, held: held[S[c]] || 0, short: 0})), disc: 2.8,
          fees: SETTINGS().fees, credit: SETTINGS().credit, minFee: 20, minOdd: 1, today: LAST};
      }
      case 'appLookup': { const s = SYMS.find(x => x[0] === String(a[0]).toUpperCase()); return s ? s[1] + '（' + s[0] + '）' : ''; }
      case 'appSymbols': return {at: Date.now(), list: SYMS};
      case 'appSettings': return SETTINGS();
      case 'appAccounts': return ACCTS;
      case 'appCorpActions': return {checked: LAST, items: [
        {type: 'cash', code: '2330', date: sh('2026-12-15'), shares: 200, item: '現金股利', units: 200, price: 6, est: 1200, key: 'demo1', name: '台積電（2330）'}]};
      case 'appDividends': return records.filter(r => r.item === '現金股利').map(r => ({row: r.row, d: r.d, item: r.item, name: r.name, units: r.units,
        price: r.price, amt: r.net, fee: 0, nhi: 0, net: r.net})).reverse();
      case 'appStockChart': {
        // 示範：從最近收盤價往回做一條隨機走勢，經過每筆買賣的成交價
        const code = a[0], S2 = {}; Object.keys(S).forEach(k => S2[k] = S[k]);
        const end = (holdings.find(h => h.code === code) || {}).price;
        const tr = records.filter(r => (r.item === '買進' || r.item === '賣出') && r.name === S2[code]).map(r => ({d: r.d, item: r.item, units: r.units, price: r.price, batch: r.batch, dt: r.dayTrade, side: r.item === '買進' ? 'b' : 's'})).sort((x, y) => x.d < y.d ? -1 : 1);
        const from = a[3] ? (tr.length ? isoD(new Date(toD(tr[0].d).getTime() - 20 * ms)) : a[1]) : a[1];
        const last = a[2] && a[2] < sh('2026-11-24') ? a[2] : sh('2026-11-24'), days = [];
        for (let t = toD(from); isoD(t) <= last; t = new Date(t.getTime() + ms)) { const w = t.getUTCDay(); if (w && w < 6) days.push(isoD(t)); }
        const anchors = tr.map(x => [x.d, x.price]).concat([[last, end || (tr.length ? tr[tr.length - 1].price : 100)]]).sort((x, y) => x[0] < y[0] ? -1 : 1);
        let s2 = 0, wv = 0; const n = k => { s2 = (s2 * 9301 + 49297 + k) % 233280; return s2 / 233280 - 0.5; };
        const p = days.map((dd, i) => {
          const nx = anchors.find(x => x[0] >= dd) || anchors[anchors.length - 1], pv = [...anchors].reverse().find(x => x[0] <= dd);
          let base = nx[1];
          if (pv && pv[0] !== nx[0]) { const f = (toD(dd) - toD(pv[0])) / (toD(nx[0]) - toD(pv[0])); base = pv[1] + (nx[1] - pv[1]) * f; }
          wv = wv * 0.85 + n(i) * 0.012;
          return Math.round(base * (1 + (anchors.some(x => x[0] === dd) ? 0 : wv)) * 100) / 100;
        });
        return {code: code, from: from, d: days, p: p, trades: tr};
      }
      case 'appPrices': { const o = {}; (a[1] || []).forEach(d => o[d] = {d: d, p: 196.2}); return o; }
      case 'appAddRecord': {
        const r = a[0], amt = Math.floor(r.units * r.price), f = /買進|賣出/.test(r.item) ? Math.max(20, Math.floor(amt * 0.001425 * 0.28)) : 0;
        return {row: 99, d: r.date || r.d, units: r.units, price: r.price, dayTrade: false, item: r.item, name: r.name, amt: amt, fee: f, tax: 0, net: /買進/.test(r.item) ? -(amt + f) : amt - f, batch: 1, note: r.note || ''};
      }
      case 'appAddRecords': return a[0].map(r => window.demoCall('appAddRecord', [r]));
      case 'appImportRecords': return {added: a[0].length};
      case 'appClearPreview': return window.demoCall('appClearRecords', [a[0], false]);
      case 'appClearRecords': {
        const o = a[0] || {}, rs = records.filter(r => (!o.from || r.d >= o.from) && (!o.to || r.d <= o.to) && !o.imported);
        return a[1] ? {removed: rs.length} : {count: rs.length, rows: rs.map(r => ({d: r.d, item: r.item, name: r.name, units: r.units, price: r.price, dt: r.dayTrade, fee: r.fee, tax: r.tax, net: r.net, custom: '', note: r.note || ''}))};
      }
      case 'appUpdateRecord': return window.demoCall('appAddRecord', [a[2]]);
      case 'appDeleteRecord': case 'appDismissAction': return true;
      case 'appSaveFees': FEES = a[0]; return SETTINGS();
      case 'appSaveOptions': Object.assign(OPT, a[0]); return SETTINGS();
      case 'appSaveCredit': return SETTINGS();
      case 'appSavePlans': PLANS = a[0].map((x, i) => Object.assign({}, x, {id: x.id || 'p' + i})); return PLANS;
      case 'appRefresh': return {ok: true};
      case 'appCreateAccount': case 'appRenameAccount': case 'appRemoveAccount': return ACCTS;
    }
    throw new Error('示範模式不支援這個功能');
  };
})();
