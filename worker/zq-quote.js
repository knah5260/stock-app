// 韭菜紀錄 盤中報價中轉站（Cloudflare Worker）
// App 送 /q?c=2330,0050,... 進來，這裡去 Yahoo 股市拿即時成交價（幾秒內更新），整理成精簡的 JSON 回傳。
// Yahoo 拿不到時，改用證交所「基本市況報導」（約每分鐘才更新一次）。
// 同一組股票 2.5 秒內只會問證交所一次；只接受韭菜紀錄網站（和本機測試）來的請求。

const SITES = ['https://knah5260.github.io'];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MIS = 'https://mis.twse.com.tw/stock/';
const TTL = 2500;   // App 每 5 秒問一次，快取要比 5 秒短，才不會每隔一次拿到舊的

const memo = new Map();   // 股票組合 → {at, body}
let cookie = '';

async function getCookie() {
  const r = await fetch(MIS + 'index.jsp', {headers: {'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-TW'}});
  const sc = r.headers.get('set-cookie') || '';
  cookie = sc.split(/,(?=\s*\w+=)/).map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function ask(channels) {
  const u = MIS + 'api/getStockInfo.jsp?json=1&delay=0&ex_ch=' + encodeURIComponent(channels) + '&_=' + Date.now();
  const r = await fetch(u, {headers: {'User-Agent': 'Mozilla/5.0', 'Referer': MIS + 'index.jsp', 'Accept': 'application/json', ...(cookie ? {Cookie: cookie} : {})}});
  if (!r.ok) throw new Error('mis ' + r.status);
  return r.json();
}

const num = s => { const v = parseFloat(s); return isFinite(v) && v > 0 ? v : null; };
const first = s => num(String(s || '').split('_')[0]);

const YH = 'https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;symbols=';
const twParts = iso => {   // UTC 時間 → 台灣的 YYYYMMDD、HH:MM:SS
  const t = new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString();
  return [t.slice(0, 10).replace(/-/g, ''), t.slice(11, 19)];
};
async function yahoo(codes) {
  const out = {d: '', t: '', q: {}, src: 'yahoo'};
  for (let i = 0; i < codes.length; i += 40) {
    const part = codes.slice(i, i + 40);
    const r = await fetch(YH + encodeURIComponent(part.map(c => c + '.TW').join(',')) + '?lang=zh-Hant-TW&region=TW&_=' + Date.now(),
      {headers: {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://tw.stock.yahoo.com/'}});
    if (!r.ok) throw new Error('yahoo ' + r.status);
    const j = await r.json();
    (Array.isArray(j) ? j : j.data || []).forEach(x => {
      const c = String(x.systexId || String(x.symbol || '').split('.')[0]).toUpperCase();
      const p = x.price && num(x.price.raw);
      if (!c || !p) return;
      const [d, t] = x.regularMarketTime ? twParts(x.regularMarketTime) : ['', ''];
      out.q[c] = {p: p, y: x.regularMarketPreviousClose ? num(x.regularMarketPreviousClose.raw) : null, n: x.symbolName || '', t: t};
      if (d > out.d) out.d = d;
      if (d === out.d && t > out.t) out.t = t;
    });
  }
  if (!Object.keys(out.q).length) throw new Error('yahoo empty');
  return out;
}

async function quotes(codes) {
  try { return await yahoo(codes); } catch (e) { return mis(codes); }
}

async function mis(codes) {
  const out = {d: '', t: '', q: {}, src: 'mis'};
  for (let i = 0; i < codes.length; i += 25) {
    const part = codes.slice(i, i + 25);
    const ch = part.flatMap(c => ['tse_' + c + '.tw', 'otc_' + c + '.tw']).join('|');
    let j;
    try { j = await ask(ch); } catch (e) { j = null; }
    if (!j || j.rtcode !== '0000') { await getCookie(); j = await ask(ch); }
    (j.msgArray || []).forEach(m => {
      const c = String(m.c || '').toUpperCase();
      if (!c) return;
      // 成交價；z 常常是「-」，這時用 trade 裡最近一筆成交價，再不行用最佳買價、最佳賣價
      const p = num(m.z) || (m.trade && num(m.trade.z)) || num(m.pz) || first(m.b) || first(m.a);
      out.q[c] = {p: p, y: num(m.y), n: m.n || '', t: m.t || ''};
      if ((m.d || '') > out.d) out.d = m.d || '';
      if ((m.t || '') > out.t) out.t = m.t || '';
    });
  }
  return out;
}

// ---------- Apple Watch／捷徑用：/w?h=代號-股數-成本_代號-股數-成本… → 純文字摘要 ----------
// 持股是 App 產生網址時放進去的，這裡不存任何東西，只抓即時價格算市值和損益
const fmt = n => (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const sg = n => (n > 0 ? '+' : '') + fmt(n);
const pc = r => (r > 0 ? '+' : '') + (r * 100).toFixed(2) + '%';
async function watch(url) {
  const head = {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'};
  const hold = (url.searchParams.get('h') || '').split('_').map(x => x.split('-')).filter(x => /^[0-9A-Z]{4,7}$/i.test(x[0]) && +x[1] > 0)
    .map(x => ({c: x[0].toUpperCase(), u: +x[1], cost: +x[2] || 0})).slice(0, 60);
  if (!hold.length) return new Response('網址裡沒有持股資料，請在韭菜紀錄 App 重新產生捷徑網址', {status: 400, headers: head});
  let q;
  try { q = await quotes([...new Set(hold.map(h => h.c))]); } catch (e) { return new Response('暫時抓不到報價，請稍後再試', {status: 502, headers: head}); }
  let mv = 0, cost = 0, day = 0, prev = 0, pl = 0;
  const lines = [];
  hold.forEach(h => {
    const x = q.q[h.c]; if (!x || !x.p) return;
    const v = x.p * h.u, fee = Math.max(20, Math.floor(v * 0.001425));
    const tax = /^00\d+B$/.test(h.c) ? 0 : Math.floor(v * (h.c[0] === '0' ? 0.001 : 0.003));
    mv += v; cost += h.cost; pl += v - fee - tax - h.cost;
    if (x.y) { day += (x.p - x.y) * h.u; prev += x.y * h.u; }
    lines.push({n: x.n || h.c, p: x.p, r: x.y ? x.p / x.y - 1 : 0, v: v});
  });
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const when = q.d === today ? (q.t >= '13:30:00' ? '今日收盤' : '盤中 ' + q.t.slice(0, 5)) : (q.d ? q.d.slice(4, 6) + '/' + q.d.slice(6) + ' 收盤' : '');
  lines.sort((a, b) => b.v - a.v);
  const txt = ['持股市值 ' + fmt(mv),
    '今日 ' + sg(day) + (prev ? '（' + pc(day / prev) + '）' : ''),
    '未實現 ' + sg(pl) + (cost ? '（' + pc(pl / cost) + '）' : ''),
    when, ''].concat(lines.map(l => l.n + ' ' + l.p + ' ' + pc(l.r))).join('\n');
  return new Response(txt, {headers: head});
}

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const ok = SITES.includes(origin) || LOCAL.test(origin);
    const cors = {'Access-Control-Allow-Origin': ok ? origin : SITES[0], 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Vary': 'Origin'};
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    const url = new URL(req.url);
    if (url.pathname === '/w') return watch(url);
    if (url.pathname !== '/q') return new Response('韭菜紀錄 盤中報價', {headers: {...cors, 'Content-Type': 'text/plain; charset=utf-8'}});
    if (!ok) return new Response('forbidden', {status: 403, headers: cors});

    const codes = [...new Set((url.searchParams.get('c') || '').toUpperCase().split(',').map(s => s.trim()).filter(s => /^[0-9A-Z]{4,7}$/.test(s)))].sort().slice(0, 100);
    const head = {...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'};
    if (!codes.length) return new Response('{"error":"no codes"}', {status: 400, headers: head});

    const k = codes.join(',');
    const hit = memo.get(k);
    if (hit && Date.now() - hit.at < TTL) return new Response(hit.body, {headers: head});
    try {
      const body = JSON.stringify(await quotes(codes));
      memo.set(k, {at: Date.now(), body: body});
      if (memo.size > 200) memo.delete(memo.keys().next().value);
      return new Response(body, {headers: head});
    } catch (e) {
      return new Response(JSON.stringify({error: String(e && e.message || e)}), {status: 502, headers: head});
    }
  }
};
