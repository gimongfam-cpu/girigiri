const CACHE_NAME = 'jp-vocab-cache-v2';
const ASSETS = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'manifest.json',
  'icons/icon-512.png',
  'icons/icon-192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle standard GET requests (ignore API requests, post, etc.)
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
    return;
  }
  // Only handle HTTP/HTTPS protocols (avoid chrome-extension://, etc. errors)
  if (!event.request.url.startsWith('http')) {
    return;
  }
  
  event.respondWith(
    fetch(event.request).then((response) => {
      // If network fetch succeeds, update the cache and return the response
      // Allow 'basic' (same-origin) and 'cors' (cross-origin CDN assets like Lucide / Google Fonts)
      if (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
      }
      return response;
    }).catch(() => {
      // Network fails, fallback to cache
      return caches.match(event.request);
    })
  );
});

