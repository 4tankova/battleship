// Офлайн-кеш гри. Версію змінюйте при кожному оновленні файлів.
const VERSION = 'mb-v5.1.0';
const CORE = [
  './', './index.html', './css/app.css',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => (k.startsWith('mb-') || k.startsWith('morskoy-biy-')) && k !== VERSION && k !== 'mb-fonts').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Шрифти Google: кеш-спочатку, щоб гра виглядала однаково й офлайн.
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('mb-fonts').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }).catch(() => Response.error()));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Сторінка: мережа спочатку (свіжа версія), офлайн — з кешу.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); }
      return res;
    }).catch(async () => (await caches.match('./index.html')) || new Response('Офлайн', { status: 503 })));
    return;
  }

  // Статика: швидко з кешу, паралельно оновлюємо.
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok && res.type === 'basic') c.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('', { status: 504 });
  }));
});
