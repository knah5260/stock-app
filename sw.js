// 背景程式：快取 App 本身的檔案和公開股價資料；你的交易紀錄不會經過這裡（直接跟 Google 連線）
const V = 'zq-shell-2.13.2';
const SHELL = ['./', 'index.html', 'manifest.json', 'engine.js', 'localapi.js', 'demo.js', 'importer.js', 'theme-dark.css', 'theme-light.css', 'theme-gallery.css', 'theme-dusk.css', 'theme-aurora.css', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== 'zq-data').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const put = (name, req, res) => { if (res.ok) { const cp = res.clone(); caches.open(name).then(c => c.put(req, cp)); } return res; };
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return; // Google、證交所等外部連線都不經過這裡
  if (u.pathname.indexOf('/data/') >= 0) {
    // 公開資料：已定案的月份（v=fix）直接用存的；其他先抓最新，沒網路才用存的
    if (u.searchParams.get('v') === 'fix') {
      e.respondWith(caches.open('zq-data').then(c => c.match(r).then(hit => hit || fetch(r).then(res => put('zq-data', r, res)))));
      return;
    }
    e.respondWith(fetch(r).then(res => put('zq-data', r, res)).catch(() => caches.open('zq-data').then(c => c.match(r, {ignoreSearch: true}))));
    return;
  }
  if (r.mode === 'navigate') {
    // 主畫面：先抓最新版，沒網路才用上次存的
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put('index.html', cp)); }
      return res;
    }).catch(() => caches.match('index.html', {ignoreSearch: true})));
    return;
  }
  // 其他檔案：先抓最新，沒網路才用存的（避免新舊版本混用）
  e.respondWith(fetch(r).then(res => put(V, r, res)).catch(() => caches.match(r, {ignoreSearch: true})));
});
