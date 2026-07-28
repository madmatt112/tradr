// Unit tests for the delayed spot-quote client (design v4 — stock-quote.client,
// REQ-4.1/4.3/4.4/4.5). No live provider call: `fetchStockQuote` runs against
// an injected `fetchImpl` stub, and the cache runs a fake loader under fake
// timers. Asserts the four caller-distinguishable branches, per-symbol
// cache-hit + single-flight, stale-on-error, and that the API key is never
// logged or returned.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import {
  fetchStockQuote,
  getStockQuote,
  initStockQuoteCache,
  StockQuoteCache,
  STOCK_QUOTE_TTL_MS,
  type StockQuoteData,
} from './stock-quote.client';

const TTL = 1_000;

function quote(symbol: string, lastPrice: string): StockQuoteData {
  return { symbol, lastPrice, change: null, delayed: true };
}

/** A minimal `Response` stand-in — only the fields the client reads. */
function response(init: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: init.json ?? (async () => ({})),
  } as unknown as Response;
}

/** A `fetch` that always resolves to `res`. */
function stubFetch(res: Response): typeof fetch {
  return vi.fn(async () => res) as unknown as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stock-quote.client — constants', () => {
  it('pins the per-symbol TTL at 60s (design-pinned)', () => {
    expect(STOCK_QUOTE_TTL_MS).toBe(60_000);
  });
});

describe('fetchStockQuote — provider error mapping (REQ-4.3)', () => {
  it('200 with a price ⇒ the projected quote (change null, delayed true)', async () => {
    const fetchImpl = stubFetch(
      response({ ok: true, status: 200, json: async () => ({ ticker: 'AAPL', price: 195.89 }) }),
    );
    await expect(fetchStockQuote('AAPL', { fetchImpl })).resolves.toEqual({
      symbol: 'AAPL',
      lastPrice: '195.89',
      change: null,
      delayed: true,
    });
  });

  it('200 with no price ⇒ NotFoundError (unknown symbol, 404)', async () => {
    const fetchImpl = stubFetch(
      response({ ok: true, status: 200, json: async () => ({ ticker: 'ZZZZ' }) }),
    );
    await expect(fetchStockQuote('ZZZZ', { fetchImpl })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      fetchStockQuote('ZZZZ', {
        fetchImpl: stubFetch(response({ ok: true, status: 200, json: async () => ({}) })),
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('provider 404 ⇒ NotFoundError (unknown symbol, 404)', async () => {
    const fetchImpl = stubFetch(response({ ok: false, status: 404 }));
    await expect(fetchStockQuote('ZZZZ', { fetchImpl })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('429 ⇒ 503 QUOTE_PROVIDER_UNAVAILABLE', async () => {
    const fetchImpl = stubFetch(response({ ok: false, status: 429 }));
    await expect(fetchStockQuote('AAPL', { fetchImpl })).rejects.toMatchObject({
      statusCode: 503,
      code: 'QUOTE_PROVIDER_UNAVAILABLE',
    });
  });

  it('5xx ⇒ 503 QUOTE_PROVIDER_UNAVAILABLE', async () => {
    const fetchImpl = stubFetch(response({ ok: false, status: 502 }));
    await expect(fetchStockQuote('AAPL', { fetchImpl })).rejects.toMatchObject({
      statusCode: 503,
      code: 'QUOTE_PROVIDER_UNAVAILABLE',
    });
  });

  it('timeout / network error (fetch rejects) ⇒ 503 QUOTE_PROVIDER_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    }) as unknown as typeof fetch;
    await expect(fetchStockQuote('AAPL', { fetchImpl })).rejects.toMatchObject({
      statusCode: 503,
      code: 'QUOTE_PROVIDER_UNAVAILABLE',
    });
  });

  it('401 ⇒ 502 QUOTE_PROVIDER_MISCONFIGURED, logged at error', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const fetchImpl = stubFetch(response({ ok: false, status: 401 }));
    await expect(fetchStockQuote('AAPL', { fetchImpl })).rejects.toMatchObject({
      statusCode: 502,
      code: 'QUOTE_PROVIDER_MISCONFIGURED',
    });
    expect(errSpy).toHaveBeenCalledWith('stock quote provider rejected credentials', {
      status: 401,
    });
  });

  it('403 ⇒ 502 QUOTE_PROVIDER_MISCONFIGURED', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const fetchImpl = stubFetch(response({ ok: false, status: 403 }));
    await expect(fetchStockQuote('AAPL', { fetchImpl })).rejects.toMatchObject({
      statusCode: 502,
      code: 'QUOTE_PROVIDER_MISCONFIGURED',
    });
  });

  it('never logs or returns the API key; the header is read from config', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const fetchImpl = stubFetch(response({ ok: false, status: 401 }));

    const err = await fetchStockQuote('AAPL', { fetchImpl }).catch((e: unknown) => e);

    // The log payload carries only the status — no key, no upstream body.
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][1]).toStrictEqual({ status: 401 });
    // The surfaced error message is generic.
    expect((err as AppError).message).toBe('Quote provider is misconfigured.');
    // The key comes from config (unset in the test env ⇒ ''), never hard-coded.
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/v1/stockprice?ticker=AAPL'),
      expect.objectContaining({ headers: { 'X-Api-Key': '' } }),
    );
  });
});

describe('StockQuoteCache — per-symbol TTL + single-flight + stale-on-error (REQ-4.4)', () => {
  it('a per-symbol cache hit avoids a second fetch within the TTL', async () => {
    const loader = vi.fn(async (s: string) => quote(s, '1'));
    const cache = new StockQuoteCache(loader, TTL);

    await cache.get('AAPL');
    vi.advanceTimersByTime(TTL - 1);
    const second = await cache.get('AAPL');

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(quote('AAPL', '1'));
  });

  it('refetches after the TTL expires', async () => {
    const loader = vi
      .fn<(s: string) => Promise<StockQuoteData>>()
      .mockResolvedValueOnce(quote('AAPL', '1'))
      .mockResolvedValueOnce(quote('AAPL', '2'));
    const cache = new StockQuoteCache(loader, TTL);

    await cache.get('AAPL');
    vi.advanceTimersByTime(TTL);
    const refreshed = await cache.get('AAPL');

    expect(loader).toHaveBeenCalledTimes(2);
    expect(refreshed.lastPrice).toBe('2');
  });

  it('caches each symbol independently', async () => {
    const loader = vi.fn(async (s: string) => quote(s, '1'));
    const cache = new StockQuoteCache(loader, TTL);

    await cache.get('AAPL');
    await cache.get('MSFT');
    await cache.get('AAPL');

    expect(loader).toHaveBeenCalledTimes(2); // AAPL cached; MSFT is a separate fetch
  });

  it('single-flight coalesces concurrent calls for the same symbol into one fetch', async () => {
    const d = deferred<StockQuoteData>();
    const loader = vi.fn(() => d.promise);
    const cache = new StockQuoteCache(loader, TTL);

    const burst = Promise.all([cache.get('AAPL'), cache.get('AAPL'), cache.get('AAPL')]);
    expect(loader).toHaveBeenCalledTimes(1);

    d.resolve(quote('AAPL', '7'));
    const results = await burst;

    expect(loader).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual(quote('AAPL', '7'));
  });

  it('stale-on-error: serves the last-good snapshot when a refresh fails', async () => {
    const loader = vi
      .fn<(s: string) => Promise<StockQuoteData>>()
      .mockResolvedValueOnce(quote('AAPL', '1'))
      .mockRejectedValue(new AppError(503, 'QUOTE_PROVIDER_UNAVAILABLE', 'down'));
    const cache = new StockQuoteCache(loader, TTL);

    await cache.get('AAPL'); // warm
    vi.advanceTimersByTime(TTL); // expire
    const stale = await cache.get('AAPL'); // refresh fails → serve last-good

    expect(loader).toHaveBeenCalledTimes(2);
    expect(stale).toEqual(quote('AAPL', '1'));
  });

  it('surfaces the mapped error when there is no last-good snapshot (cold)', async () => {
    const loader = vi.fn(async (s: string) => {
      throw new NotFoundError('symbol', s);
    });
    const cache = new StockQuoteCache(loader, TTL);

    await expect(cache.get('ZZZZ')).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('initStockQuoteCache / getStockQuote — bootstrap + test fence', () => {
  // Ordered first: the module singleton is still null here (no init has run),
  // so the NODE_ENV=test fence surfaces as an explicit throw rather than a
  // live provider call.
  it('no-arg init is a no-op under NODE_ENV=test; getStockQuote throws until seeded', async () => {
    initStockQuoteCache(); // no loader, NODE_ENV=test ⇒ no-op (no live provider armed)
    await expect(getStockQuote('AAPL')).rejects.toThrow(/not initialized under NODE_ENV=test/);
  });

  it('init with a loader wires getStockQuote through the per-symbol cache', async () => {
    const loader = vi.fn(async (s: string) => quote(s, '9'));
    initStockQuoteCache(loader);

    const first = await getStockQuote('AAPL');
    const second = await getStockQuote('AAPL');

    expect(first).toEqual(quote('AAPL', '9'));
    expect(second).toEqual(quote('AAPL', '9'));
    expect(loader).toHaveBeenCalledTimes(1); // cached
  });
});
