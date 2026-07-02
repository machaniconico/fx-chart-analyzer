const APP_CACHE = 'fx-chart-analyzer-app-v1';
const ASSET_CACHE = 'fx-chart-analyzer-assets-v1';
const DATA_CACHE = 'fx-chart-analyzer-data-v1';
const KNOWN_CACHES = [APP_CACHE, ASSET_CACHE, DATA_CACHE];
const APP_SHELL = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => !KNOWN_CACHES.includes(cacheName))
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const isSameOrigin = (url) => url.origin === self.location.origin;
const isHashedAsset = (url) => isSameOrigin(url) && url.pathname.startsWith('/assets/');
const isDataJson = (url) => isSameOrigin(url) && url.pathname.startsWith('/data/') && url.pathname.endsWith('.json');
const isIndexRequest = (request, url) =>
  isSameOrigin(url) &&
  (url.pathname === '/' || url.pathname === '/index.html' || request.mode === 'navigate');

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetch(request);
  if (networkResponse.ok) {
    await cache.put(request, networkResponse.clone());
  }
  return networkResponse;
};

const networkFirst = async (request, cacheName, fallbackRequests = []) => {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    for (const fallbackRequest of fallbackRequests) {
      const fallbackResponse = await cache.match(fallbackRequest);
      if (fallbackResponse) {
        return fallbackResponse;
      }
    }

    throw error;
  }
};

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  if (!isSameOrigin(url)) {
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(event.request, ASSET_CACHE));
    return;
  }

  if (isDataJson(url)) {
    event.respondWith(networkFirst(event.request, DATA_CACHE));
    return;
  }

  if (isIndexRequest(event.request, url)) {
    event.respondWith(networkFirst(event.request, APP_CACHE, ['/index.html', '/']));
  }
});
