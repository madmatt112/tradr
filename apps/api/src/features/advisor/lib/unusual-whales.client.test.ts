import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config, envSchema } from '@/lib/config';

import { bucketOf } from '../tools/error-codes';

import {
  MarketDataCache,
  MarketDataError,
  MarketDataMeter,
  PlatformRateLimitedError,
  createUnusualWhalesClient,
} from './unusual-whales.client';

const STUB_BASE = 'https://stub.uw.test';

/** A fetch mock returning a fixed Response; records the calls it received. */
function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init ?? {})),
  ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeDeps(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createUnusualWhalesClient>[0]> = {},
) {
  return {
    apiKey: 'plaintext-secret-key',
    userId: 'user-1',
    cache: new MarketDataCache(),
    meter: new MarketDataMeter(),
    fetchImpl,
    baseUrl: STUB_BASE,
    ...overrides,
  };
}

describe('createUnusualWhalesClient — request shape & auth', () => {
  it('sends a bearer-authed GET to the pinned stock-quote path', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { ticker: 'AAPL', price: 1 } }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    const out = await client.getStockQuote('AAPL');

    expect(out).toEqual({ data: { ticker: 'AAPL', price: 1 } });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${STUB_BASE}/api/stock/AAPL/info`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer plaintext-secret-key',
    );
    expect(init.method).toBe('GET');
  });

  it('passes the options-flow limit as a query param', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: [{ id: 1 }] }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    await client.getOptionsFlow('AAPL', 5);

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${STUB_BASE}/api/stock/AAPL/flow-alerts?limit=5`);
  });

  it('passes the option-chain expiration as the date query param, and asks for greeks', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: [{ strike: 100 }] }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    await client.getOptionChain('AAPL', '2026-06-19');

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // Without `greeks=true` UW returns bare option-symbol strings and the chain
    // carries no pricing at all.
    expect(url).toBe(`${STUB_BASE}/api/stock/AAPL/option-chains?date=2026-06-19&greeks=true`);
  });

  it('asks for greeks even when no expiration is given', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: [{ strike: 100 }] }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    await client.getOptionChain('AAPL');

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${STUB_BASE}/api/stock/AAPL/option-chains?greeks=true`);
  });

  // The bug this guards: UW's DEFAULT option-chains response is an array of
  // bare option-symbol STRINGS, not objects. An object-only schema rejected
  // every real ticker as MARKET_DATA_UNAVAILABLE (503) while a bogus ticker's
  // empty `data: []` parsed fine and 404'd — the exact inversion seen in prod.
  it('accepts the bare option-symbol-string chain form without erroring', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ data: ['AAPL260619C00190000', 'AAPL260619P00185000'] }),
    );
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    await expect(client.getOptionChain('AAPL')).resolves.toEqual({
      data: ['AAPL260619C00190000', 'AAPL260619P00185000'],
    });
  });
});

describe('status → reason mapping (REQ-6.5) — code AND bucket', () => {
  const cases = [
    { status: 401, code: 'MARKET_DATA_KEY_INVALID' },
    { status: 403, code: 'MARKET_DATA_KEY_INVALID' },
    { status: 429, code: 'MARKET_DATA_RATE_LIMITED' },
    { status: 500, code: 'MARKET_DATA_UNAVAILABLE' },
    { status: 503, code: 'MARKET_DATA_UNAVAILABLE' },
    { status: 404, code: 'SYMBOL_NOT_FOUND' },
  ] as const;

  for (const { status, code } of cases) {
    it(`maps HTTP ${status} → ${code} (tool_result bucket)`, async () => {
      const fetchImpl = mockFetch(() => new Response('upstream detail', { status }));
      const client = createUnusualWhalesClient(makeDeps(fetchImpl));

      const err = await client.getStockQuote('AAPL').catch((e) => e);
      expect(err).toBeInstanceOf(MarketDataError);
      expect((err as MarketDataError).code).toBe(code);
      expect(bucketOf((err as MarketDataError).code)).toBe('tool_result');
      // Never surface the provider's raw body (REQ-6.8).
      expect((err as Error).message).not.toContain('upstream detail');
    });
  }

  it('surfaces Retry-After (seconds) on a 429', async () => {
    const fetchImpl = mockFetch(
      () => new Response(null, { status: 429, headers: { 'retry-after': '42' } }),
    );
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    const err = (await client.getStockQuote('AAPL').catch((e) => e)) as MarketDataError;
    expect(err.code).toBe('MARKET_DATA_RATE_LIMITED');
    expect(err.retryAfter).toBe(42);
  });

  it('maps a 200 with an empty payload → SYMBOL_NOT_FOUND', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: {} }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    const err = (await client.getStockQuote('ZZZZ').catch((e) => e)) as MarketDataError;
    expect(err.code).toBe('SYMBOL_NOT_FOUND');
    expect(bucketOf(err.code)).toBe('tool_result');
  });

  it('maps an empty options-flow array → SYMBOL_NOT_FOUND', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: [] }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    const err = (await client.getOptionsFlow('ZZZZ').catch((e) => e)) as MarketDataError;
    expect(err.code).toBe('SYMBOL_NOT_FOUND');
  });

  it('maps a network failure → MARKET_DATA_UNAVAILABLE', async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError('network down');
    });
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    const err = (await client.getStockQuote('AAPL').catch((e) => e)) as MarketDataError;
    expect(err.code).toBe('MARKET_DATA_UNAVAILABLE');
    expect(bucketOf(err.code)).toBe('tool_result');
    expect(err.message).not.toContain('network down');
  });
});

describe('TTL cache (REQ-6.7) — hit does not meter', () => {
  it('serves a second identical call from cache without re-fetching or metering', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { ticker: 'AAPL' } }));
    const cache = new MarketDataCache();
    // Meter allowing exactly ONE charge; a cache miss on the 2nd call would trip it.
    const meter = new MarketDataMeter(1, 60_000);
    const client = createUnusualWhalesClient(makeDeps(fetchImpl, { cache, meter }));

    const a = await client.getStockQuote('AAPL');
    const b = await client.getStockQuote('AAPL');

    expect(a).toEqual(b);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch(() => jsonResponse({ data: { ticker: 'AAPL' } }));
      const cache = new MarketDataCache(60_000);
      const client = createUnusualWhalesClient(makeDeps(fetchImpl, { cache }));

      await client.getStockQuote('AAPL');
      vi.advanceTimersByTime(60_001);
      await client.getStockQuote('AAPL');

      expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('per-user meter (REQ-3.10) → PLATFORM_RATE_LIMITED', () => {
  it('throws PlatformRateLimitedError once the per-user window is exhausted', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { ticker: 'AAPL' } }));
    const meter = new MarketDataMeter(2, 60_000);
    const client = createUnusualWhalesClient(makeDeps(fetchImpl, { meter }));

    // Distinct symbols → distinct cache keys → each charges the meter.
    await client.getStockQuote('AAA');
    await client.getStockQuote('BBB');
    const err = (await client.getStockQuote('CCC').catch((e) => e)) as PlatformRateLimitedError;

    expect(err).toBeInstanceOf(PlatformRateLimitedError);
    expect(err.code).toBe('PLATFORM_RATE_LIMITED');
    expect(bucketOf(err.code)).toBe('tool_result');
  });

  it('meters per user — a second user has its own budget', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { ticker: 'AAPL' } }));
    const meter = new MarketDataMeter(1, 60_000);
    const u1 = createUnusualWhalesClient(makeDeps(fetchImpl, { meter, userId: 'u1' }));
    const u2 = createUnusualWhalesClient(makeDeps(fetchImpl, { meter, userId: 'u2' }));

    await expect(u1.getStockQuote('AAA')).resolves.toBeDefined();
    await expect(u2.getStockQuote('AAA')).resolves.toBeDefined();
  });
});

describe('10 s request timeout (REQ-6.4)', () => {
  it('aborts and maps to MARKET_DATA_UNAVAILABLE when the request times out', async () => {
    vi.useFakeTimers();
    try {
      // A fetch that rejects only when its own signal aborts (real fetch behavior).
      const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }) as unknown as typeof fetch;
      const client = createUnusualWhalesClient(makeDeps(fetchImpl));

      const promise = client.getStockQuote('AAPL').catch((e) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      const err = (await promise) as MarketDataError;

      expect(err).toBeInstanceOf(MarketDataError);
      expect(err.code).toBe('MARKET_DATA_UNAVAILABLE');
      expect(err.message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('per-tool signal cancels the in-flight fetch (REQ-6.4)', () => {
  it('aborts the request when the per-tool signal aborts', async () => {
    const toolController = new AbortController();
    let observedAbort = false;

    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          observedAbort = true;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    const promise = client.getStockQuote('AAPL', toolController.signal).catch((e) => e);
    toolController.abort();
    const err = (await promise) as MarketDataError;

    expect(observedAbort).toBe(true);
    expect(err).toBeInstanceOf(MarketDataError);
    expect(err.code).toBe('MARKET_DATA_UNAVAILABLE');
  });

  it('aborts immediately when the per-tool signal is already aborted', async () => {
    const toolController = new AbortController();
    toolController.abort();
    let observedAbort = false;

    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      // Real fetch rejects synchronously when handed an already-aborted signal.
      if (init?.signal?.aborted) {
        observedAbort = true;
        const e = new Error('aborted');
        e.name = 'AbortError';
        return Promise.reject(e);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    const err = (await client
      .getStockQuote('AAPL', toolController.signal)
      .catch((e) => e)) as MarketDataError;
    expect(observedAbort).toBe(true);
    expect(err.code).toBe('MARKET_DATA_UNAVAILABLE');
  });
});

describe('base URL is config-sourced (REQ-6.4 E2E seam)', () => {
  it('defaults to config.UNUSUAL_WHALES_BASE_URL when no override is passed', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { ticker: 'AAPL' } }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl, { baseUrl: undefined }));

    await client.getStockQuote('AAPL');

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${config.UNUSUAL_WHALES_BASE_URL}/api/stock/AAPL/info`);
  });

  it('envSchema parses an override from env → config (the value the client reads)', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: 'postgresql://x',
      SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      UNUSUAL_WHALES_BASE_URL: 'http://localhost:9999',
    });
    expect(parsed.UNUSUAL_WHALES_BASE_URL).toBe('http://localhost:9999');
  });

  it('honors an explicit baseUrl override (the E2E seam)', async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: { ticker: 'AAPL' } }));
    const client = createUnusualWhalesClient(
      makeDeps(fetchImpl, { baseUrl: 'http://localhost:9999' }),
    );

    await client.getStockQuote('AAPL');

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:9999/api/stock/AAPL/info');
  });
});

describe('secret hygiene (REQ-6.6)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('does not write the plaintext key to console on a failure path', async () => {
    const fetchImpl = mockFetch(() => new Response(null, { status: 500 }));
    const client = createUnusualWhalesClient(makeDeps(fetchImpl));

    await client.getStockQuote('AAPL').catch(() => undefined);

    for (const spy of [errSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('plaintext-secret-key');
      }
    }
  });
});
