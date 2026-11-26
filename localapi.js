// 新版後端：全部在瀏覽器裡跑。
//   交易紀錄與設定 → 存在使用者自己 Google 雲端硬碟裡的一份試算表（App 只能看到自己建立的檔案）
//   股價、除權息等公開資料 → 讀同網站 data/ 底下的 JSON（GitHub Actions 每天更新）
//   計算 → engine.js（與舊版試算表公式相同）
(function () {
  'use strict';
  const CLIENT_ID = window.ZQ_CLIENT_ID || '';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const TK = 'zqGTok', FK = 'zqGFile';
  const FILE_TITLE = '韭菜紀錄（App 資料）';
  const REC_HEAD = ['帳戶', '編號', '日期', '項目', '名稱（代號）', '股數/單位', '單價', '自選費用', '金額修正', '資券成數修正', '當沖',
    '成交金額', '手續費', '交易稅', '二代健保', '淨金額', '批號', '進出場理由'];
  const ITEMS = ['買進', '賣出', '現金股利', '股票股利', '股票分割', '股票反分割', '融資買進', '融資賣出', '融資現償', '融券賣出', '融券買進', '保證金追繳', '現金增資'];
  const FEE_FLOOR = '1990-01-01';
  const LS = {get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }};

  // ---------- 日期 ----------
  const pad = n => String(n).padStart(2, '0');
  const localKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const todayKey = () => localKey(new Date());
  const ser = k => Math.round((Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 864e5);
  const keyOf = n => new Date(Date.UTC(1899, 11, 30) + n * 864e5).toISOString().slice(0, 10);
  const addDays = (k, n) => keyOf(ser(k) + n);
  const isKey = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
  const codeOf = n => (String(n).match(/（(.+)）$/) || [])[1] || '';
  const err = m => { throw new Error(m); };

  // ---------- Google 登入（導向式，iPhone 主畫面 App 也能用）----------
  function redirectUri() { return location.origin + location.pathname; }
  function getTok() { try { const o = JSON.parse(LS.get(TK) || 'null'); return o && o.t ? o : null; } catch (e) { return null; } }
  function signIn(opt) {
    opt = opt || {};
    if (!CLIENT_ID) err('尚未設定 Google 登入');
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    LS.set('zqGState', JSON.stringify({s: st, back: opt.back || '', silent: !!opt.silent}));
    const tok = getTok();
    const p = new URLSearchParams({client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE,
      include_granted_scopes: 'true', state: st});
    if (opt.silent) p.set('prompt', 'none');
    else if (opt.select) p.set('prompt', 'select_account consent');
    if (tok && tok.email) p.set('login_hint', tok.email);
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
    return new Promise(() => {});   // 頁面會離開
  }
  // 登入回來：網址 # 後面帶著 access_token
  function takeRedirect() {
    if (!/access_token=|error=/.test(location.hash)) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    let st = null; try { st = JSON.parse(LS.get('zqGState') || 'null'); } catch (e) {}
    LS.set('zqGState', null);
    history.replaceState(null, '', location.pathname + location.search);
    if (!st || h.get('state') !== st.s) return {error: '登入狀態不符，請再試一次'};
    if (h.get('error')) return {error: h.get('error'), silent: st.silent, back: st.back};
    const old = getTok();
    LS.set(TK, JSON.stringify({t: h.get('access_token'), exp: Date.now() + (+h.get('expires_in') || 3600) * 1000 - 60e3, email: old ? old.email : ''}));
    return {ok: true, back: st.back, silent: !!st.silent};
  }
  function tokenOk() { const t = getTok(); return !!(t && t.exp > Date.now()); }
  function signedIn() { return !!getTok(); }
  async function ensureTok() {
    const t = getTok();
    if (t && t.exp > Date.now()) return t.t;
    if (!t) err('請先登入 Google');
    return signIn({silent: true, back: 'resume'});
  }
  function signOut() {
    const t = getTok();
    if (t && t.t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.t), {method: 'POST'}).catch(() => {});
    LS.set(TK, null); LS.set(FK, null); LS.set('zqGMe', null); DB = null; FILE = null;
  }

  async function gapi(url, opt) {
    opt = opt || {};
    const tok = await ensureTok();
    const r = await fetch(url, {method: opt.method || 'GET', headers: Object.assign({Authorization: 'Bearer ' + tok}, opt.body ? {'Content-Type': 'application/json'} : {}),
      body: opt.body ? JSON.stringify(opt.body) : undefined});
    if (r.status === 401) { const t = getTok(); if (t) { t.exp = 0; LS.set(TK, JSON.stringify(t)); } return signIn({silent: true, back: 'resume'}); }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = (j.error && (j.error.message || j.error)) || ('HTTP ' + r.status);
      if (r.status === 404 && opt.file) { LS.set(FK, null); FILE = null; }
      throw new Error(r.status === 429 ? 'Google 忙碌中，請稍後再試' : String(m));
    }
    return j;
  }

  // ---------- 使用者的資料檔（Google 試算表）----------
  let FILE = null;    // {id, recSheet}
  // Google 帳號基本資料（名稱、大頭貼），存在這台裝置
  async function userinfo(force) {
    let me = null; try { me = JSON.parse(LS.get('zqGMe') || 'null'); } catch (e) {}
    if (me && !force && Date.now() - (me.at || 0) < 24 * 3600e3 && (me.name || me.picture)) return me;
    try {
      const u = await gapi('https://openidconnect.googleapis.com/v1/userinfo');
      me = {email: u.email || '', name: u.name || u.given_name || '', picture: u.picture || '', at: Date.now()};
      LS.set('zqGMe', JSON.stringify(me));
      const o = getTok(); if (o) { o.email = me.email; LS.set(TK, JSON.stringify(o)); }
    } catch (e) {}
    return me || {email: '', name: '', picture: ''};
  }
  async function whoami() {
    const t = getTok();
    if (t && t.email) return t.email;
    return (await userinfo()).email || '';
  }
  async function findFile() {
    if (FILE) return FILE;
    const saved = LS.get(FK);
    if (saved) { FILE = {id: saved}; return FILE; }
    const q = encodeURIComponent("appProperties has { key='zqApp' and value='1' } and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'");
    const r = await gapi('https://www.googleapis.com/drive/v3/files?q=' + q + '&orderBy=createdTime&fields=files(id,name)&spaces=drive');
    if (r.files && r.files.length) { FILE = {id: r.files[0].id}; LS.set(FK, FILE.id); return FILE; }
    return null;
  }
  async function createFile() {
    const f = await gapi('https://www.googleapis.com/drive/v3/files?fields=id', {method: 'POST', body: {name: FILE_TITLE,
      mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: {zqApp: '1'}}});
    const meta = await gapi('https://sheets.googleapis.com/v4/spreadsheets/' + f.id + '?fields=sheets.properties');
    const first = meta.sheets[0].properties.sheetId;
    await gapi('https://sheets.googleapis.com/v4/spreadsheets/' + f.id + ':batchUpdate', {method: 'POST', body: {requests: [
      {updateSheetProperties: {properties: {sheetId: first, title: '紀錄', gridProperties: {frozenRowCount: 1}}, fields: 'title,gridProperties.frozenRowCount'}},
      {addSheet: {properties: {title: '設定'}}},
      {addSheet: {properties: {title: '說明'}}}]}});
    await gapi('https://sheets.googleapis.com/v4/spreadsheets/' + f.id + '/values:batchUpdate', {method: 'POST', body: {valueInputOption: 'RAW', data: [
      {range: '紀錄!A1', values: [REC_HEAD]},
      {range: '設定!A1', values: [['項目', '內容（JSON）'], ['rev', '1'], ['accounts', JSON.stringify([{id: 'main', name: '主帳戶'}])]]},
      {range: '說明!A1', values: [['這份試算表由「韭菜紀錄」App 建立，用來存你的交易紀錄與設定。'],
        ['「紀錄」分頁的 A～K 欄是你輸入的資料，L 欄以後是 App 算好寫回來給你看的。'],
        ['可以直接在這裡看或匯出；要修改請盡量在 App 裡改，直接改這裡也可以，App 下次讀取時會用新的內容重算。'],
        ['不要改分頁名稱、不要刪掉第一列標題。'],
        ['App 只能存取它自己建立的檔案，看不到你雲端硬碟裡的其他東西。']]}]}});
    FILE = {id: f.id}; LS.set(FK, f.id);
    try { if (window.zqTrack) window.zqTrack('signup', true); } catch (e) {}
    return FILE;
  }

  // ---------- 資料讀寫 ----------
  // DB = {rev, recs:[{acct,id,d,item,name,units,price,custom,adj,cr,dt}], set:{key: value}}
  let DB = null, DBP = null;
  const N = v => { if (v === '' || v === null || v === undefined) return 0; const n = Number(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const normDate = v => {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    return m ? m[1] + '-' + pad(m[2]) + '-' + pad(m[3]) : '';
  };
  async function load(force) {
    if (DB && !force) return DB;
    if (DBP && !force) return DBP;
    DBP = (async () => {
      let F = await findFile();
      if (!F) F = await createFile();
      let r;
      try {
        r = await gapi('https://sheets.googleapis.com/v4/spreadsheets/' + F.id + '/values:batchGet?ranges=' + encodeURIComponent('紀錄!A2:R') +
          '&ranges=' + encodeURIComponent('設定!A2:B') + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING', {file: true});
      } catch (e) {
        if (!LS.get(FK)) { FILE = null; const G = await findFile(); if (!G) await createFile(); return load(true); }
        throw e;
      }
      const recRows = (r.valueRanges[0].values || []), setRows = (r.valueRanges[1].values || []);
      const set = {};
      setRows.forEach(x => { if (x[0]) { try { set[x[0]] = JSON.parse(x[1]); } catch (e) { set[x[0]] = x[1]; } } });
      let maxId = 0;
      const recs = [];
      recRows.forEach(x => {
        const d = normDate(x[2]);
        if (!d && !x[3] && !x[4]) return;
        let id = N(x[1]);
        recs.push({acct: String(x[0] || 'main'), id: id, d: d, item: String(x[3] || '').trim(), name: String(x[4] || '').trim(), units: N(x[5]), price: N(x[6]),
          custom: String(x[7] || ''), adj: N(x[8]), cr: N(x[9]), dt: x[10] === true || String(x[10]).toUpperCase() === 'TRUE', note: String(x[17] || '')});
        if (id > maxId) maxId = id;
      });
      recs.forEach(x => { if (!x.id) x.id = ++maxId; });   // 在試算表手動加的列，補上編號
      canonNames(recs);
      set.accounts = Array.isArray(set.accounts) && set.accounts.length ? set.accounts : [{id: 'main', name: '主帳戶'}];
      if (set.accounts[0].id !== 'main') set.accounts.unshift({id: 'main', name: '主帳戶'});
      DB = {rev: N(set.rev), recs: recs, set: set, nextId: maxId + 1, at: Date.now(), loadedRows: recRows.length, loadedSet: setRows.length};
      MEMO = {};
      return DB;
    })();
    try { return await DBP; } finally { DBP = null; }
  }
  // 寫入：先重新讀最新資料、套用變更、整份寫回（含算好的欄位）
  // 同一個代號統一用同一個名稱（以最早那筆為準），避免「台積電（2330）」「台積（2330）」被當成不同股票分開算
  function canonNames(recs) {
    const first = {};
    recs.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id - b.id)).forEach(x => {
      const C = codeOf(x.name).trim().toUpperCase();
      if (C && !first[C]) first[C] = x.name;
    });
    recs.forEach(x => { const C = codeOf(x.name).trim().toUpperCase(); if (C && first[C]) x.name = first[C]; });
  }
  async function mutate(fn) {
    const db = await load(true);
    const out = fn(db);
    canonNames(db.recs);
    db.rev = (db.rev || 0) + 1; db.set.rev = db.rev;
    MEMO = {};
    // 依帳戶、日期、編號排好，算好的欄位一起寫回
    db.recs.sort((a, b) => (a.acct === b.acct ? 0 : a.acct === 'main' ? -1 : b.acct === 'main' ? 1 : a.acct < b.acct ? -1 : 1) ||
      (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id - b.id));
    const calc = {};
    db.set.accounts.forEach(a => { try { const R = compute(a.id); R.res.ok.forEach(c => calc[a.id + '|' + c.row] = c); } catch (e) {} });
    const rows = db.recs.map(x => {
      const c = calc[x.acct + '|' + x.id];
      return [x.acct, x.id, x.d, x.item, x.name, x.units, x.price, x.custom || '', x.adj || '', x.cr || '', !!x.dt,
        c ? c.O : '', c ? c.S : '', c ? c.U : '', c ? c.V : '', c ? c.AD : '', c ? c.J : '', x.note || ''];
    });
    const prevRows = db.loadedRows || 0;
    while (rows.length < prevRows) rows.push(new Array(REC_HEAD.length).fill(''));
    const keys = Object.keys(db.set).filter(k => k !== 'rev');
    const setRows = [['rev', String(db.rev)]].concat(keys.map(k => [k, typeof db.set[k] === 'string' ? db.set[k] : JSON.stringify(db.set[k])]));
    const prevSet = db.loadedSet || 0;
    while (setRows.length < prevSet) setRows.push(['', '']);
    await gapi('https://sheets.googleapis.com/v4/spreadsheets/' + FILE.id + '/values:batchUpdate', {method: 'POST', file: true, body: {valueInputOption: 'RAW', data: [
      {range: '紀錄!A1', values: [REC_HEAD]},
      {range: '紀錄!A2', values: rows.length ? rows : [new Array(REC_HEAD.length).fill('')]},
      {range: '設定!A2', values: setRows}]}});
    db.loadedRows = db.recs.length; db.loadedSet = setRows.length;
    return out;
  }

  // ---------- 公開資料 ----------
  const PUB = {meta: null, months: {}, json: {}};
  async function pubJ(path, bust) {
    const u = 'data/' + path + (bust ? '?v=' + bust : '');
    const r = await fetch(u, bust === 'nc' ? {cache: 'no-store'} : undefined);
    if (!r.ok) { if (r.status === 404) return null; throw new Error('公開資料讀取失敗（' + r.status + '）'); }
    return r.json();
  }
  async function meta(force) {
    if (PUB.meta && !force && Date.now() - PUB.metaAt < 10 * 60e3) return PUB.meta;
    try { PUB.meta = (await pubJ('meta.json', 'nc')) || {updated: ''}; } catch (e) { PUB.meta = PUB.meta || {updated: ''}; }
    PUB.metaAt = Date.now();
    return PUB.meta;
  }
  async function pub(name) {
    const m = await meta();
    const k = name + '|' + m.updated;
    if (!PUB.json[k]) PUB.json[k] = pubJ(name, m.updated || 'x').catch(e => { delete PUB.json[k]; throw e; });
    return PUB.json[k];
  }
  async function month(ym) {
    const m = await meta();
    const cur = todayKey().slice(0, 7), prev = addDays(cur + '-01', -1).slice(0, 7);
    const v = ym >= prev ? m.updated : 'fix';     // 兩個月前的資料不會再變
    const k = ym + '|' + v;
    if (!PUB.months[k]) PUB.months[k] = pubJ('px/' + ym + '.json', v || 'x').then(j => j || {d: [], c: {}}).catch(() => ({d: [], c: {}, failed: true}));
    return PUB.months[k];
  }
  async function symList() { const j = await pub('symbols.json'); return (j && j.list) || []; }
  async function symMap() { if (!PUB.symMap || PUB.symMapV !== PUB.meta.updated) { const l = await symList(); PUB.symMap = {}; l.forEach(x => PUB.symMap[String(x[0]).toUpperCase()] = x); PUB.symMapV = PUB.meta.updated; } return PUB.symMap; }

  // 盤中即時價（App 每隔幾秒寫進 window.ZQ_LIVE；只在當天有效）
  const live = () => {
    const L = window.ZQ_LIVE;
    if (!L || L.day !== todayKey() || !L.px) return null;
    // 今天的正式收盤資料已經進來，就以正式資料為準
    if (PUB.meta && PUB.meta.lastDay && PUB.meta.lastDay >= L.day) return null;
    return L;
  };
  const livePx = code => { const L = live(); const p = L && L.px[String(code).toUpperCase()]; return p > 0 ? p : 0; };

  // ---------- 設定 ----------
  const acctSet = id => { const k = 'acct:' + id; return DB.set[k] || (DB.set[k] = {}); };
  function feesOf(id) {
    const s = acctSet(id);
    const fees = Array.isArray(s.fees) && s.fees.length ? s.fees.slice() : [{from: FEE_FLOOR, disc: 6}];
    fees.sort((a, b) => a.from < b.from ? -1 : 1); fees[0] = Object.assign({}, fees[0], {from: FEE_FLOOR});
    return {fees: fees, minFee: s.minFee !== undefined ? s.minFee : 20, minOdd: s.minOdd !== undefined ? s.minOdd : 1};
  }
  const creditOf = id => Object.assign({mp: 6, ss: 9, si: 0.001, sf: 0.0008, mi: 0.0645}, acctSet(id).credit || {});
  const nhiOf = id => acctSet(id).nhi !== false;
  function cfgOf(id) {
    const f = feesOf(id), c = creditOf(id), s = acctSet(id);
    const custom = {};
    (s.custom || []).forEach(x => { if (x && x.name) custom[x.name] = {broker: !!x.broker, fee: x.fee === '' || x.fee === null || x.fee === undefined ? '' : Number(x.fee), tax: x.tax === '' || x.tax === null || x.tax === undefined ? '' : Number(x.tax)}; });
    return {fees: f.fees.map(x => ({d: ser(x.from) - 1, disc: x.disc})), minFee: f.minFee, minOdd: f.minOdd, mp: c.mp, ss: c.ss, si: c.si, sf: c.sf, mi: c.mi,
      custom: custom, fifo: s.fifo !== false, nhi: nhiOf(id), histDate: 0, today: ser(todayKey())};
  }

  // ---------- 計算 ----------
  let MEMO = {};
  function compute(id) {
    const k = 'c|' + id + '|' + DB.rev + '|' + todayKey();
    if (MEMO[k]) return MEMO[k];
    const recs = DB.recs.filter(x => x.acct === id);
    const inputs = recs.map(x => ({row: x.id, d: isKey(x.d) ? ser(x.d) : null, item: x.item, name: x.name, units: x.units, price: x.price,
      custom: x.custom || '', adj: x.adj || 0, cr: x.cr || 0, dt: !!x.dt}));
    const cfg = cfgOf(id);
    const res = window.eng_compute_(inputs, cfg);
    const V = window.eng_views_(res, cfg);
    return (MEMO[k] = {res: res, V: V, cfg: cfg, recs: recs});
  }
  const accts = () => DB.set.accounts;
  const acctIds = acct => acct === '*' ? accts().map(a => a.id) : [accts().some(a => a.id === acct) ? acct : 'main'];
  const tag = (x, id) => { const a = accts().find(y => y.id === id); return Object.assign({}, x, {acct: id, acctName: a ? a.name : ''}); };
  function each(acct, f) {
    if (acct !== '*') return f(acctIds(acct)[0]);
    const all = [];
    acctIds('*').forEach(id => { try { (f(id) || []).forEach(x => all.push(tag(x, id))); } catch (e) { console.error(e); } });
    return all;
  }
  const byDateDesc = (a, b) => a.d === b.d ? (b.row || 0) - (a.row || 0) : (a.d < b.d ? 1 : -1);

  // 最近兩個收盤價（今天以前）：{代號: [最近一天, 前一天]}，算今日漲跌用
  async function lastTwo() {
    const cur = todayKey().slice(0, 7), prev = addDays(cur + '-01', -1).slice(0, 7);
    const ms = await Promise.all([month(prev), month(cur)]);
    const out = {};
    ms.forEach(m => m.d.forEach((d, i) => { if (d > todayKey()) return; Object.keys(m.c).forEach(c => { const v = m.c[c][i]; if (v !== null && v !== undefined) { const o = out[c] || (out[c] = []); o.push(v); if (o.length > 2) o.shift(); } }); }));
    return out;
  }
  // 持股（未實現）：股價用最新收盤
  async function holdings(acct) {
    const syms = await symMap();
    const two = await lastTwo().catch(() => ({}));
    const today = ser(todayKey());
    const one = id => {
      const C = compute(id), cfg = C.cfg;
      let disc = 10; cfg.fees.forEach(f => { if (f.d < today) disc = f.disc; });
      return C.V.unreal.map(u => {
        const s = syms[String(u.code).toUpperCase()];
        const F = livePx(u.code) || (s && s[3] > 0 ? s[3] : 0), E = u.E, G = F * E, short = u.short;
        const Sr = window.eng_rd_(G * 1.425 * disc / 10 / 1000);
        const T = Sr >= cfg.minFee ? Sr : Sr >= cfg.minOdd ? (E >= 1000 ? cfg.minFee : Sr) : cfg.minOdd;
        const code = String(u.code);
        const U = short ? 0 : (/^00\d+B$/.test(code) && todayKey() <= '2036-12-31') ? 0 :
          (code.charAt(0) === '0' || (code.charAt(0) === '9' && code.length === 6)) ? window.eng_rd_(G * 0.001) : window.eng_rd_(G * 0.003);
        const W = F === 0 ? 0 : short ? u.N + u.M - G - T + u.V : G - T - U + u.V - u.O;
        const L = F === 0 ? 0 : W - u.J;
        // 今日漲跌：盤中（或收盤後正式資料還沒進來）跟最近一個收盤比；否則跟前一個收盤比
        const t2 = two[code.toUpperCase()] || [];
        const lp = livePx(code), prev = lp ? t2[t2.length - 1] : t2.length > 1 ? t2[0] : null;
        const dayR = F && prev ? F / prev - 1 : null, dayPl = F && prev ? Math.round((F - prev) * E * (short ? -1 : 1)) : null;
        return {name: u.name, batch: u.batch, code: code, units: E, price: F, prev: prev || null, dayR: dayR, dayPl: dayPl, mv: G, avg: u.I, cost: u.J, pl: L, r: u.J ? L / u.J : null,
          short: short, mt: u.R || 0, loan: u.O || 0, self: u.P || 0, collat: u.M || 0, margin: u.N || 0, mtDue: u.mtDue === '' ? '' : keyOf(u.mtDue), _W: W, _uid: u.name + '_' + u.batch};
      });
    };
    const out = each(acct, one);
    return out;
  }
  const clean = l => l.map(x => { const o = Object.assign({}, x); delete o._W; delete o._uid; return o; });

  function realized(acct, from, to) {
    const out = each(acct, id => compute(id).V.realized.map(x => {
      const r = x.r;
      return {d: keyOf(r.d), item: r.item, name: r.name, units: r.units, price: r.price, batch: r.J, dt: !!r.dt, pl: x.Q, r: x.P === '' ? null : x.P, cost: x.O, out: r.AD, row: r.row};
    }).filter(x => x.d >= from && x.d <= to));
    out.sort(byDateDesc);
    return out;
  }
  async function performance(acct, from, to) {
    const H = await holdings(acct);
    const out = each(acct, id => {
      const C = compute(id);
      const hs = acct === '*' ? H.filter(h => h.acct === id) : H;
      return C.V.perf.map(p => {
        const uid = p.name + '_' + p.batch;
        const mine = hs.filter(h => h._uid === uid);
        const Lw = mine.length ? mine[0]._W : 0;
        const unreal = mine.reduce((s, h) => s + h.pl, 0);
        const O = Lw + p.I + p.H;
        const s = keyOf(p.start);
        const e = p.hold ? '' : (Lw !== 0 ? todayKey() : keyOf(p.end));
        return {name: p.name, batch: p.batch, start: s, end: e, hold: p.hold, inv: p.G, div: p.H || 0, real: p.K || 0, unreal: unreal || 0,
          pl: O === 0 ? 0 : O - p.G, r: O === 0 || !p.G ? 0 : O / p.G - 1};
      }).filter(x => !(x.start > to || (x.end && x.end < from)));
    });
    out.sort((a, b) => b.pl - a.pl);
    return out;
  }
  function records(acct, from, to) {
    const out = each(acct, id => compute(id).res.ok.map(c => ({row: c.row, d: keyOf(c.d), item: c.item, name: c.name, units: c.units, price: c.price,
      amt: c.O, fee: c.S, tax: c.U, net: c.AD, batch: c.J, dayTrade: !!c.dt, note: noteOf(id, c.row)})).filter(x => x.d >= from && x.d <= to));
    out.sort(byDateDesc);
    return out;
  }
  const noteOf = (id, row) => { const r = DB.recs.find(x => x.acct === id && x.id === row); return r ? r.note || '' : ''; };
  function dividends(acct) {
    const out = each(acct, id => compute(id).res.ok.filter(c => c.item === '現金股利' || c.item === '股票股利').map(c => ({row: c.row, d: keyOf(c.d), item: c.item,
      name: c.name, units: c.units, price: c.price, amt: c.O || 0, fee: c.S || 0, nhi: c.V || 0, net: c.AD || 0})));
    out.sort(byDateDesc);
    return out;
  }

  // 每日資產：依交易＋每日收盤價重算（取代舊版的「資產日報」）
  async function dailyOne(id) {
    const C = compute(id);
    const trades = C.res.ok.filter(c => c.T).map(c => ({key: keyOf(c.d), code: String(c.T).toUpperCase(), units: (c.G || 0) + (c.H || 0), net: c.AD || 0, price: c.price, row: c.row}));
    trades.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.row - b.row);
    const B = await pub('bench.json');
    if (!trades.length || !B) return {rows: [], status: B ? '' : '公開資料還沒準備好'};
    const start = trades[0].key, today = todayKey();
    const days = B.d.filter(d => d >= start && d <= today);
    const L = live();
    if (L && today >= start && (!days.length || days[days.length - 1] < today)) days.push(today);   // 盤中：今天還沒收盤，先用即時價算一天
    const codes = [...new Set(trades.map(t => t.code))];
    const yms = [...new Set(days.filter(d => !L || d !== today || B.d.indexOf(d) >= 0).map(d => d.slice(0, 7)))];
    const M = {};
    (await Promise.all(yms.map(month))).forEach((m, i) => M[yms[i]] = m);
    const price = {}; let missing = false;
    yms.forEach(ym => { const m = M[ym]; if (m.failed) missing = true; m.d.forEach((d, i) => codes.forEach(c => { const l = m.c[c]; if (l && l[i] !== null && l[i] !== undefined) (price[c] = price[c] || {})[d] = l[i]; })); });
    if (L) codes.forEach(c => { const p = livePx(c); if (p) (price[c] = price[c] || {})[today] = p; });
    const out = [], lastPx = {}, hold = {};
    let ti = 0, prevMV = 0, prevPL = 0, nav = 100, cumNet = 0;
    const bi = {}; B.d.forEach((d, i) => bi[d] = i);
    days.forEach(d => {
      let flow = 0;
      while (ti < trades.length && trades[ti].key <= d) {
        const t = trades[ti++];
        hold[t.code] = t.units; cumNet += t.net; flow += t.net;
        if (lastPx[t.code] === undefined && t.price > 0) lastPx[t.code] = t.price;   // 還沒有市價時，先用成交價
      }
      codes.forEach(c => { const p = (price[c] || {})[d]; if (p !== undefined) lastPx[c] = p; });
      let mv = 0;
      codes.forEach(c => { if (hold[c]) { if (lastPx[c] === undefined) missing = true; mv += hold[c] * (lastPx[c] || 0); } });
      const pl = mv + cumNet, dpl = pl - prevPL;
      const base = prevMV + Math.max(0, -flow);
      const r = base > 0 ? dpl / base : 0;
      nav = nav * (1 + r);
      const i = bi[d] !== undefined ? bi[d] : B.d.length - 1;   // 盤中的今天：大盤先沿用最近收盤
      out.push({d: d, mv: Math.round(mv), inv: Math.round(-cumNet), pl: Math.round(pl), dpl: Math.round(dpl), r: r, nav: nav,
        txp: B.tx[i], trx: B.tr ? B.tr[i] : null, e50tr: B.e50 ? B.e50[i] : null});
      prevMV = mv; prevPL = pl;
    });
    return {rows: out, status: missing ? '部分股價抓不到，市值可能偏低' : '完整'};
  }
  async function daily(acct) {
    const k = 'd|' + acct + '|' + DB.rev + '|' + (PUB.meta && PUB.meta.updated) + '|' + todayKey() + '|' + (live() ? live().rev : '');
    if (MEMO[k]) return MEMO[k];
    let D;
    if (acct !== '*') D = await dailyOne(acctIds(acct)[0]);
    else {
      const by = {}; let status = '完整';
      for (const id of acctIds('*')) {
        const r = await dailyOne(id);
        if (r.status && r.status !== '完整') status = r.status;
        r.rows.forEach(x => {
          const o = by[x.d] || (by[x.d] = {d: x.d, mv: 0, inv: 0, pl: 0, dpl: 0, txp: x.txp, trx: x.trx, e50tr: x.e50tr});
          o.mv += x.mv; o.inv += x.inv; o.pl += x.pl; o.dpl += x.dpl;
        });
      }
      const rows = Object.keys(by).sort().map(k => by[k]);
      let nav = 100, prev = null;
      rows.forEach(o => { const r = prev && prev.mv > 0 ? o.dpl / prev.mv : 0; nav *= 1 + r; o.r = r; o.nav = nav; prev = o; });
      D = {rows: rows, status: status};
    }
    D.benchTx = D.rows.length > 0 && D.rows.every(x => x.trx);
    D.benchE50 = D.rows.length > 0 && D.rows.every(x => x.e50tr);
    D.rows.forEach(x => { x.tx = D.benchTx ? x.trx : x.txp; x.e50 = D.benchE50 ? x.e50tr : null; });
    const up = PUB.meta && PUB.meta.updated ? new Date(PUB.meta.updated) : null;
    D.updated = up ? (up.getMonth() + 1) + '/' + up.getDate() + ' ' + pad(up.getHours()) + ':' + pad(up.getMinutes()) : '';
    return (MEMO[k] = D);
  }
  async function overview(acct, from, to) {
    const D = await daily(acct);
    const rows = D.rows.filter(x => x.d <= to);
    if (!rows.length) return {empty: true, status: D.status || '', hasRecs: acctIds(acct).some(id => DB.recs.some(r => r.acct === id))};
    const last = rows[rows.length - 1];
    const before = rows.filter(x => x.d < from), inR = rows.filter(x => x.d >= from);
    const b = before.length ? before[before.length - 1] : {pl: 0, nav: 100, tx: inR.length ? inR[0].tx : null, e50: inR.length ? inR[0].e50 : null};
    const ratio = (a, c) => (a && c) ? a / c - 1 : null;
    const L = live();
    return {live: L && last.d === L.day ? L.t || '' : '', asOf: last.d, updated: D.updated, status: D.status === '完整' ? '' : D.status, mv: last.mv, todayPl: last.dpl, todayR: last.r, benchTx: D.benchTx, benchE50: D.benchE50,
      rangePl: last.pl - b.pl, rangeR: ratio(last.nav, b.nav), tx: ratio(last.tx, b.tx), e50: ratio(last.e50, b.e50),
      series: inR.map(x => ({d: x.d, mv: x.mv, pl: x.pl - b.pl, r: ratio(x.nav, b.nav), tx: ratio(x.tx, b.tx), e50: ratio(x.e50, b.e50)}))};
  }

  // ---------- 除權息、分割、減資 ----------
  async function corpActions(acct) {
    const id = acctIds(acct)[0];
    const C = compute(id);
    const rows = C.res.ok.filter(c => c.T).map(c => ({d: keyOf(c.d), i: c.row, item: c.item, code: String(c.T).toUpperCase(), name: c.name, inv: (c.G || 0) + (c.H || 0)}));
    rows.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i);
    const today = todayKey();
    if (!rows.length) return {items: [], checked: today};
    const by = {}; rows.forEach(x => (by[x.code] = by[x.code] || []).push(x));
    const before = (code, d) => { const l = (by[code] || []).filter(x => x.d < d); return l.length ? l[l.length - 1].inv : 0; };
    const CAJ = await pub('ca.json');
    const CA = CAJ && CAJ.f ? {ev: CAJ.ev.map(r => { const o = {}; CAJ.f.forEach((k, i) => { if (r[i] !== null) o[k] = r[i]; }); return o; })} : CAJ;
    const dismissed = acctSet(id).dismissed || [];
    const used = {};
    const has = (code, its, from, to) => {
      const hit = (by[code] || []).find(x => its.indexOf(x.item) >= 0 && x.d >= from && x.d <= to && !used[x.code + x.i]);
      if (hit) used[hit.code + hit.i] = 1;
      return !!hit;
    };
    const nameOf = code => by[code][by[code].length - 1].name;
    const items = [];
    const push = o => { o.key = (id !== 'main' ? id + ':' : '') + o.code + '|' + o.date + '|' + o.type; if (dismissed.indexOf(o.key) >= 0) return; o.name = nameOf(o.code); items.push(o); };
    ((CA && CA.ev) || []).forEach(e => {
      if (!by[e.code] || e.date < rows[0].d || e.date > today) return;
      const shares = before(e.code, e.date);
      if (!(shares > 0)) return;
      if (e.kind === 'div') {
        let cash = e.cash, perK = e.perK;
        if (e.mkt === 'twse') {
          if (e.tag === '息') { cash = e.val; perK = 0; }
          if (e.tag !== '息' || !(cash > 0)) {
            const rec = (by[e.code] || []).filter(x => (x.item === '現金股利' || x.item === '股票股利') && x.d >= addDays(e.date, -15) && x.d <= addDays(e.date, 75) && !used[x.code + x.i]);
            const need = e.tag === '權息' ? 2 : 1;
            if (rec.length >= need) { rec.slice(0, need).forEach(x => used[x.code + x.i] = 1); return; }
            if (e.cash === undefined && e.perK === undefined) return;
            cash = e.cash || 0; perK = e.perK || 0;
          }
        }
        if (cash > 0 && !has(e.code, ['現金股利'], addDays(e.date, -15), addDays(e.date, 75)))
          push({type: 'cash', code: e.code, date: e.date, shares: shares, item: '現金股利', units: shares, price: Math.round(cash * 1e6) / 1e6, est: Math.floor(shares * cash)});
        if (perK > 0 && !has(e.code, ['股票股利'], addDays(e.date, -15), addDays(e.date, 75)))
          push({type: 'stock', code: e.code, date: e.date, shares: shares, item: '股票股利', units: Math.floor(shares * perK / 1000), price: 0, perK: perK});
      } else if (e.kind === 'split' || e.kind === 'rsplit') {
        const item = e.kind === 'split' ? '股票分割' : '股票反分割';
        if (!e.ratio || has(e.code, [item], addDays(e.date, -30), addDays(e.date, 60))) return;
        push({type: e.kind, code: e.code, date: e.date, shares: shares, item: item, units: e.ratio, price: 0, after: e.kind === 'split' ? shares * e.ratio : shares / e.ratio});
      } else if (e.kind === 'reduce') {
        if (has(e.code, ['股票反分割'], addDays(e.date, -30), addDays(e.date, 60))) return;
        push({type: 'reduce', code: e.code, date: e.date, shares: shares, item: '股票反分割', units: e.ratio, price: 0, why: e.why, needInput: !e.ratio});
      }
    });
    items.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const pend = {};
    items.forEach(o => { if (pend[o.code]) o.afterPending = true; if (/split|reduce/.test(o.type)) pend[o.code] = 1; });
    return {items: items, checked: today};
  }

  // ---------- 寫入檢查 ----------
  function check(rec) {
    if (ITEMS.indexOf(rec.item) < 0) err('不支援的項目：' + rec.item);
    if (!isKey(rec.date)) err('日期格式錯誤');
    if (!rec.name || !/（.+）$/.test(rec.name)) err('股票請用「名稱（代號）」格式');
    if (!(rec.units > 0)) err(/分割/.test(rec.item) ? '比例要大於 0' : '股數要大於 0');
    if (['買進', '賣出', '現金股利', '融資買進', '融資賣出', '融券賣出', '融券買進', '保證金追繳', '現金增資'].indexOf(rec.item) >= 0 && !(rec.price > 0))
      err(rec.item === '保證金追繳' ? '金額要大於 0' : '價格要大於 0');
  }
  async function register(name, id) {
    const C = codeOf(name).toUpperCase();
    if (!C) return;
    if (DB.recs.some(x => x.acct === id && codeOf(x.name).toUpperCase() === C)) return;
    const m = await symMap();
    if (!m[C] && !(DB.set.manualSyms || []).some(x => String(x[0]).toUpperCase() === C)) err('找不到代號 ' + codeOf(name) + '，請確認是上市、上櫃或興櫃股票');
  }
  const DT_ITEMS = ['買進', '賣出', '融資買進', '融資賣出', '融券賣出', '融券買進'];
  const NO_PRICE = ['股票股利', '股票分割', '股票反分割', '融資現償'];
  const toRec = (rec, id, nid) => ({acct: id, id: nid, d: rec.date, item: rec.item, name: rec.name, units: Number(rec.units),
    price: NO_PRICE.indexOf(rec.item) >= 0 ? 0 : Number(rec.price), custom: rec.custom || '', adj: Number(rec.adj) || 0, cr: Number(rec.cr) || 0,
    dt: !!rec.dayTrade && DT_ITEMS.indexOf(rec.item) >= 0, note: String(rec.note || '').trim().slice(0, 500)});
  const engRow = (id, rowId) => { const c = compute(id).res.ok.find(x => x.row === rowId); return c ? {row: c.row, item: c.item, name: c.name, amt: c.O, fee: c.S, tax: c.U, net: c.AD, batch: c.J} : {row: rowId}; };
  const writeOnly = acct => { if (acct === '*') err('「全部帳戶」只能查看，請先在選單選擇一個帳戶'); return acctIds(acct)[0]; };
  function verify(x, expect) {
    if (!x) err('找不到這筆紀錄，請重新整理後再試');
    if (expect && (x.d !== expect.d || x.item !== expect.item || x.name !== expect.name)) err('這筆紀錄已經變動，請重新整理後再試');
  }

  function settingsOut(id) {
    const f = feesOf(id);
    return {fees: f.fees, minFee: f.minFee, minOdd: f.minOdd, credit: creditOf(id), plans: DB.set.plans || [],
      sheetUrl: FILE ? 'https://docs.google.com/spreadsheets/d/' + FILE.id + '/edit' : '', dismissed: (acctSet(id).dismissed || []).length,
      accounts: accountsOut(), nhi: nhiOf(id)};
  }
  const accountsOut = () => accts().map(a => ({id: a.id, name: a.name, url: FILE ? 'https://docs.google.com/spreadsheets/d/' + FILE.id + '/edit' : ''}));

  async function prices(code, dates) {
    code = String(code).trim().toUpperCase();
    if (!/^[0-9A-Z]{4,6}$/.test(code)) err('代號格式錯誤');
    const out = {};
    for (const d of (dates || []).slice(0, 40)) {
      if (!isKey(d)) continue;
      let ym = d.slice(0, 7);
      for (let k = 0; k < 2; k++) {
        const m = await month(ym), l = m.c[code];
        if (l) { const i = m.d.findIndex((x, j) => x >= d && l[j] !== null); if (i >= 0) { out[d] = {d: m.d[i], p: l[i]}; break; } }
        ym = addDays(ym + '-28', 5).slice(0, 7);
        if (ym > todayKey().slice(0, 7)) break;
      }
    }
    return out;
  }

  // ---------- API ----------
  const API = {
    async appOverview(acct, from, to) { await load(); await meta(); return overview(acct, from, to); },
    async appHoldings(acct) { await load(); return clean(await holdings(acct)); },
    async appRealized(acct, from, to) { await load(); return realized(acct, from, to); },
    async appPerformance(acct, from, to) { await load(); return performance(acct, from, to); },
    async appRecords(acct, from, to) { await load(); return records(acct, from, to); },
    async appCalendar(acct, from, to) {
      await load(); await meta();
      const D = await daily(acct);
      return {days: D.rows.filter(x => x.d >= from && x.d <= to).map(x => ({d: x.d, pl: x.dpl, r: x.r})), trades: records(acct, from, to), realized: realized(acct, from, to)};
    },
    async appMeta(acct) {
      await load();
      const by = {};
      acctIds(acct).forEach(id => compute(id).V.stocks.forEach(s => { const x = by[s.name] || (by[s.name] = {name: s.name, code: s.code, held: 0, short: 0}); x.held += s.held; x.short += s.ss; }));
      const id = acctIds(acct)[0], f = feesOf(id), now = todayKey();
      let disc = 10; f.fees.forEach(x => { if (x.from <= now) disc = x.disc; });
      return {stocks: Object.keys(by).map(k => by[k]), disc: disc, fees: f.fees, minFee: f.minFee, minOdd: f.minOdd, credit: creditOf(id), today: now};
    },
    async appLookup(acct, code) { code = String(code).trim().toUpperCase(); const m = await symMap(); const s = m[code]; return s ? s[1] + '（' + code + '）' : ''; },
    async appSymbols() {
      await meta(true);
      const l = await symList();
      await load().catch(() => null);
      const manual = DB && DB.set.manualSyms ? DB.set.manualSyms.map(x => [String(x[0]).toUpperCase(), String(x[1]), '自訂', null]) : [];
      const seen = {}; l.forEach(x => seen[x[0]] = 1);
      return {at: PUB.meta.updated ? Date.parse(PUB.meta.updated) : 0, list: l.concat(manual.filter(x => !seen[x[0]]))};
    },
    async appSettings(acct) { await load(); return settingsOut(acctIds(acct === '*' ? 'main' : acct)[0]); },
    async appAccounts() { await load(); return accountsOut(); },
    async appCorpActions(acct) { await load(); if (acct === '*') { const items = []; let checked = ''; for (const id of acctIds('*')) { const r = await corpActions(id); if (r.checked > checked) checked = r.checked; r.items.forEach(x => items.push(tag(x, id))); } items.sort((a, b) => a.date < b.date ? -1 : 1); return {items: items, checked: checked}; } return corpActions(acct); },
    async appDividends(acct) { await load(); return dividends(acct); },
    async appPrices(acct, code, dates) { return prices(code, dates); },
    // 個股走勢＋買賣點：from 起每天收盤（盤中多一天即時價），和這檔的買進、賣出紀錄
    async appStockChart(acct, code, from, to, all) {
      await load(); await meta();
      code = String(code).trim().toUpperCase();
      const T = ['買進', '賣出', '融資買進', '融資賣出', '融券賣出', '融券買進'];
      const trades = records(acct, '1900-01-01', '9999-12-31').filter(r => T.indexOf(r.item) >= 0 && codeOf(r.name).toUpperCase() === code)
        .map(r => ({d: r.d, item: r.item, units: r.units, price: r.price, batch: r.batch, dt: r.dayTrade, side: /買/.test(r.item) ? 'b' : 's'}));
      trades.sort((a, b) => a.d < b.d ? -1 : 1);
      if (all) from = trades.length ? addDays(trades[0].d, -20) : addDays(todayKey(), -365);   // 全部：從第一筆交易前 20 天開始
      if (PUB.meta && PUB.meta.start && from < PUB.meta.start) from = PUB.meta.start;
      const today = to && to < todayKey() ? to : todayKey(), yms = [];
      for (let ym = from.slice(0, 7); ym <= today.slice(0, 7); ym = addDays(ym + '-28', 5).slice(0, 7)) yms.push(ym);
      const ms = await Promise.all(yms.map(month));
      const d = [], p = [];
      ms.forEach(m => { const l = m.c[code]; if (!l) return; m.d.forEach((x, i) => { if (x >= from && x <= today && l[i] !== null && l[i] !== undefined) { d.push(x); p.push(l[i]); } }); });
      const lp = livePx(code);
      if (lp && today === todayKey() && (!d.length || d[d.length - 1] < today)) { d.push(today); p.push(lp); }
      return {code: code, from: from, d: d, p: p, trades: trades};
    },
    async appProfile() {
      await load();
      const u = await userinfo();
      return {name: u.name, picture: u.picture, email: u.email, nick: DB.set.nick || ''};
    },
    async appSaveProfile(acct, o) {
      const nick = String((o && o.nick) || '').trim().slice(0, 20);
      await mutate(db => { if (nick) db.set.nick = nick; else delete db.set.nick; });
      const u = await userinfo();
      return {name: u.name, picture: u.picture, email: u.email, nick: nick};
    },
    // 匯出用：每筆紀錄的輸入與計算結果（欄位對照舊版 LOG）
    async appExportRows(acct) {
      await load();
      const out = [];
      acctIds(acct).forEach(id => {
        const C = compute(id), aName = (accts().find(a => a.id === id) || {}).name || '';
        const pl = {}; C.V.realized.forEach(x => pl[x.r.row] = x.Q);
        C.res.ok.forEach(c => {
          const r = DB.recs.find(x => x.acct === id && x.id === c.row) || {};
          out.push({acctName: aName, d: keyOf(c.d), item: c.item, name: c.name, code: c.T, units: c.units, price: c.price, dt: !!c.dt, custom: r.custom || '', adj: r.adj || 0, cr: r.cr || 0,
            amt: c.O, fee: c.S, tax: c.U, nhi: c.V, sf: c.W, int: c.X, collat: c.Y, margin: c.Z, loan: c.AA, repayCost: c.AB, net: c.AD, batch: c.J,
            inv: c.F, spot: c.G, mt: c.H, ss: c.I, avg: c.AE === '' ? '' : Math.round(c.AE * 100) / 100, fifoCost: c.AF, fifoIn: c.Q, pl: pl[c.row] === undefined ? '' : Math.round(pl[c.row]), note: r.note || ''});
        });
      });
      return out;
    },
    async appRefresh() { await meta(true); PUB.json = {}; await load(true); return (await daily('main')).updated; },

    async appAddRecord(acct, rec) {
      const id = writeOnly(rec.acct || acct); check(rec); await load(); await register(rec.name, id);
      let nid;
      await mutate(db => { nid = db.nextId++; db.recs.push(toRec(rec, id, nid)); });
      return engRow(id, nid);
    },
    async appAddRecords(acct, list) {
      if (!Array.isArray(list) || !list.length) err('沒有要新增的紀錄');
      if (list.length > 200) err('一次最多 200 筆');
      list.forEach(check); await load();
      const ids = list.map(r => writeOnly(r.acct || acct));
      for (let i = 0; i < list.length; i++) await register(list[i].name, ids[i]);
      const order = list.map((r, i) => i).sort((a, b) => list[a].date < list[b].date ? -1 : list[a].date > list[b].date ? 1 : a - b);
      const nids = [];
      await mutate(db => { order.forEach(i => { const nid = db.nextId++; nids[i] = nid; db.recs.push(toRec(list[i], ids[i], nid)); }); });
      return order.map(i => engRow(ids[i], nids[i]));
    },
    // 匯入對帳單：手續費和稅用對帳單上的實際金額（存成「匯入：手續費 N／稅 M」的自訂費用，不套用折扣設定）
    async appImportRecords(acct, list) {
      if (!Array.isArray(list) || !list.length) err('沒有要匯入的紀錄');
      if (list.length > 2000) err('一次最多 2000 筆');
      const id = writeOnly(acct);
      list.forEach(r => { check(r); if (!(r.fee >= 0) || !(r.tax >= 0)) err('手續費或稅金格式錯誤'); });
      await load();
      const codes = [...new Set(list.map(r => r.name))];
      for (const n of codes) await register(n, id);
      const tag = r => '匯入：手續費 ' + r.fee + '／稅 ' + r.tax;
      const order = list.map((r, i) => i).sort((a, b) => list[a].date < list[b].date ? -1 : list[a].date > list[b].date ? 1 : a - b);
      await mutate(db => {
        const s = acctSet(id); s.custom = Array.isArray(s.custom) ? s.custom : [];
        list.forEach(r => { const n = tag(r); if (!s.custom.some(x => x && x.name === n)) s.custom.push({name: n, broker: false, fee: r.fee, tax: r.tax}); });
        order.forEach(i => { const nid = db.nextId++; db.recs.push(toRec(Object.assign({}, list[i], {custom: tag(list[i])}), id, nid)); });
      });
      return {added: list.length};
    },
    // 清除交易紀錄：先預覽（go=false 回傳筆數和備份用的明細），確認後再刪（go=true，筆數要和預覽一致）
    async appClearPreview(acct, o) { return API.appClearRecords(acct, o, false); },
    async appClearRecords(acct, o, go) {
      o = o || {};
      const id = writeOnly(acct);
      if (o.from && !isKey(o.from) || o.to && !isKey(o.to)) err('日期格式錯誤');
      await load();
      const pick = x => x.acct === id && (!o.from || x.d >= o.from) && (!o.to || x.d <= o.to) && (!o.imported || /^匯入：/.test(x.custom || ''));
      if (!go) {
        const calc = {}; try { compute(id).res.ok.forEach(c => calc[c.row] = c); } catch (e) {}
        const rows = DB.recs.filter(pick).map(x => { const c = calc[x.id] || {};
          return {d: x.d, item: x.item, name: x.name, units: x.units, price: x.price, dt: !!x.dt, fee: c.S, tax: c.U, net: c.AD, custom: x.custom || '', note: x.note || ''}; });
        return {count: rows.length, rows: rows};
      }
      let n = 0;
      await mutate(db => {
        n = db.recs.filter(pick).length;
        if (o.expect !== undefined && n !== o.expect) err('紀錄剛剛有變動，請關掉重新開啟再試一次');
        db.recs = db.recs.filter(x => !pick(x));
      });
      return {removed: n};
    },
    async appUpdateRecord(acct, row, expect, rec) {
      const id = writeOnly(acct); check(rec); await load(); await register(rec.name, id);
      await mutate(db => {
        const x = db.recs.find(r => r.acct === id && r.id === row); verify(x, expect);
        const n = toRec(rec, id, row); n.custom = x.custom; n.adj = x.adj; n.cr = x.cr;
        Object.assign(x, n);
      });
      return engRow(id, row);
    },
    async appDeleteRecord(acct, row, expect) {
      const id = writeOnly(acct);
      await mutate(db => { const i = db.recs.findIndex(r => r.acct === id && r.id === row); verify(db.recs[i], expect); db.recs.splice(i, 1); });
      return true;
    },
    async appSaveFees(acct, fees, minFee, minOdd) {
      const id = writeOnly(acct);
      if (!Array.isArray(fees) || !fees.length) err('至少要有一段手續費折扣');
      if (fees.length > 12) err('最多 12 段');
      const list = fees.map((f, i) => {
        const disc = Number(f.disc);
        if (!(disc > 0 && disc <= 10)) err('折數要介於 0.1～10 折');
        const from = i === 0 ? FEE_FLOOR : String(f.from);
        if (!isKey(from)) err('日期格式錯誤');
        return {from: from, disc: Math.round(disc * 100) / 100};
      }).sort((a, b) => a.from < b.from ? -1 : 1);
      for (let i = 1; i < list.length; i++) if (list[i].from === list[i - 1].from) err('有兩段的起始日相同');
      list[0].from = FEE_FLOOR;
      minFee = Number(minFee); minOdd = Number(minOdd);
      if (!(minFee >= 0 && minFee <= 1000) || !(minOdd >= 0 && minOdd <= 1000)) err('最低手續費格式錯誤');
      await mutate(db => { const s = acctSet(id); s.fees = list; s.minFee = minFee; s.minOdd = minOdd; });
      return settingsOut(id);
    },
    async appSaveCredit(acct, o) {
      const id = writeOnly(acct);
      const chk = (v, lo, hi, m) => { v = Number(v); if (!(v >= lo && v <= hi)) err(m); return v; };
      const c = {mp: chk(o.mp, 0, 10, '融資成數要介於 0～10'), ss: chk(o.ss, 0, 20, '融券保證金成數要介於 0～20'), mi: chk(o.mi, 0, 0.3, '融資利率格式錯誤'),
        si: chk(o.si, 0, 0.3, '融券利率格式錯誤'), sf: chk(o.sf, 0, 0.05, '借券費率格式錯誤')};
      await mutate(() => { acctSet(id).credit = c; });
      return settingsOut(id);
    },
    async appSaveOptions(acct, o) {
      const id = writeOnly(acct);
      await mutate(() => { if (o && o.nhi !== undefined) acctSet(id).nhi = !!o.nhi; });
      return settingsOut(id);
    },
    async appSavePlans(acct, plans) {
      if (!Array.isArray(plans) || plans.length > 20) err('定期定額最多 20 筆');
      await load();
      const clean = plans.map(p => {
        if (!p.name || !/（.+）$/.test(p.name)) err('股票請用「名稱（代號）」格式');
        const days = (p.days || []).map(Number).filter(d => d >= 1 && d <= 31);
        if (!days.length) err('請設定每月扣款日');
        if (!(Number(p.amount) >= 100)) err('每次金額至少 100 元');
        if (!isKey(p.start)) err('開始日期格式錯誤');
        return {id: String(p.id || Math.random().toString(36).slice(2, 10)), name: String(p.name), days: [...new Set(days)].sort((a, b) => a - b),
          amount: Math.round(Number(p.amount)), start: p.start, active: p.active !== false, acct: accts().some(x => x.id === p.acct) ? p.acct : 'main'};
      });
      await mutate(db => { db.set.plans = clean; });
      return clean;
    },
    async appDismissAction(acct, key) {
      const id = acctIds(acct === '*' ? (String(key).match(/^([a-z0-9]+):/) || [0, 'main'])[1] : acct)[0];
      let n = 0;
      await mutate(() => {
        const s = acctSet(id);
        if (key === '__reset__') { s.dismissed = []; return; }
        const l = s.dismissed || [];
        if (l.indexOf(key) < 0) l.push(String(key).slice(0, 60));
        s.dismissed = l.slice(-300); n = s.dismissed.length;
      });
      return n;
    },
    async appCreateAccount(acct, name) {
      name = String(name || '').trim().slice(0, 20);
      if (!name) err('請輸入帳戶名稱');
      await load();
      if (accts().length >= 8) err('最多 8 個帳戶');
      if (accts().some(a => a.name === name)) err('已經有同名的帳戶');
      await mutate(db => { db.set.accounts.push({id: 'a' + Date.now().toString(36), name: name}); });
      return accountsOut();
    },
    async appRenameAccount(acct, id, name) {
      name = String(name || '').trim().slice(0, 20);
      if (!name) err('請輸入帳戶名稱');
      await mutate(db => { const a = db.set.accounts.find(x => x.id === id); if (!a) err('找不到這個帳戶'); a.name = name; });
      return accountsOut();
    },
    async appRemoveAccount(acct, id) {
      if (id === 'main') err('主帳戶不能移除');
      await mutate(db => {
        db.set.accounts = db.set.accounts.filter(x => x.id !== id);
        // 紀錄不刪，移到「已移除的帳戶」底下保留在試算表裡
        db.recs.forEach(r => { if (r.acct === id) r.acct = 'removed-' + id; });
      });
      return accountsOut();
    }
  };

  window.ZQ = {
    call: (fn, args, acct) => { const f = API[fn]; if (!f) return Promise.reject(new Error('不支援的功能：' + fn)); return f.apply(null, [acct === undefined ? 'main' : acct].concat(args || [])); },
    signIn: signIn, signOut: signOut, takeRedirect: takeRedirect, signedIn: signedIn, tokenOk: tokenOk, whoami: whoami,
    ready: () => !!CLIENT_ID, fileUrl: () => FILE ? 'https://docs.google.com/spreadsheets/d/' + FILE.id + '/edit' : '',
    _db: () => DB
  };
})();
