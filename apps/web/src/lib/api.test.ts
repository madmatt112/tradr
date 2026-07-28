// @vitest-environment node
import { readFileSync } from 'node:fs';
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
