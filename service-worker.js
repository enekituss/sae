const CACHE_NAME = 'sae-spotter-shell-v4';
const SHELL = [
  './',
  './index.html',
  './login.html',
  './set-password.html',
  './set-password.js',
  './bizkaibus.html',
  './burgos.html',
  './hub.css',
  './burgos.css',
  './burgos.js',
  './styles.css',
  './login.css',
  './login.js',
  './auth-guard.js',
  './supabase-config.js',
  './paradas.html',
  './paradas.js',
  './paradas.css',
  './pwa.js',
  './navigation.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('sae-spotter-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Las posiciones y el horario generado deben venir de la versión publicada,
  // nunca de una copia antigua retenida por la caché del Service Worker.
  if (/\/(vehicles\.json|stops\.json|burgos-data\.json|vehicles-data\.js)(\?|$)/.test(url.pathname + url.search)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(async () => {
        return (await caches.match(request)) || (await caches.match('./index.html'));
      })
    );
    return;
  }

  // Network-first: evita servir indefinidamente JS/CSS antiguos tras publicar cambios.
  event.respondWith(
    caches.match(request).then(cached => fetch(request).then(response => {
      if (response && response.ok) {
        caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone())).catch(() => {});
      }
      return response;
    }).catch(() => cached || Response.error()))
  );
});