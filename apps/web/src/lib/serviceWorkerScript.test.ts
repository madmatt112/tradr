// @vitest-environment node
//
// Runs the real apps/web/public/sw.js in a node:vm sandbox against fakes of
// `self`, `caches` and `fetch` (design C2; Testing Strategy, worker bullets).
// sw.js is a classic script with no exports, so every assertion below goes
// through the three listeners it registers (install/activate/fetch) and the
// observable state of the fake cache storage — never an import of the file.
//
// Contract block, one entry per success criterion this file covers:
//
// - Req 2.1 "registers only install, activate and fetch" — pre: sw.js loaded
//   fresh in the sandbox; call: dispatch nothing, just inspect registration;
//   observe: exactly {install, activate, fetch} were registered; source:
//   design C2 Interfaces, "a classic script with three listeners, no exports".
// - Req 2.4 (folds 2.5, 2.6, 3.9) "classify leaves pass-through requests to
//   the browser" — pre: sandbox loaded; call: dispatch a `fetch` event for
//   each pass-through shape; observe: `respondWith` is never called and the
//   fake `fetch` is never invoked; source: design C2 `classify` rules 1-4, 7.
// - Req 2.7 (folds 3.10) "install and activate never message, navigate or
//   reload a client" — pre: sandbox loaded; call: dispatch install then
//   activate; observe: `self.clients.matchAll` is never called; source:
//   design C2 post-conditions, "no listener messages, navigates or reloads a
//   client", and Req 2.7's prohibition on a controllerchange reload.
// - Req 2.1/3.11 "activate claims clients and fetches /config.js for its own
//   version check" — pre: sandbox loaded; call: dispatch activate with a
//   2xx /config.js body; observe: `clients.claim()` is called and `fetch` is
//   called with ('/config.js', {cache:'no-store', credentials:'omit', ...});
//   source: design C2 "activate: waitUntil of self.clients.claim() and
//   refreshVersion()" and Requirement 3.11.
// - Req 3.6 "a new served version deletes every other tradr-shell- cache" —
//   pre: an old `tradr-shell-OLD` cache seeded; call: dispatch activate with
//   a new version; observe: `caches.keys()` is exactly the new cache; source:
//   design C2 `refreshVersion()` and Data Models "Worker cache" invariant.
// - Req 3.11 (parser parity, folds 3.6/3.7) "the worker's own /config.js
//   parser agrees with parseServedVersion" — pre: an old cache seeded; call:
//   dispatch activate with each parity-table body; observe: the resulting
//   cache name matches `tradr-shell-` + parseServedVersion(body), or no
//   cache when parseServedVersion returns undefined; source: the imported
//   `parseServedVersion` (apps/web/src/lib/updateMonitor.ts:64-75) and design
//   C2 "Parser: ... with a comment that names parseServedVersion as its
//   twin."
// - Req 3.7 (design D6) "a non-2xx /config.js response deletes every
//   tradr-shell- cache" — pre: an old cache seeded; call: dispatch activate
//   with a 503 /config.js response; observe: `caches.keys()` is empty;
//   source: Data Models "Version outcome", null row, and design D6.
// - Req 3.11/D1 "a hung /config.js fetch aborts after 10 000 ms and changes
//   no cache" — pre: an old cache seeded, fake timers; call: dispatch
//   activate with a fetch that only rejects on abort, advance time by
//   FETCH_TIMEOUT_MS; observe: the cache set is unchanged and the fetch's
//   signal is aborted; source: `FETCH_TIMEOUT_MS` (updateMonitor.ts:12) and
//   Decision D1 ("an abort is a thrown fetch, so the outcome is unknown").
// - Req 3.2 "a successful navigation is returned unchanged and its shell is
//   cached" — pre: no prior cache; call: dispatch a navigate fetch event
//   whose network response is a 200 text/html document, and whose triggered
//   /config.js refetch answers a version; observe: the respondWith value
//   matches the network body, and the version's cache gains a `/` entry with
//   that body; source: design C2 "Navigate" and Data Models "Worker cache".
// - Req 3.1/3.2 "a successful asset fetch is cached opportunistically" —
//   pre: exactly one tradr-shell- cache already exists, with no prior
//   knowledge of this asset path; call: dispatch an asset fetch event with a
//   200 response; observe: that exact cache gains an entry keyed by the
//   asset's URL; source: design C2 "Asset" and Requirement 3.1 ("identified
//   opportunistically ... not by resolving hashed /assets/ filenames").
// - Req 3.3 "a failed navigation serves the cached document" — pre: a
//   version's cache already holds a `/` entry; call: dispatch a navigate
//   fetch event whose network fetch throws; observe: respondWith resolves to
//   the cached response; source: design C2 "On a thrown network error,
//   return the current cache's / entry".
// - Req 3.3 "a failed asset fetch serves the cached copy of that exact URL"
//   — pre: a cache already holds that asset's URL; call: dispatch an asset
//   fetch event whose network fetch throws; observe: respondWith resolves to
//   the cached response; source: design C2 "Asset", same clause.
// - Req 3.3 "a failed navigation with no cached entry is a network error" —
//   pre: no caches exist; call: dispatch a navigate fetch event whose fetch
//   throws; observe: respondWith resolves to a response of `type: 'error'`;
//   source: design C2 "else Response.error()".
// - Req 3.4 "the network's own 404/500 is returned even over a cache hit" —
//   pre: a cache already holds a stale good entry; call: dispatch a fetch
//   event whose network answers 404 (navigate) or 500 (asset); observe:
//   respondWith resolves to that status, not the cached entry; source:
//   Requirement 3.4 and design C2 post-conditions.
// - Req 3.5 "a non-2xx, redirected or non-HTML navigation is not stored" —
//   pre: no caches exist; call: dispatch a navigate fetch event for each
//   shape; observe: no `tradr-shell-` cache gains a `/` entry; source:
//   design C2 "Storable" and Requirement 3.5.
//
// Folded/overlapping criteria and where their coverage lives:
// - Req 2.5 (no API response/cookie/header/body stored) is folded into the
//   2.4 pass-through test's `/api/accounts` row: the worker never calls
//   `fetch` or `caches.open` for that request, so nothing can be cached.
// - Req 2.6 (no queue/replay/synthesize of a write) is folded into the 2.4
//   pass-through test's non-GET row: a POST is left to the browser, not
//   queued.
// - Req 3.9 (refreshAsset's `cache:'reload'` and fetchServedVersion's
//   `cache:'no-store'` reach the network) is folded into the 2.4
//   pass-through test's two cache-mode rows.
// - Req 3.10 (the §29 one-reload guard is unchanged; no second reload path)
//   is folded into the 2.7 "never message/navigate/reload" test: sw.js has
//   no code path that could duplicate that guard, which the same assertion
//   demonstrates structurally.
// - Req 9.6 (unit-test the classifier and the cache-keying/cleanup,
//   including the absent-version case) is the umbrella this whole file
//   satisfies; its absent-version case specifically is the 3.7 (503) test
//   above.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FETCH_TIMEOUT_MS, parseServedVersion } from './updateMonitor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(__dirname, '../../public/sw.js');
const ORIGIN = 'https://app.test';

interface FakeRequest {
  method: string;
  url: string;
  mode: string;
  cache: string;
}

function makeRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    method: 'GET',
    url: `${ORIGIN}/`,
    mode: 'same-origin',
    cache: 'default',
    ...overrides,
  };
}

function makeHtmlResponse(body: string, status = 200, redirected = false): Response {
  const response = new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
  if (redirected) Object.defineProperty(response, 'redirected', { value: true });
  return response;
}

interface SandboxCtx {
  context: vm.Context;
  registeredTypes: string[];
  listeners: Record<string, Array<(event: unknown) => void>>;
  cacheStore: Map<string, Map<string, Response>>;
  fetchMock: ReturnType<typeof vi.fn>;
  clientsClaim: ReturnType<typeof vi.fn>;
  clientsMatchAll: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
}

function loadWorker(): SandboxCtx {
  const src = readFileSync(SW_PATH, 'utf8');
  const registeredTypes: string[] = [];
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const cacheStore = new Map<string, Map<string, Response>>();
  const fetchMock = vi.fn();
  const clientsClaim = vi.fn(() => Promise.resolve());
  const clientsMatchAll = vi.fn(() => Promise.resolve([]));
  const skipWaiting = vi.fn(() => Promise.resolve());

  const fakeSelf = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      registeredTypes.push(type);
      (listeners[type] ??= []).push(handler);
    },
    skipWaiting,
    clients: { claim: clientsClaim, matchAll: clientsMatchAll },
  };

  function cacheObjectFor(name: string) {
    if (!cacheStore.has(name)) cacheStore.set(name, new Map());
    const store = cacheStore.get(name)!;
    return {
      put: vi.fn(async (req: FakeRequest | string, res: Response) => {
        const url = typeof req === 'string' ? req : req.url;
        store.set(url, res);
      }),
      match: vi.fn(async (req: FakeRequest | string) => {
        const url = typeof req === 'string' ? req : req.url;
        return store.get(url);
      }),
    };
  }

  const caches = {
    open: vi.fn(async (name: string) => cacheObjectFor(name)),
    match: vi.fn(async (req: FakeRequest | string) => {
      const url = typeof req === 'string' ? req : req.url;
      for (const store of cacheStore.values()) {
        if (store.has(url)) return store.get(url);
      }
      return undefined;
    }),
    keys: vi.fn(async () => Array.from(cacheStore.keys())),
    delete: vi.fn(async (name: string) => cacheStore.delete(name)),
  };

  const sandbox: Record<string, unknown> = {
    self: fakeSelf,
    caches,
    fetch: fetchMock,
    Response,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  const context = vm.createContext(sandbox);
  new vm.Script(src, { filename: SW_PATH }).runInContext(context);

  return {
    context,
    registeredTypes,
    listeners,
    cacheStore,
    fetchMock,
    clientsClaim,
    clientsMatchAll,
    skipWaiting,
  };
}

interface ExtendableEventFake {
  waitUntil: (p: unknown) => void;
  settle: () => Promise<void>;
}

function makeExtendableEvent(): ExtendableEventFake {
  const promises: Array<Promise<unknown>> = [];
  return {
    waitUntil: (p: unknown) => {
      promises.push(Promise.resolve(p));
    },
    settle: async () => {
      await Promise.all(promises);
    },
  };
}

interface FetchEventFake extends ExtendableEventFake {
  request: FakeRequest;
  respondWith: (p: unknown) => void;
  response: () => Promise<Response>;
}

function makeFetchEvent(request: FakeRequest): FetchEventFake {
  const base = makeExtendableEvent();
  let responded: Promise<unknown> | undefined;
  return {
    ...base,
    request,
    respondWith: (p: unknown) => {
      responded = Promise.resolve(p);
    },
    response: async () => {
      if (!responded) throw new Error('respondWith was never called');
      // Await the handler's own returned promise first: any `waitUntil` call
      // inside it (design C2's Navigate/Asset post-fetch bookkeeping) is
      // registered synchronously before that promise settles, so only after
      // awaiting it is `settle()` safe to call.
      const result = (await responded) as Response;
      await base.settle();
      return result;
    },
  };
}

function dispatch(ctx: SandboxCtx, type: string, event: unknown): void {
  for (const handler of ctx.listeners[type] ?? []) handler(event);
}

function routedFetch(routes: Record<string, () => Promise<Response>>) {
  return vi.fn(async (input: FakeRequest | string) => {
    const url = typeof input === 'string' ? input : input.url;
    // Resolve against ORIGIN so relative fetches (e.g. '/config.js') parse, then
    // compare the parsed origin exactly — a substring/startsWith check on a URL
    // can be spoofed (CodeQL: incomplete URL substring sanitization).
    const parsed = new URL(url, ORIGIN);
    const key = parsed.origin === ORIGIN ? parsed.pathname + parsed.search : url;
    const handler = routes[key] ?? routes[url];
    if (!handler) throw new Error(`unhandled fetch in test fixture: ${url}`);
    return handler();
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sw.js structure', () => {
  it('registers only the install, activate and fetch listeners (Req 2.1, 2.7, 3.10)', () => {
    const ctx = loadWorker();
    expect(new Set(ctx.registeredTypes)).toEqual(new Set(['install', 'activate', 'fetch']));
  });
});

describe('classify (Req 2.4, folds 2.5, 2.6, 3.9)', () => {
  const cases: Array<[string, Partial<FakeRequest>]> = [
    ['a non-GET method', { method: 'POST', url: `${ORIGIN}/` }],
    ['a cross-origin request', { url: 'https://other.test/', mode: 'cors' }],
    ['a request under /api/', { url: `${ORIGIN}/api/accounts` }],
    ['a request for /config.js', { url: `${ORIGIN}/config.js` }],
    ['a request for /metrics', { url: `${ORIGIN}/metrics` }],
    ['a request for /_headers', { url: `${ORIGIN}/_headers` }],
    ['a request for /sw.js itself', { url: `${ORIGIN}/sw.js` }],
    ['a reload-mode asset request', { url: `${ORIGIN}/assets/a.js`, cache: 'reload' }],
    [
      'a no-store navigate-mode request',
      { url: `${ORIGIN}/`, mode: 'navigate', cache: 'no-store' },
    ],
    ['any other same-origin GET', { url: `${ORIGIN}/favicon.svg` }],
  ];

  it.each(cases)('leaves %s to the browser', async (_label, overrides) => {
    const ctx = loadWorker();
    const event = makeFetchEvent(makeRequest(overrides));
    dispatch(ctx, 'fetch', event);
    await event.settle();
    await expect(event.response()).rejects.toThrow('respondWith was never called');
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });
});

describe('install and activate never touch a client (Req 2.7, folds 3.10)', () => {
  it('calls skipWaiting on install and never messages, navigates or reloads a client', async () => {
    const ctx = loadWorker();
    dispatch(ctx, 'install', makeExtendableEvent());
    expect(ctx.skipWaiting).toHaveBeenCalledTimes(1);

    ctx.fetchMock = (ctx as SandboxCtx).fetchMock;
    // Replace the sandbox's fetch so activate's own /config.js call resolves.
    const configFetch = routedFetch({
      '/config.js': async () =>
        new Response('window.__TRADR_CONFIG__={"appVersion":"1.0.0"};', { status: 200 }),
    });
    (ctx.context as Record<string, unknown>).fetch = configFetch;

    const event = makeExtendableEvent();
    dispatch(ctx, 'activate', event);
    await event.settle();

    expect(ctx.clientsClaim).toHaveBeenCalledTimes(1);
    expect(ctx.clientsMatchAll).not.toHaveBeenCalled();
  });
});

describe('activate learns the served version (Req 2.1 shape, 3.11)', () => {
  it('calls clients.claim and fetches /config.js with cache: no-store, credentials: omit', async () => {
    const ctx = loadWorker();
    const fetchMock = routedFetch({
      '/config.js': async () =>
        new Response('window.__TRADR_CONFIG__={"appVersion":"2.0.0"};', { status: 200 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeExtendableEvent();
    dispatch(ctx, 'activate', event);
    await event.settle();

    expect(ctx.clientsClaim).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/config.js',
      expect.objectContaining({ cache: 'no-store', credentials: 'omit' }),
    );
  });
});

describe('cache cleanup by version on activate (Req 3.6)', () => {
  it('deletes every other tradr-shell- cache when a new version is learned', async () => {
    const ctx = loadWorker();
    ctx.cacheStore.set('tradr-shell-OLD', new Map([['/', makeHtmlResponse('old')]]));
    const fetchMock = routedFetch({
      '/config.js': async () =>
        new Response('window.__TRADR_CONFIG__={"appVersion":"NEW"};', { status: 200 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeExtendableEvent();
    dispatch(ctx, 'activate', event);
    await event.settle();

    // The invariant (Data Models, "at most one tradr-shell- cache") does not
    // require the new cache to exist yet with nothing written to it — only
    // that no other version's cache survives.
    expect(Array.from(ctx.cacheStore.keys())).not.toContain('tradr-shell-OLD');
  });
});

describe('parser parity with parseServedVersion (Req 3.11, folds 3.6/3.7)', () => {
  const bodies: Array<[string, string]> = [
    [
      'the entrypoint shape with appVersion among other keys',
      'window.__TRADR_CONFIG__={"apiBaseUrl":"https://api.example.com","appVersion":"1.4.0","advisorImageMaxBytes":4500000};\n',
    ],
    [
      'the entrypoint shape with no appVersion',
      'window.__TRADR_CONFIG__={"apiBaseUrl":"https://api.example.com","advisorImageMaxBytes":4500000};\n',
    ],
    ['a minimal one-key body', 'window.__TRADR_CONFIG__={"appVersion":"9"};\n'],
  ];

  it.each(bodies)('learns the same outcome as parseServedVersion for %s', async (_label, body) => {
    const expected = parseServedVersion(body);
    const ctx = loadWorker();
    ctx.cacheStore.set('tradr-shell-OLD', new Map([['/', makeHtmlResponse('old')]]));
    const html = '<!doctype html><title>shell</title>';
    const fetchMock = routedFetch({
      '/': async () => makeHtmlResponse(html),
      '/config.js': async () => new Response(body, { status: 200 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    // Drive the parser through the navigate path (design D3: the worker
    // re-learns the version on every successful navigation), so a learned
    // version is also the one actually used to key the written cache.
    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    await event.response();

    if (expected === undefined) {
      expect(Array.from(ctx.cacheStore.keys())).toEqual([]);
    } else {
      expect(Array.from(ctx.cacheStore.keys())).toEqual([`tradr-shell-${expected}`]);
    }
  });
});

describe('absent version deletes every cache (Req 3.7, design D6)', () => {
  it('treats a non-2xx /config.js response as absent and deletes every tradr-shell- cache', async () => {
    const ctx = loadWorker();
    ctx.cacheStore.set('tradr-shell-OLD', new Map([['/', makeHtmlResponse('old')]]));
    const fetchMock = routedFetch({
      '/config.js': async () => new Response('', { status: 503 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeExtendableEvent();
    dispatch(ctx, 'activate', event);
    await event.settle();

    expect(Array.from(ctx.cacheStore.keys())).toEqual([]);
  });
});

describe('a hung /config.js fetch is an unknown outcome (Req 3.11, Decision D1)', () => {
  it('aborts after FETCH_TIMEOUT_MS and changes no cache', async () => {
    vi.useFakeTimers();
    const ctx = loadWorker();
    ctx.cacheStore.set('tradr-shell-OLD', new Map([['/', makeHtmlResponse('old')]]));

    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: FakeRequest | string, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeExtendableEvent();
    dispatch(ctx, 'activate', event);

    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    await event.settle();

    expect(capturedSignal?.aborted).toBe(true);
    expect(Array.from(ctx.cacheStore.keys())).toEqual(['tradr-shell-OLD']);
  });
});

describe('navigate: success (Req 3.1, 3.2)', () => {
  it('returns the network response unchanged and caches the shell under the learned version', async () => {
    const ctx = loadWorker();
    const html = '<!doctype html><title>shell</title>';
    const fetchMock = routedFetch({
      '/': async () => makeHtmlResponse(html),
      '/config.js': async () =>
        new Response('window.__TRADR_CONFIG__={"appVersion":"3.0.0"};', { status: 200 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    const response = await event.response();

    expect(await response.text()).toBe(html);
    expect(response.status).toBe(200);
    const store = ctx.cacheStore.get('tradr-shell-3.0.0');
    expect(store).toBeDefined();
    expect(await store!.get('/')?.text()).toBe(html);
  });
});

describe('asset: success is cached opportunistically (Req 3.1, 3.2)', () => {
  it('caches a previously unseen asset into the single existing shell cache', async () => {
    const ctx = loadWorker();
    ctx.cacheStore.set('tradr-shell-3.0.0', new Map());
    const js = 'console.log("asset")';
    const assetUrl = `${ORIGIN}/assets/chunk-xyz.js`;
    const fetchMock = routedFetch({
      [`/assets/chunk-xyz.js`]: async () =>
        new Response(js, { status: 200, headers: { 'content-type': 'text/javascript' } }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: assetUrl, mode: 'same-origin' }));
    dispatch(ctx, 'fetch', event);
    const response = await event.response();

    expect(await response.text()).toBe(js);
    const store = ctx.cacheStore.get('tradr-shell-3.0.0')!;
    expect(await store.get(assetUrl)?.text()).toBe(js);
  });
});

describe('navigate: network failure falls back to the cached document (Req 3.3)', () => {
  it('serves the cached "/" entry when the network fetch throws', async () => {
    const ctx = loadWorker();
    const cached = makeHtmlResponse('<!doctype html><title>cached</title>');
    ctx.cacheStore.set('tradr-shell-3.0.0', new Map([['/', cached]]));
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    const response = await event.response();

    expect(await response.text()).toBe('<!doctype html><title>cached</title>');
  });
});

describe('asset: network failure falls back to the cached exact URL (Req 3.3)', () => {
  it('serves the cached entry for that exact asset URL when the network fetch throws', async () => {
    const ctx = loadWorker();
    const assetUrl = `${ORIGIN}/assets/chunk-xyz.js`;
    const cached = new Response('cached-js', { status: 200 });
    ctx.cacheStore.set('tradr-shell-3.0.0', new Map([[assetUrl, cached]]));
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: assetUrl, mode: 'same-origin' }));
    dispatch(ctx, 'fetch', event);
    const response = await event.response();

    expect(await response.text()).toBe('cached-js');
  });
});

describe('navigate: network failure with no cached entry (Req 3.3)', () => {
  it('returns a network-error response when nothing is cached', async () => {
    const ctx = loadWorker();
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    const response = await event.response();

    expect(response.type).toBe('error');
  });
});

describe('the network answer is always preferred over a cache hit (Req 3.4)', () => {
  it('returns the network 404 for a navigation even with a cached document present', async () => {
    const ctx = loadWorker();
    ctx.cacheStore.set('tradr-shell-3.0.0', new Map([['/', makeHtmlResponse('stale')]]));
    const fetchMock = routedFetch({
      '/': async () => new Response('not found', { status: 404 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    const response = await event.response();

    expect(response.status).toBe(404);
  });

  it('returns the network 500 for an asset even with a cached copy present', async () => {
    const ctx = loadWorker();
    const assetUrl = `${ORIGIN}/assets/chunk-xyz.js`;
    ctx.cacheStore.set(
      'tradr-shell-3.0.0',
      new Map([[assetUrl, new Response('stale-js', { status: 200 })]]),
    );
    const fetchMock = routedFetch({
      [`/assets/chunk-xyz.js`]: async () => new Response('server error', { status: 500 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: assetUrl, mode: 'same-origin' }));
    dispatch(ctx, 'fetch', event);
    const response = await event.response();

    expect(response.status).toBe(500);
  });
});

describe('non-storable navigation responses are never cached (Req 3.5)', () => {
  it('does not store a non-2xx navigation response', async () => {
    const ctx = loadWorker();
    const fetchMock = routedFetch({
      '/': async () => new Response('not found', { status: 404 }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    await event.response();

    expect(Array.from(ctx.cacheStore.keys())).toEqual([]);
  });

  it('does not store a redirected navigation response', async () => {
    const ctx = loadWorker();
    const fetchMock = routedFetch({
      '/': async () => makeHtmlResponse('<!doctype html>', 200, true),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    await event.response();

    expect(Array.from(ctx.cacheStore.keys())).toEqual([]);
  });

  it('does not store a non-HTML navigation response', async () => {
    const ctx = loadWorker();
    const fetchMock = routedFetch({
      '/': async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    (ctx.context as Record<string, unknown>).fetch = fetchMock;

    const event = makeFetchEvent(makeRequest({ url: `${ORIGIN}/`, mode: 'navigate' }));
    dispatch(ctx, 'fetch', event);
    await event.response();

    expect(Array.from(ctx.cacheStore.keys())).toEqual([]);
  });
});
