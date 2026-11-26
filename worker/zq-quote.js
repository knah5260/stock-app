// 韭菜紀錄 盤中報價中轉站（Cloudflare Worker）
// App 送 /q?c=2330,0050,... 進來，這裡去證交所「基本市況報導」拿五秒快照，整理成精簡的 JSON 回傳。
// 同一組股票 5 秒內只會問證交所一次；只接受韭菜紀錄網站（和本機測試）來的請求。

const SITES = ['https://knah5260.github.io'];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MIS = 'https://mis.twse.com.tw/stock/';
const TTL = 5000;

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

async function quotes(codes) {
  const out = {d: '', t: '', q: {}};
  for (let i = 0; i < codes.length; i += 25) {
    const part = codes.slice(i, i + 25);
    const ch = part.flatMap(c => ['tse_' + c + '.tw', 'otc_' + c + '.tw']).join('|');
    let j;
    try { j = await ask(ch); } catch (e) { j = null; }
    if (!j || j.rtcode !== '0000') { await getCookie(); j = await ask(ch); }
    (j.msgArray || []).forEach(m => {
      const c = String(m.c || '').toUpperCase();
      if (!c) return;
      // 成交價；這 5 秒內沒成交就用最佳買價、再不行用最佳賣價
      const p = num(m.z) || first(m.b) || first(m.a);
      out.q[c] = {p: p, y: num(m.y), n: m.n || '', t: m.t || ''};
      if ((m.d || '') > out.d) out.d = m.d || '';
      if ((m.t || '') > out.t) out.t = m.t || '';
    });
  }
  return out;
}

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const ok = SITES.includes(origin) || LOCAL.test(origin);
    const cors = {'Access-Control-Allow-Origin': ok ? origin : SITES[0], 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Vary': 'Origin'};
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    const url = new URL(req.url);
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
