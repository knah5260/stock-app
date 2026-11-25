// 每天由 GitHub Actions 執行：抓證交所、櫃買中心的公開資料，存成 data/ 底下的 JSON 給 App 讀。
// 不需要任何金鑰。抓過的日子會記住，下次只補沒抓到的。
//   data/px/YYYY-MM.json  每月所有上市櫃股票、ETF 的每日收盤價 {d:[日期], c:{代號:[收盤或 null]}}
//   data/bench.json       加權指數、加權報酬指數、0050 含息指數（每個交易日）
//   data/symbols.json     代號表（上市、上櫃、興櫃）與最新收盤價
//   data/ca.json          除權息、分割、反分割、減資事件
//   data/state.json       抓取進度（哪些日子抓過、哪些是休市）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const START = process.env.START || '2018-01-01';            // 最早補到哪天
const BUDGET = (+process.env.BUDGET_MIN || 40) * 60e3;       // 這次最多跑多久
const T0 = Date.now();
const timeLeft = () => BUDGET - (Date.now() - T0);
const UA = {'User-Agent': 'Mozilla/5.0 (stock-app data bot; +https://github.com/knah5260/stock-app)', 'Accept': 'application/json'};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } };
const writeJ = (f, o) => { const p = path.join(DATA, f); fs.mkdirSync(path.dirname(p), {recursive: true}); fs.writeFileSync(p, JSON.stringify(o)); };
const num = s => { if (typeof s === 'number') return s; const v = parseFloat(String(s ?? '').replace(/,/g, '')); return isNaN(v) ? null : v; };
const roc = s => { // 115/11/24、115年11月24日、1151124 → 2026-11-24
  s = String(s).trim();
  let m = s.match(/^(\d{2,3})\D(\d{1,2})\D(\d{1,2})/) || s.match(/^(\d{3})(\d{2})(\d{2})$/);
  return m ? (+m[1] + 1911) + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : '';
};
const twNow = () => new Date(Date.now() + 8 * 3600e3);       // 台北時間
const TODAY = twNow().toISOString().slice(0, 10);
const HOUR = twNow().getUTCHours();
const addDays = (k, n) => { const d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ratio = (a, b) => { if (!(a > 0 && b > 0)) return null; const r = a / b, n = Math.round(r); return Math.abs(r - n) < 0.03 * n ? n : Math.round(r * 10000) / 10000; };

// ---- 連線：各網站分開限速（證交所太快會被暫時封鎖）----
const gap = {twse: 2600, tpex: 1500, other: 300}, last = {};
let twseBlocked = false;
async function getJ(url) {
  const host = /twse\.com\.tw/.test(url) && !/openapi/.test(url) ? 'twse' : /tpex\.org\.tw/.test(url) && !/openapi/.test(url) ? 'tpex' : 'other';
  if (host === 'twse' && twseBlocked) return null;
  for (let i = 0; i < 3; i++) {
    const w = (last[host] || 0) + gap[host] - Date.now();
    if (w > 0) await sleep(w);
    last[host] = Date.now();
    try {
      const r = await fetch(url, {headers: UA, signal: AbortSignal.timeout(30000)});
      const t = await r.text();
      if (r.ok && /^\s*[\[{]/.test(t)) return JSON.parse(t);
      if (host === 'twse' && /<html/i.test(t)) { console.log('證交所回傳網頁（可能限流），等一下再試'); await sleep(20000 * (i + 1)); continue; }
      console.log('HTTP', r.status, url);
    } catch (e) { console.log('失敗', url, String(e.message || e)); }
    await sleep(4000 * (i + 1));
  }
  if (host === 'twse') { twseBlocked = true; console.log('證交所連續失敗，這次先停止抓證交所'); }
  return null;
}

// ---- 每日收盤 ----
const state = readJ('state.json', {tw: {}, tp: {}});
const months = {};
const month = ym => months[ym] || (months[ym] = Object.assign({d: [], c: {}, dirty: false}, readJ('px/' + ym + '.json', {})));
const bench = readJ('bench.json', {d: [], tx: [], tr: []});
const benchMap = {}; bench.d.forEach((d, i) => benchMap[d] = [bench.tx[i], bench.tr[i]]);
const names = {};   // 代號 → [名稱, 市場]，取最新一天

function putDay(date, prices) {   // prices: {code: close|null}
  const M = month(date.slice(0, 7));
  let i = M.d.indexOf(date);
  if (i < 0) {
    M.d.push(date); M.d.sort(); i = M.d.indexOf(date);
    Object.keys(M.c).forEach(k => M.c[k].splice(i, 0, null));
  }
  Object.keys(prices).forEach(code => {
    if (!M.c[code]) M.c[code] = M.d.map(() => null);
    M.c[code][i] = prices[code];
  });
  M.dirty = true;
}

async function twseDay(date) {
  const j = await getJ('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=' + date.replace(/-/g, '') + '&type=ALLBUT0999&response=json');
  if (!j) return 'error';
  if (j.stat !== 'OK' || !j.tables) return 'none';
  const all = j.tables.flatMap(t => t.data || []);
  const tx = all.find(r => r[0] === '發行量加權股價指數'), tr = all.find(r => r[0] === '發行量加權股價報酬指數');
  const tb = j.tables.find(t => (t.fields || []).indexOf('證券代號') >= 0 && (t.fields || []).indexOf('收盤價') >= 0);
  if (!tb || !tb.data || !tb.data.length) return 'none';
  const f = tb.fields, ci = f.indexOf('證券代號'), ni = f.indexOf('證券名稱'), pi = f.indexOf('收盤價');
  const px = {};
  tb.data.forEach(r => { const c = String(r[ci]).trim(); if (!c) return; px[c] = num(r[pi]); if (!names[c] || names[c][2] < date) names[c] = [String(r[ni]).trim(), '上市', date]; });
  putDay(date, px);
  if (tx) benchMap[date] = [num(tx[1]), tr ? num(tr[1]) : null];
  return 'ok';
}
async function tpexDay(date) {
  const j = await getJ('https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=' + date.replace(/-/g, '/') + '&type=EW&response=json');
  if (!j) return 'error';
  const tb = (j.tables || [])[0];
  if (!tb || !tb.data || !tb.data.length) return 'none';
  const f = tb.fields.map(x => String(x).trim()), ci = f.indexOf('代號'), ni = f.indexOf('名稱'), pi = f.indexOf('收盤');
  const px = {};
  tb.data.forEach(r => { const c = String(r[ci]).trim(); if (!c) return; px[c] = num(r[pi]); if (!names[c] || names[c][2] < date) names[c] = [String(r[ni]).trim(), '上櫃', date]; });
  putDay(date, px);
  return 'ok';
}

// 要抓的日子：平日、還沒抓過；新的先抓。最近 4 天就算判定休市，下次也會再確認一次。
function pending(key) {
  const out = [];
  for (let d = TODAY; d >= START; d = addDays(d, -1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (d === TODAY && HOUR < 14) continue;            // 今天收盤資料還沒出來
    const v = state[key][d];
    if (v === 1) continue;
    if (v === 0 && d < addDays(TODAY, -4)) continue;
    out.push(d);
  }
  return out;
}
async function runDays(key, fn) {
  let n = 0;
  for (const d of pending(key)) {
    if (timeLeft() < 3 * 60e3) break;
    const r = await fn(d);
    if (r === 'error') { if (key === 'tw' && twseBlocked) break; continue; }
    state[key][d] = r === 'ok' ? 1 : 0;
    n++;
    if (n % 50 === 0) console.log(key, '已處理', n, '天，目前到', d);
  }
  console.log(key, '這次處理', n, '天，剩', pending(key).length, '天');
}

// ---- 除權息、分割、減資 ----
async function corpActions() {
  const ca = readJ('ca.json', {ev: [], years: {}, detail: {}});
  const y0 = +START.slice(0, 4), y1 = +TODAY.slice(0, 4);
  const ev = ca.ev.filter(e => e.src === 'tw49' || e.src === 'tp49');
  const keepYear = (src, y) => { for (let i = ev.length - 1; i >= 0; i--) if (ev[i].src === src && ev[i].date.slice(0, 4) === String(y)) ev.splice(i, 1); };
  for (let y = y1; y >= y0; y--) {
    if (timeLeft() < 2 * 60e3) break;
    const fresh = y >= y1 - (+TODAY.slice(5, 7) <= 1 ? 1 : 0);   // 今年（一月時連去年）每次都更新
    if (!fresh && ca.years['tw' + y] && ca.years['tp' + y]) continue;
    const end = y === y1 ? TODAY : y + '-12-31';
    const tw = await getJ('https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=' + y + '0101&endDate=' + end.replace(/-/g, '') + '&response=json');
    if (tw) {
      keepYear('tw49', y);
      (tw.data || []).forEach(r => ev.push({src: 'tw49', mkt: 'twse', date: roc(r[0]), code: String(r[1]).trim(), kind: 'div', tag: String(r[6]).trim(), val: num(r[5])}));
      ca.years['tw' + y] = 1;
    }
    const tp = await getJ('https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=' + y + '/01/01&endDate=' + end.replace(/-/g, '/') + '&response=json');
    const tb = tp && tp.tables && tp.tables[0];
    if (tb) {
      keepYear('tp49', y);
      const fi = k => tb.fields.indexOf(k);
      (tb.data || []).forEach(r => ev.push({src: 'tp49', mkt: 'tpex', date: roc(r[0]), code: String(r[1]).trim(), kind: 'div', tag: String(r[fi('權/息')]).trim(),
        cash: num(r[fi('現金股利')]), perK: num(r[fi('每仟股無償配股')])}));
      ca.years['tp' + y] = 1;
    }
  }
  // 上市的「權」「權息」要查明細才知道配多少
  for (const e of ev) {
    if (e.mkt !== 'twse' || e.tag === '息') continue;
    const k = e.code + '|' + e.date;
    if (!ca.detail[k] && timeLeft() > 2 * 60e3) {
      const j = await getJ('https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail?STK_NO=' + e.code + '&T1=' + e.date.replace(/-/g, '') + '&response=json');
      const r = j && j.data && j.data[0];
      if (r) ca.detail[k] = {cash: num(String(r[2]).replace(/[^\d.]/g, '')) || 0, perK: num(String(r[4]).replace(/[^\d.]/g, '')) || 0};
      else if (j) ca.detail[k] = {cash: 0, perK: 0, none: 1};
    }
    if (ca.detail[k]) { e.cash = ca.detail[k].cash; e.perK = ca.detail[k].perK; }
  }
  // 分割、反分割、變更面額、減資（整段期間，每次重抓）
  const s = START.replace(/-/g, ''), e = TODAY.replace(/-/g, '');
  const a = await getJ('https://www.twse.com.tw/rwd/zh/split/TWTCAU?startDate=' + s + '&endDate=' + e + '&response=json');
  const b = await getJ('https://www.twse.com.tw/rwd/zh/change/TWTB8U?startDate=' + s + '&endDate=' + e + '&response=json');
  const r1 = await getJ('https://www.twse.com.tw/rwd/zh/reducation/TWTAUU?startDate=' + s + '&endDate=' + e + '&response=json');
  const r2 = await getJ('https://www.tpex.org.tw/www/zh-tw/bulletin/revivt?startDate=' + START.replace(/-/g, '/') + '&endDate=' + TODAY.replace(/-/g, '/') + '&response=json');
  const old = ca.ev.filter(x => x.src === 'sp');
  const sp = [];
  if (a && b && r1 && r2) {
    (a.data || []).forEach(r => {
      const rev = /反分割/.test(r[3]);
      sp.push({src: 'sp', date: roc(r[0]), code: String(r[1]).trim(), kind: rev ? 'rsplit' : 'split', ratio: rev ? ratio(num(r[5]), num(r[4])) : ratio(num(r[4]), num(r[5]))});
    });
    (b.data || []).forEach(r => {
      const close = num(r[3]), ref = num(r[4]);
      sp.push(close > ref ? {src: 'sp', date: roc(r[0]), code: String(r[1]).trim(), kind: 'split', ratio: ratio(close, ref)}
        : {src: 'sp', date: roc(r[0]), code: String(r[1]).trim(), kind: 'rsplit', ratio: ratio(ref, close)});
    });
    const red = (rows, mkt) => (rows || []).forEach(r => {
      const close = num(r[3]), ref = num(r[4]), why = String(r[9] || '').trim();
      sp.push({src: 'sp', date: roc(r[0]), code: String(r[1]).trim(), kind: 'reduce', why: why, mkt: mkt, ratio: /退還/.test(why) ? null : ratio(ref, close)});
    });
    red(r1.data, 'twse');
    red(r2.tables && r2.tables[0] && r2.tables[0].data, 'tpex');
  }
  ca.ev = ev.concat(sp.length ? sp : old).filter(x => x.date).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
  ca.at = new Date().toISOString();
  writeJ('ca.json', ca);
  return ca;
}

// ---- 代號表 ----
async function symbols() {
  const old = readJ('symbols.json', {list: []});
  const map = {};
  old.list.forEach(x => map[x[0]] = x.slice());
  // 名稱、市場：以最新抓到的那天為準；收盤價：各代號最近一次有成交的價格
  const yms = fs.readdirSync(path.join(DATA, 'px')).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort().slice(-2).map(f => f.slice(0, 7));
  const lastPx = {};
  yms.forEach(ym => { const M = month(ym); Object.keys(M.c).forEach(k => M.c[k].forEach(v => { if (v !== null) lastPx[k] = v; })); });
  // 補上名稱：最近一天的資料如果這次沒抓，從官方 OpenAPI 補
  if (!Object.keys(names).length) {
    const tw = await getJ('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
    (tw || []).forEach(o => { const c = String(o.Code).trim(); if (c) names[c] = [String(o.Name).trim(), '上市', '']; });
    const tp = await getJ('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes');
    (tp || []).forEach(o => { const c = String(o.SecuritiesCompanyCode).trim(); if (c && !names[c]) names[c] = [String(o.CompanyName).trim(), '上櫃', '']; });
  }
  Object.keys(names).forEach(c => { map[c] = [c, names[c][0], names[c][1], lastPx[c] ?? (map[c] ? map[c][3] : null)]; });
  Object.keys(map).forEach(c => { if (lastPx[c] !== undefined) map[c][3] = lastPx[c]; });
  const esb = await getJ('https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics');
  (esb || []).forEach(o => {
    const c = String(o.SecuritiesCompanyCode).trim();
    if (!c || (map[c] && map[c][2] !== '興櫃')) return;
    const p = [o.LatestPrice, o.Average, o.PreviousAveragePrice].map(parseFloat).find(x => x > 0);
    map[c] = [c, String(o.CompanyName).trim(), '興櫃', p || null];
  });
  const list = Object.keys(map).sort().map(k => map[k]);
  if (list.length > 500) writeJ('symbols.json', {at: Date.now(), list: list});
  else console.log('代號表太少，保留舊的');
}

// ---- 含息基準 ----
function writeBench(ca) {
  const ds = Object.keys(benchMap).sort();
  // 0050 含息：收盤價＋除息再投入，遇分割調整
  const div = {}, split = {};
  ca.ev.filter(e => e.code === '0050').forEach(e => {
    if (e.kind === 'div') { const c = e.tag === '息' ? e.val : e.cash; if (c > 0) div[e.date] = c; }
    if (e.kind === 'split' && e.ratio) split[e.date] = e.ratio;
    if (e.kind === 'rsplit' && e.ratio) split[e.date] = 1 / e.ratio;
  });
  const p50 = {};
  Object.keys(months).concat(fs.readdirSync(path.join(DATA, 'px')).filter(f => /\.json$/.test(f)).map(f => f.slice(0, 7)))
    .filter((x, i, a) => a.indexOf(x) === i).forEach(ym => { const M = month(ym); const l = M.c['0050']; if (l) M.d.forEach((d, i) => { if (l[i] !== null) p50[d] = l[i]; }); });
  let e = null, prev = null;
  const e50 = ds.map(d => {
    const px = p50[d];
    if (px) {
      if (e === null) e = 100;
      else if (prev) e = e * (px + (div[d] || 0)) * (split[d] || 1) / prev;
      prev = px;
    }
    return e === null ? null : Math.round(e * 10000) / 10000;
  });
  writeJ('bench.json', {d: ds, tx: ds.map(d => benchMap[d][0]), tr: ds.map(d => benchMap[d][1]), e50: e50});
}

// ---- 主程式 ----
fs.mkdirSync(path.join(DATA, 'px'), {recursive: true});
console.log('開始', TODAY, '台北', HOUR, '點；最早補到', START);
await Promise.all([runDays('tw', twseDay), runDays('tp', tpexDay)]);
Object.keys(months).forEach(ym => {
  const M = months[ym];
  if (!M.dirty) return;
  // 整欄都是 null 的代號不存
  const c = {}; Object.keys(M.c).sort().forEach(k => { if (M.c[k].some(v => v !== null)) c[k] = M.c[k]; });
  writeJ('px/' + ym + '.json', {d: M.d, c: c});
});
const ca = await corpActions();
await symbols();
writeBench(ca);
const twLeft = pending('tw').length, tpLeft = pending('tp').length;
writeJ('state.json', state);
writeJ('meta.json', {updated: new Date().toISOString(), start: START, lastDay: Object.keys(benchMap).sort().pop() || '', backfillLeft: twLeft + tpLeft});
console.log('完成；還沒補的日子：上市', twLeft, '、上櫃', tpLeft);
