// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function importApi() {
  const mod = await import('./api');
  mod.setRouter({ navigate: vi.fn() });
  return mod;
}

describe('api request error handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches status=401 to thrown error when 401 has a parseable JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'nope' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { api, isUnauthorized } = await importApi();
    let caught: unknown;
    try {
      await api.get('/perf');
    } catch (e) {
      caught = e;
    }
    expect((caught as { status?: number } | undefined)?.status).toBe(401);
    expect(isUnauthorized(caught)).toBe(true);
  });

  it('attaches status=401 to thrown error when 401 has an unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 401 })));
    const { api, isUnauthorized } = await importApi();
    let caught: unknown;
    try {
      await api.get('/perf');
    } catch (e) {
      caught = e;
    }
    expect((caught as { status?: number } | undefined)?.status).toBe(401);
    expect(isUnauthorized(caught)).toBe(true);
  });

  it('attaches status=500 to thrown error when 500 has a parseable JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { api, isUnauthorized } = await importApi();
    let caught: unknown;
    try {
      await api.get('/perf');
    } catch (e) {
      caught = e;
    }
    expect((caught as { status?: number } | undefined)?.status).toBe(500);
    expect(isUnauthorized(caught)).toBe(false);
  });

  it('passes signal through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await importApi();
    const controller = new AbortController();
    await api.get('/perf', { signal: controller.signal });
    const callOpts = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callOpts?.signal).toBe(controller.signal);
  });

  // Split-origin hosted deploys: the session cookie is only sent/stored
  // cross-origin with credentials: 'include' — fetch's same-origin default
  // silently drops it and every authed call 401s.
  it("sends credentials: 'include' on every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await importApi();
    await api.get('/perf');
    const callOpts = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callOpts?.credentials).toBe('include');
  });
});

// A session that expires ends just as completely as one the user logged out of,
// and the state that has to go with it is the same state — the walkthrough's
// module-scoped session and its overlay, the onboarding funnel's completion
// baseline. `queryClient.clear()` never runs on this path, and neither did the
// announcement that drops the rest, so the next user on the tab inherited both.
describe('session expiry announces the end of the session', () => {
  async function importFresh() {
    vi.resetModules();
    const mod = await import('./api');
    const navigate = vi.fn();
    mod.setRouter({ navigate });
    const { eventBus } = await import('../stores/event-bus.store');
    const onLogout = vi.fn();
    eventBus.subscribe('auth:logout', onLogout);
    return { ...mod, onLogout, navigate };
  }

  function stub401() {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes auth:logout when a 401 ends a live session', async () => {
    stub401();
    const { api, markSessionStarted, onLogout } = await importFresh();
    markSessionStarted();

    await expect(api.get('/positions')).rejects.toThrow('Unauthorized');

    expect(onLogout).toHaveBeenCalledOnce();
  });

  // The other half of the teardown, and the half nothing else can do here: on
  // the explicit logout `useAuth` clears the cache itself, but an expiry has no
  // component guaranteed to be mounted. A surviving `['auth', 'me']` is a user
  // the next mount of /login reads as signed in.
  it('drops the cached identity along with the session', async () => {
    stub401();
    const { api, markSessionStarted } = await importFresh();
    const { queryClient } = await import('./queryClient');
    queryClient.setQueryData(['auth', 'me'], { id: 'u-1' });
    markSessionStarted();

    await expect(api.get('/positions')).rejects.toThrow('Unauthorized');

    expect(queryClient.getQueryData(['auth', 'me'])).toBeUndefined();
  });

  it('says nothing for the 401 a logged-out visitor gets', async () => {
    // The me-query on a fresh /login load. No session ended, because there was
    // none — announcing here would be a teardown of nobody's state, and it would
    // burn the one-shot interception that the real expiry needs.
    stub401();
    const { api, onLogout } = await importFresh();

    await expect(api.get('/auth/me')).rejects.toThrow('Unauthorized');

    expect(onLogout).not.toHaveBeenCalled();
  });

  it('leaves the explicit logout path to useAuth, which publishes its own', async () => {
    stub401();
    const { api, markSessionStarted, setIsLoggingOut, onLogout } = await importFresh();
    markSessionStarted();
    setIsLoggingOut(true);

    // POST /auth/logout can itself 401 when the session was already gone.
    await expect(api.post('/auth/logout')).rejects.toBeTruthy();

    expect(onLogout).not.toHaveBeenCalled();
  });

  it('announces one termination once, however many requests were in flight', async () => {
    stub401();
    const { api, markSessionStarted, onLogout } = await importFresh();
    markSessionStarted();

    await Promise.allSettled([api.get('/positions'), api.get('/accounts'), api.get('/perf')]);

    expect(onLogout).toHaveBeenCalledOnce();
  });

  // THE LATCH IS ALSO WHAT BOUNDS THE REDIRECT. The interception sends the user
  // to /login, and anything that answers that by navigating back on a session
  // that has already ended is round one of a cycle; one navigation per
  // termination is what stops it. /login itself no longer answers — it mounts no
  // me-query and guards on nothing — but the bound is not its to keep. Only a
  // confirmed session start re-arms the latch, so no amount of remounting and
  // 401ing can re-open it.
  it('navigates once per termination, whatever 401s afterwards', async () => {
    stub401();
    const { api, markSessionStarted, onLogout, navigate } = await importFresh();
    markSessionStarted();

    await expect(api.get('/positions')).rejects.toThrow('Unauthorized');
    // Every pass the bounce would have made, if it were still making them.
    for (let i = 0; i < 3; i++) {
      await expect(api.get('/auth/me')).rejects.toBeTruthy();
      await expect(api.get('/positions')).rejects.toBeTruthy();
    }

    expect(navigate).toHaveBeenCalledOnce();
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('re-arms the one-shot interception when a new session begins', async () => {
    // The latch coalesces one termination's burst of 401s; it is not meant to
    // disable the interception for the life of the page. A logged-out landing on
    // /login consumes it, and without the re-arm the session logged into next
    // would expire in silence.
    stub401();
    const { api, markSessionStarted, onLogout } = await importFresh();

    await expect(api.get('/auth/me')).rejects.toThrow('Unauthorized');
    expect(onLogout).not.toHaveBeenCalled();

    markSessionStarted();
    await expect(api.get('/positions')).rejects.toThrow('Unauthorized');

    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('announceSessionExpired is idempotent, so a second caller adds nothing', async () => {
    // Two paths call it — this module's interception and the CSV preview's,
    // which does its own 401 handling around a multipart POST.
    const { markSessionStarted, announceSessionExpired, onLogout } = await importFresh();
    markSessionStarted();

    announceSessionExpired();
    announceSessionExpired();

    expect(onLogout).toHaveBeenCalledOnce();
  });
});

describe('resolveApiUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to /api when window.__TRADR_CONFIG__ is undefined', async () => {
    vi.stubGlobal('window', {});
    const { resolveApiUrl } = await importApi();
    expect(resolveApiUrl('/perf')).toBe('/api/perf');
  });

  it('falls back to /api when config has no apiBaseUrl', async () => {
    vi.stubGlobal('window', { __TRADR_CONFIG__: {} });
    const { resolveApiUrl } = await importApi();
    expect(resolveApiUrl('/perf')).toBe('/api/perf');
  });

  it('uses apiBaseUrl when set', async () => {
    vi.stubGlobal('window', { __TRADR_CONFIG__: { apiBaseUrl: 'https://api.example.com' } });
    const { resolveApiUrl } = await importApi();
    expect(resolveApiUrl('/perf')).toBe('https://api.example.com/perf');
  });
});

describe('runtime-config seam (C3 / Req 8.5)', () => {
  // The single resolveApiUrl base must back BOTH transports: the REST helper
  // (api.ts, this module) and the SSE stream (useAdvisorStream.ts). A drift
  // where the stream hand-rolls its own base would silently break split-config.
  it('useAdvisorStream uses resolveApiUrl as its base', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../features/advisor/hooks/useAdvisorStream.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/import\s+\{[^}]*\bresolveApiUrl\b[^}]*\}\s+from\s+['"][^'"]*lib\/api['"]/);
    expect(src).toMatch(/resolveApiUrl\(/);
  });

  // The /config.js script must be a CLASSIC blocking script: a classic script
  // always runs before deferred module scripts regardless of DOM position, so
  // window.__TRADR_CONFIG__ is set before the module entry reads it. The
  // load-bearing guarantee is the script TYPE — no type=module / async / defer.
  it('index.html config.js script is a classic (non-defer) script', () => {
    const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
    const tag = html.match(/<script[^>]*\bsrc=["']\/config\.js["'][^>]*>/i)?.[0];
    expect(tag, 'expected a <script src="/config.js"> tag').toBeTruthy();
    expect(tag).not.toMatch(/\btype\s*=\s*["']module["']/i);
    expect(tag).not.toMatch(/\basync\b/i);
    expect(tag).not.toMatch(/\bdefer\b/i);
  });
});

// The interception's ONE sanctioned opt-out, and this list is what enforces it.
//
// `allowUnauthenticated` switches off the global 401 redirect for a single
// request. It exists for one caller: the not-found page's presence check, whose
// whole question is "is anyone signed in?" and for which a 401 is the answer
// rather than a session ending. A second caller would be a request that
// genuinely needs a session quietly losing the redirect a real expiry depends
// on — and it would do so invisibly, because nothing about the request would
// look wrong. A doc comment on the field cannot stop that; naming the sites can.
const SANCTIONED_ALLOW_UNAUTHENTICATED = [
  'hooks/useAuth.ts', // the presence check, the one legitimate caller
  'lib/api.test.ts', // this guard, which has to spell the flag to look for it
  'lib/api.ts', // the declaration and the interception it opts out of
];

/**
 * Every file under `dir` whose text contains `needle`.
 *
 * The extension set has to match everything the bundler will resolve, not just
 * what the tree happens to contain today: a `.mts` or `.mjs` module is compiled
 * and shipped like any other, so if it can carry a call site it has to be
 * scanned for one. Narrowing this to `.ts`/`.tsx` would leave a guard that looks
 * total and is not.
 */
function filesMentioning(needle: string, dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesMentioning(needle, full, base);
    if (!/\.[mc]?[jt]sx?$/.test(entry.name)) return [];
    return readFileSync(full, 'utf8').includes(needle) ? [relative(base, full)] : [];
  });
}

describe('the 401 interception opt-out', () => {
  it('is used at its sanctioned sites and nowhere else in apps/web/src', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    expect(
      filesMentioning('allowUnauthenticated', src).sort(),
      'a new allowUnauthenticated call site opts a request out of the expiry redirect',
    ).toEqual(SANCTIONED_ALLOW_UNAUTHENTICATED);
  });
});

describe('isUnauthorized', () => {
  it('returns false for non-object values', async () => {
    const { isUnauthorized } = await importApi();
    expect(isUnauthorized(null)).toBe(false);
    expect(isUnauthorized(undefined)).toBe(false);
    expect(isUnauthorized('Unauthorized')).toBe(false);
    expect(isUnauthorized(401)).toBe(false);
  });

  it('returns true when status is 401', async () => {
    const { isUnauthorized } = await importApi();
    expect(isUnauthorized({ status: 401 })).toBe(true);
  });

  it('returns true when error.code is UNAUTHORIZED', async () => {
    const { isUnauthorized } = await importApi();
    expect(isUnauthorized({ error: { code: 'UNAUTHORIZED' } })).toBe(true);
  });

  it('returns true when message is Unauthorized', async () => {
    const { isUnauthorized } = await importApi();
    const err = new Error('Unauthorized');
    expect(isUnauthorized(err)).toBe(true);
  });

  it('returns false for other errors', async () => {
    const { isUnauthorized } = await importApi();
    expect(isUnauthorized({ status: 500 })).toBe(false);
    expect(isUnauthorized({ error: { code: 'INTERNAL' } })).toBe(false);
  });
});
