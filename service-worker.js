const CACHE_NAME = "sae-burgos-shell-v11";
const SHELL = [
  "./",
  "./index.html",
  "./app.js?v=20261127k",
  "./styles.css?v=20261127k",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith("sae-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("/burgos-data.json") || url.pathname.endsWith("/burgos-modelos.json")) {
    event.respondWith(fetch(request, { cache: "no-cache" }));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy)).catch(() => {});
        }
        return response;
      }).catch(async () => (await caches.match(request)) || (await caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    fetch(request).then(response => {
      if (response && response.ok) {
        caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone())).catch(() => {});
      }
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error())
  );
});