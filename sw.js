// 背景程式：只快取 App 本身的檔案，不快取任何資料（資料一律向後端即時拿）
const V = 'zq-shell-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'demo.js', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return; // 後端、外部網址都不經過這裡
  if (r.mode === 'navigate') {
    // 主畫面：先抓最新版，沒網路才用上次存的
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put('index.html', cp)); }
      return res;
    }).catch(() => caches.match('index.html', {ignoreSearch: true})));
    return;
  }
  // 其他檔案：先用存的，同時在背景更新
  e.respondWith(caches.match(r, {ignoreSearch: true}).then(hit => {
    const net = fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
