// Haky Chat service worker — caches the static app shell only.
// API calls (/auth, /chats, ...) and the WebSocket connection are never
// cached: chat data must always come from the network, not a stale cache.
const CACHE_NAME = 'haky-chat-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './js/config.js',
  './js/api.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests for shell files. Everything else
  // (API calls to the backend origin, WS upgrade requests) passes straight
  // through to the network untouched.
  const isApiOrWs = url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/chats') ||
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/media') ||
    url.pathname.startsWith('/devices') ||
    url.pathname.startsWith('/ws');

  if (event.request.method !== 'GET' || isApiOrWs) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
