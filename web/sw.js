var CACHE_NAME = 'oref-map-v2';
var SHELL_URLS = [
  '/',
  '/mixkit-clear-announce-tones-2861.wav',
  '/assets/css/main.css',
  '/assets/js/app-bootstrap.js',
  '/assets/js/app-core.js',
  '/assets/js/app-panels.js',
  '/assets/js/sw-register.js'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_URLS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
            .map(function(n) { return caches.delete(n); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Never intercept API calls — live alerts must always be fresh
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/api2/')) {
    return;
  }

  // Network-first: try network, fall back to cache
  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response.ok && event.request.method === 'GET' && url.origin === self.location.origin) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});
