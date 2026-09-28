/* ZULU Field service worker.
 *
 * Template: vite.config.ts replaces the version and the app-shell file list at build time and
 * emits dist/sw.js. Not used in `vite dev` (registered only in production builds).
 *
 * Caches
 *   zulu-shell-<version>  app shell (HTML, JS, CSS, icons, manifest). Cache-first; replaced per build.
 *   zulu-area-<id>        one per downloaded area (tiles + for OpenFreeMap the style/TileJSON/sprites/glyphs).
 *                         Written by the page (src/offline.ts); deleted with the area.
 *   zulu-ofm-static       OpenFreeMap style/TileJSON/sprites/glyphs seen while online (small).
 *
 * Tiles are served cache-first from any cache, keyed by tileKey() (MUST match src/tiles.ts
 * tileCacheKey), then the network; offline and not cached → 504.
 */
const VERSION = 'a61e24b72471';
const PRECACHE = ["./","index.html","assets/index-DN6cyavV.js","assets/index-DzQSimXV.css","assets/maplibre-gl-worker-DRFeyNJw.js","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/icon.svg","manifest.webmanifest"];
const SHELL = 'zulu-shell-' + VERSION;
const OFM_STATIC = 'zulu-ofm-static';

const GSI_HOST = 'cyberjapandata.gsi.go.jp';
const OFM_HOST = 'tiles.openfreemap.org';

function tileKey(url) {
  return url.replace(/^(https:\/\/tiles\.openfreemap\.org\/planet\/)[^/]+\/(\d+\/\d+\/\d+\.pbf)$/, '$1_/$2');
}

function isTile(u) {
  if (u.hostname === GSI_HOST) return u.pathname.startsWith('/xyz/');
  if (u.hostname === OFM_HOST) return /\.(pbf|png|jpg|webp)$/.test(u.pathname) && (u.pathname.startsWith('/planet/') || u.pathname.startsWith('/natural_earth/'));
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const base = self.registration.scope;
      await cache.addAll(PRECACHE.map((p) => new Request(new URL(p, base).href, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('zulu-shell-') && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);

  if (u.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(shellNavigation(req));
    } else {
      event.respondWith(shellAsset(req));
    }
    return;
  }
  if (u.hostname === GSI_HOST || u.hostname === OFM_HOST) {
    if (isTile(u)) event.respondWith(tile(req));
    else if (u.hostname === OFM_HOST) event.respondWith(ofmStatic(req, u));
  }
});

async function shellNavigation(req) {
  const cache = await caches.open(SHELL);
  const scope = self.registration.scope;
  const index = (await cache.match(new URL("index.html", scope).href, { ignoreVary: true })) ?? (await cache.match(scope, { ignoreVary: true }));
  if (index) return index;
  try {
    return await fetch(req);
  } catch {
    return new Response('ZULU Field: offline and the app is not cached yet.', { status: 503 });
  }
}

async function shellAsset(req) {
  // ignoreVary: servers answer with "Vary: Origin", and module scripts are requested with an Origin
  // header that the precache request did not have.
  const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  return fetch(req);
}

async function tile(req) {
  const hit = await caches.match(tileKey(req.url), { ignoreVary: true });
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return new Response(null, { status: 504, statusText: 'offline, tile not downloaded' });
  }
}

/** OpenFreeMap style / TileJSON: network first (they change); sprites / glyphs: cache first. */
async function ofmStatic(req, u) {
  const volatile = u.pathname.startsWith('/styles/') || u.pathname === '/planet';
  const key = u.href;
  const cached = await caches.match(key, { ignoreVary: true });
  if (cached && !volatile) return cached;
  try {
    // A captive or dead network can hang for a long time: with a cached copy, give it 4 s.
    const res = cached
      ? await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))])
      : await fetch(req);
    if (res.ok && res.type !== 'opaque') {
      const copy = res.clone();
      caches.open(OFM_STATIC).then((c) => c.put(key, copy)).catch(() => {});
    }
    return res;
  } catch {
    if (cached) return cached;
    return new Response(null, { status: 504, statusText: 'offline' });
  }
}
