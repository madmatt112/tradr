/*
 * Tradr service worker (design C2). A classic script, no exports, no build step:
 * its bytes do not change per deploy (Decision D1), so a deploy installs no new
 * worker. It is network-only — every request is answered from `fetch` while the
 * network yields a response (404 and 5xx included), and a cached byte is served
 * only when `fetch` throws (Decision D4). The one cache, `tradr-shell-<version>`,
 * is an offline fallback keyed to the served version read from `/config.js`.
 *
 * Restrictions it keeps: it imports nothing, touches only `tradr-shell-` caches,
 * and never messages, navigates or reloads a client.
 */

const CACHE_PREFIX = 'tradr-shell-';

// Mirrors FETCH_TIMEOUT_MS (apps/web/src/lib/updateMonitor.ts:12): the worker's
// own `/config.js` fetch aborts after this long. An abort is a thrown fetch, so
// the version outcome is "unknown" and no cache changes (Decision D1, Req 3.11).
const FETCH_TIMEOUT_MS = 10_000;

// Twin of parseServedVersion (apps/web/src/lib/updateMonitor.ts:55, :64-75): the
// same APP_VERSION_TOKEN regex, JSON.parse step and VERSION_SHAPE gate, copied
// because the worker shares no code with the SPA bundle. Keep the two in step.
const APP_VERSION_TOKEN = /"appVersion"\s*:\s*("(?:[^"\\]|\\.)*")/;
const VERSION_SHAPE = /^[A-Za-z0-9.+-]{1,64}$/;

function parseServedVersion(configJsText) {
  const match = APP_VERSION_TOKEN.exec(configJsText);
  if (!match) return undefined;
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  return VERSION_SHAPE.test(value) ? value : undefined;
}

// classify, first match wins (design C2). 'pass' leaves the request to the
// browser as if no worker existed.
function classify(request) {
  if (request.method !== 'GET') return 'pass';
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return 'pass';
  const path = url.pathname;
  if (
    path === '/config.js' ||
    path === '/metrics' ||
    path === '/_headers' ||
    path === '/sw.js' ||
    path.startsWith('/api/')
  ) {
    return 'pass';
  }
  // Leaves refreshAsset's `cache: 'reload'` and fetchServedVersion's
  // `cache: 'no-store'` to the browser (Decision D2).
  if (request.cache === 'reload' || request.cache === 'no-store') return 'pass';
  if (request.mode === 'navigate') return 'navigate';
  if (path.startsWith('/assets/')) return 'asset';
  return 'pass';
}

// Storable: a 2xx, non-redirected response; a navigation must also be text/html
// (design C2 "Storable"). Only same-origin requests reach a handler, so no
// opaque response is ever stored.
function isStorable(response, isNavigate) {
  if (!response.ok || response.redirected) return false;
  if (isNavigate) {
    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/html')) return false;
  }
  return true;
}

async function shellCacheNames() {
  const keys = await caches.keys();
  return keys.filter((name) => name.startsWith(CACHE_PREFIX));
}

// Delete every `tradr-shell-` cache except the one named, so at most one shell
// cache survives (Data Models, "Worker cache" invariant).
async function deleteShellCaches(except) {
  const names = await shellCacheNames();
  await Promise.all(names.filter((name) => name !== except).map((name) => caches.delete(name)));
}

// The single current shell cache, or undefined when zero or more than one exist.
async function currentCache() {
  const names = await shellCacheNames();
  if (names.length !== 1) return undefined;
  return caches.open(names[0]);
}

/*
 * Read the served version from `/config.js` and reconcile the shell caches
 * (Data Models, "Version outcome"):
 *   string    -> 2xx with a valid token: keep only that version's cache.
 *   null      -> non-2xx (design D6) or 2xx without a valid token: delete all.
 *   undefined -> fetch threw/aborted (Decision D1): change nothing.
 */
async function refreshVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let text;
  try {
    const response = await fetch('/config.js', {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) {
      await deleteShellCaches();
      return null;
    }
    text = await response.text();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  const version = parseServedVersion(text);
  if (version === undefined) {
    await deleteShellCaches();
    return null;
  }
  await deleteShellCaches(CACHE_PREFIX + version);
  return version;
}

async function onNavigate(event) {
  try {
    const response = await fetch(event.request);
    if (isStorable(response, true)) {
      const copy = response.clone();
      event.waitUntil(
        (async () => {
          const version = await refreshVersion();
          if (version) {
            const cache = await caches.open(CACHE_PREFIX + version);
            await cache.put('/', copy);
          }
        })(),
      );
    }
    return response;
  } catch {
    const cache = await currentCache();
    const cached = cache ? await cache.match('/') : undefined;
    return cached || Response.error();
  }
}

async function onAsset(event) {
  try {
    const response = await fetch(event.request);
    if (isStorable(response, false)) {
      const copy = response.clone();
      event.waitUntil(
        (async () => {
          const cache = await currentCache();
          if (cache) await cache.put(event.request, copy);
        })(),
      );
    }
    return response;
  } catch {
    const cached = await caches.match(event.request);
    return cached || Response.error();
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
  event.waitUntil(refreshVersion());
});

self.addEventListener('fetch', (event) => {
  const kind = classify(event.request);
  if (kind === 'pass') return;
  event.respondWith(kind === 'navigate' ? onNavigate(event) : onAsset(event));
});
