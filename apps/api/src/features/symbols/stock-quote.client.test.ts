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
  getStockQuoteBatch,
  initStockQuoteCache,
  QUOTE_BATCH_CONCURRENCY,
  QUOTE_BATCH_DEADLINE_MS,
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

  // Contract: pre — module loaded; call — read QUOTE_BATCH_CONCURRENCY; observe
  // — exactly 8; source — design C2 "defaults are module constants
  // QUOTE_BATCH_CONCURRENCY = 8".
  it('pins the batch concurrency default at 8 (design-pinned)', () => {
    expect(QUOTE_BATCH_CONCURRENCY).toBe(8);
  });

  // Contract: pre — module loaded; call — read QUOTE_BATCH_DEADLINE_MS; observe
  // — exactly 12_000; source — design C2 "QUOTE_BATCH_DEADLINE_MS = 12_000".
  it('pins the batch deadline default at 12s (design-pinned)', () => {
    expect(QUOTE_BATCH_DEADLINE_MS).toBe(12_000);
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

  // Contract: pre — cold cache, system time 0, loader resolves once; call —
  // cache.getEntry('AAPL'); observe — { snapshot, fetchedAt: 0 }, the stored
  // fetch time; source — design C1 post-condition "a fresh hit returns the
  // stored entry" (Req 2.7).
  it('getEntry on a fresh hit returns the stored fetchedAt', async () => {
    const loader = vi.fn(async (s: string) => quote(s, '1'));
    const cache = new StockQuoteCache(loader, TTL);

    const entry = await cache.getEntry('AAPL');

    expect(entry).toEqual({ snapshot: quote('AAPL', '1'), fetchedAt: 0 });
  });

  // Contract: pre — cache warmed at t=0, TTL expires, request made at t=TTL
  // (the "request time"), refresh rejects; call — cache.getEntry('AAPL') at
  // t=TTL; observe — fetchedAt is still 0 (the original fetch time), not
  // TTL (the request time); source — Req 2.8 "the outcome SHALL carry that
  // snapshot's original fetch time, not the request time" / design C1.
  it('getEntry stale-on-error keeps the last-good entry\'s original fetchedAt, not the request time', async () => {
    const loader = vi
      .fn<(s: string) => Promise<StockQuoteData>>()
      .mockResolvedValueOnce(quote('AAPL', '1'))
      .mockRejectedValue(new AppError(503, 'QUOTE_PROVIDER_UNAVAILABLE', 'down'));
    const cache = new StockQuoteCache(loader, TTL);

    await cache.getEntry('AAPL'); // warm at t=0
    vi.advanceTimersByTime(TTL); // expire; "request time" is now TTL

    const stale = await cache.getEntry('AAPL');

    expect(stale.fetchedAt).toBe(0);
    expect(stale.fetchedAt).not.toBe(TTL);
    expect(stale.snapshot).toEqual(quote('AAPL', '1'));
  });

  // Contract: pre — cold cache, loader deferred (does not resolve yet); call
  // — cache.get('AAPL') and cache.getEntry('AAPL') issued concurrently before
  // the loader settles; observe — the loader is called exactly once and both
  // calls resolve from that one call; source — design C1 post-condition "get
  // and getEntry share one single-flight map, so concurrent calls for a
  // symbol cause one provider call".
  it('get and getEntry for the same symbol share one single-flight loader call', async () => {
    const d = deferred<StockQuoteData>();
    const loader = vi.fn(() => d.promise);
    const cache = new StockQuoteCache(loader, TTL);

    const burst = Promise.all([cache.get('AAPL'), cache.getEntry('AAPL'), cache.get('AAPL')]);
    expect(loader).toHaveBeenCalledTimes(1);

    d.resolve(quote('AAPL', '7'));
    const [getResult, entryResult, secondGetResult] = await burst;

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getResult).toEqual(quote('AAPL', '7'));
    expect(secondGetResult).toEqual(quote('AAPL', '7'));
    expect(entryResult).toEqual({ snapshot: quote('AAPL', '7'), fetchedAt: 0 });
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

// Ordered after the bootstrap describe above: every case here calls
// initStockQuoteCache(loader), which would otherwise poison the bootstrap
// describe's first case (it relies on the module singleton still being null).
describe('getStockQuoteBatch — outcome mapping, concurrency and deadline (REQ-4.4, design C2)', () => {
  // Contract: pre — singleton seeded with a loader that resolves at system
  // time 0; call — getStockQuoteBatch(['AAPL']); observe — one outcome,
  // { symbol: 'AAPL', status: 'ok', lastPrice, fetchedAt } with fetchedAt as
  // the ISO-8601 string for time 0; source — design C2 post-condition "A
  // resolved lookup gives { symbol, status: 'ok', lastPrice, fetchedAt }
  // (fetchedAt as ISO-8601)".
  it('a resolved lookup gives the ok outcome with an ISO-8601 fetchedAt', async () => {
    const loader = vi.fn(async (s: string) => quote(s, '195.89'));
    initStockQuoteCache(loader);

    const result = await getStockQuoteBatch(['AAPL']);

    expect(result).toEqual([
      { symbol: 'AAPL', status: 'ok', lastPrice: '195.89', fetchedAt: new Date(0).toISOString() },
    ]);
  });

  // Contract: pre — singleton seeded with a loader that rejects with
  // NotFoundError; call — getStockQuoteBatch(['ZZZZ']); observe — outcome
  // { symbol: 'ZZZZ', status: 'unknown' }; source — design C2 post-condition
  // "a NotFoundError gives status: 'unknown'" (Req 2.5).
  it('a NotFoundError rejection gives the unknown outcome', async () => {
    const loader = vi.fn(async (s: string) => {
      throw new NotFoundError('symbol', s);
    });
    initStockQuoteCache(loader);

    const result = await getStockQuoteBatch(['ZZZZ']);

    expect(result).toEqual([{ symbol: 'ZZZZ', status: 'unknown' }]);
  });

  // Contract: pre — singleton seeded with a loader that rejects with a 502
  // AppError; call — getStockQuoteBatch(['AAPL']); observe — outcome
  // { symbol: 'AAPL', status: 'unavailable' }; source — design C2
  // post-condition "any other rejection (502, 503, unexpected) gives
  // status: 'unavailable'" (Req 2.5).
  it('a 502 AppError rejection gives the unavailable outcome', async () => {
    const loader = vi.fn(async () => {
      throw new AppError(502, 'QUOTE_PROVIDER_MISCONFIGURED', 'misconfigured');
    });
    initStockQuoteCache(loader);

    const result = await getStockQuoteBatch(['AAPL']);

    expect(result).toEqual([{ symbol: 'AAPL', status: 'unavailable' }]);
  });

  // Contract: pre — singleton seeded with a loader that rejects with a 503
  // AppError; call — getStockQuoteBatch(['AAPL']); observe — outcome
  // { symbol: 'AAPL', status: 'unavailable' }; source — design C2
  // post-condition, same bullet as above (Req 2.5).
  it('a 503 AppError rejection gives the unavailable outcome', async () => {
    const loader = vi.fn(async () => {
      throw new AppError(503, 'QUOTE_PROVIDER_UNAVAILABLE', 'down');
    });
    initStockQuoteCache(loader);

    const result = await getStockQuoteBatch(['AAPL']);

    expect(result).toEqual([{ symbol: 'AAPL', status: 'unavailable' }]);
  });

  // Contract: pre — singleton seeded with a loader that rejects with a plain
  // (unmapped) Error; call — getStockQuoteBatch(['AAPL']); observe — outcome
  // { symbol: 'AAPL', status: 'unavailable' }; source — design C2
  // post-condition "...unexpected) gives status: 'unavailable'" (Req 2.5).
  it('an unexpected plain Error rejection gives the unavailable outcome', async () => {
    const loader = vi.fn(async () => {
      throw new Error('boom');
    });
    initStockQuoteCache(loader);

    const result = await getStockQuoteBatch(['AAPL']);

    expect(result).toEqual([{ symbol: 'AAPL', status: 'unavailable' }]);
  });

  // Contract: pre — singleton seeded with a loader that fails only for the
  // middle symbol; call — getStockQuoteBatch(['AAPL', 'ZZZZ', 'MSFT']);
  // observe — three outcomes in input order, AAPL and MSFT resolved ok and
  // ZZZZ unknown; source — Req 2.6 "WHEN one symbol's lookup fails THEN the
  // other symbols' outcomes SHALL still be returned" plus design C2 "one
  // outcome per input symbol, in input order".
  it('one failing symbol does not stop the others from resolving, in input order', async () => {
    const loader = vi.fn(async (s: string) => {
      if (s === 'ZZZZ') throw new NotFoundError('symbol', s);
      return quote(s, '1');
    });
    initStockQuoteCache(loader);

    const result = await getStockQuoteBatch(['AAPL', 'ZZZZ', 'MSFT']);

    expect(result).toEqual([
      { symbol: 'AAPL', status: 'ok', lastPrice: '1', fetchedAt: new Date(0).toISOString() },
      { symbol: 'ZZZZ', status: 'unknown' },
      { symbol: 'MSFT', status: 'ok', lastPrice: '1', fetchedAt: new Date(0).toISOString() },
    ]);
  });

  // Contract: pre — singleton seeded with a loader that parks each call on an
  // unresolved promise and records concurrently-running count; call —
  // getStockQuoteBatch with 10 distinct symbols and { concurrency: 3 },
  // draining the loader's in-flight promises wave by wave; observe — the
  // running-call count never exceeds 3 and every symbol is eventually
  // resolved; source — design C2 post-condition "At most `concurrency`
  // lookups run at once" (NFR Performance).
  it('runs at most `concurrency` loader calls at once', async () => {
    vi.useRealTimers();
    const symbols = Array.from({ length: 10 }, (_, i) => `SYM${i}`);
    let running = 0;
    let maxRunning = 0;
    let releases: Array<() => void> = [];
    const loader = vi.fn((s: string) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<StockQuoteData>((resolve) => {
        releases.push(() => {
          running -= 1;
          resolve(quote(s, '1'));
        });
      });
    });
    initStockQuoteCache(loader);

    const batchPromise = getStockQuoteBatch(symbols, { concurrency: 3, deadlineMs: 10_000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(maxRunning).toBe(3);

    while (releases.length > 0) {
      const wave = releases;
      releases = [];
      wave.forEach((release) => release());
      await new Promise((r) => setTimeout(r, 0));
    }

    await batchPromise;
    expect(loader).toHaveBeenCalledTimes(10);
    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  // Contract: pre — singleton seeded with a loader that never resolves within
  // the test, { concurrency: 1, deadlineMs: 100 } so the second symbol is
  // still queued when the deadline fires; call — getStockQuoteBatch(['SLOW',
  // 'QUEUED'], opts), advancing fake time past the deadline; observe — both
  // outcomes are unavailable and the loader was called only for 'SLOW',
  // never for 'QUEUED'; source — design C2 post-condition "When `deadlineMs`
  // passes, unresolved symbols give unavailable and unstarted ones are
  // never started" (NFR Performance).
  it('marks a slow symbol unavailable at the deadline and never starts a queued symbol', async () => {
    const calls: string[] = [];
    const loader = vi.fn((s: string) => {
      calls.push(s);
      return new Promise<StockQuoteData>(() => {
        // Deliberately never settles within the test.
      });
    });
    initStockQuoteCache(loader);

    const batchPromise = getStockQuoteBatch(['SLOW', 'QUEUED'], {
      concurrency: 1,
      deadlineMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await batchPromise;

    expect(result).toEqual([
      { symbol: 'SLOW', status: 'unavailable' },
      { symbol: 'QUEUED', status: 'unavailable' },
    ]);
    expect(calls).toEqual(['SLOW']);
  });
});
