// A very small service worker.
// Its job: cache the app's files the first time they're loaded,
// so the app still opens even with no internet connection.

const CACHE_NAME = 'siamind-v1';
const FILES_TO_CACHE = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// "install" runs once, when the browser first registers this service worker.
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(FILES_TO_CACHE);
    })
  );
});

// "fetch" runs every time the page requests a file (HTML, JS, image, etc).
// We try the cache first; if it's not there, we fall back to the network.
self.addEventListener('fetch', function (event) {
  event.respondWith(
    caches.match(event.request).then(function (cachedResponse) {
      return cachedResponse || fetch(event.request);
    })
  );
});
