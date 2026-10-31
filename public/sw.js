// Service worker for the browser-only version (GitHub Pages). It keeps the app working offline and
// serves the photo library that the page downloads from Google Drive into Cache Storage.
//
// Library URLs look like library/<px>/<drive file id>/<name>.jpg (or library/local/<name>.jpg for
// photos added from the device). On a cache miss it fetches the Drive preview and keeps it.

const SHELL_CACHE = 'shell-v1';
const LIBRARY_CACHE = 'photo-library';
const SHELL_FILES = ['./', 'index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('shell-') && key !== SHELL_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (path.startsWith('library/')) event.respondWith(libraryResponse(event.request, path));
  else event.respondWith(shellResponse(event.request));
});

// App files: network first so updates arrive, falling back to the saved copy offline.
async function shellResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match('index.html');
    return new Response('Offline', { status: 503 });
  }
}

async function libraryResponse(request, path) {
  const cache = await caches.open(LIBRARY_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;

  const match = path.match(/^library\/(\d+)\/([\w-]+)\//);
  if (!match) return new Response('Not on this device', { status: 404 });
  try {
    const response = await fetch(`https://lh3.googleusercontent.com/d/${match[2]}=s${match[1]}`);
    if (!response.ok) return new Response('Not found', { status: 404 });
    const stored = new Response(await response.blob(), { headers: { 'Content-Type': 'image/jpeg' } });
    await cache.put(request, stored.clone());
    return stored;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}
