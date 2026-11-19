// @vitest-environment jsdom
//
// Contract block (design C7; Requirements 1.1, 1.2, 2.3, 2.4, 8.2, 8.3, 8.4).
// Seam for every case: `renderHook(() => useStockQuotes(symbols), { wrapper })`
// under a real `QueryClient`, with `@/lib/api`'s `api.get` mocked.
//
// | # | Pre-condition | Observable result | Source |
// |---|---|---|---|
// | 1 | three consumers mount together with overlapping symbol lists | exactly one `/symbols/quotes` call, for the sorted union | Req 8.3 / design C7.4 |
// | 2 | a second consumer mounts for an already-fresh symbol | no additional `/symbols/quotes` call | design C7.5 |
// | 3 | a symbol was received 49 s ago vs. 51 s ago, union widens | not sent at 49 s, sent at 51 s | design C7.5, QUOTE_DUE_AFTER_MS = 50_000 |
// | 4 | one consumer stays mounted for 60 s (fake timers) | a second request fires at the 60 s mark | Req 8.2, design C7.4 |
// | 5 | a `visibilitychange`/focus event fires after settle | no additional request | Req 8.2, design C7.4 (`refetchOnWindowFocus: false`) |
// | 6 | the input list holds one invalid symbol | it is never sent; `quote()` reads absent for it | Req 2.4, design C7.2 |
// | 7 | 120 distinct valid symbols | three requests, each ≤ 50 symbols, union covers all 120 | Req 2.3, design C7.5 (`QUOTE_BATCH_MAX`) |
// | 8 | a chunk rejects after an earlier symbol succeeded and a new symbol joins | the earlier price is kept; the new, never-fetched symbol reads absent; no retry | design C7.6, Restrictions (no retry) |
// | 9a | quote-config query never resolves | `configured` is `false`; no `/symbols/quotes` call | Req 1.1, 1.2 |
// | 9b | quote-config resolves `{ stockQuoteConfigured: false }` | `configured` is `false`; no `/symbols/quotes` call | Req 1.1 |
// | 10 | a batch response carries `ok`, `unknown` and `unavailable` outcomes | `ok` → `price`; `unknown`/`unavailable` → `absent` | design C7.7, Req 4.5 |
// | 11 | 50 symbols across widget/drawer/detail-shaped consumers, mounted together, 60 s | at most 3 `/symbols/quotes` calls | Req 8.4 |
// | 12 | a consumer unmounts | its symbol drops out of a later union's request | design C7.3 (unregister on unmount) |
// | 13 | `oldestFetchedAt` over no/mixed/only-non-price cells | `null`, or the earliest `price` cell's `fetchedAt` | design C7 interface |
//
// No collaborator inside `useStockQuotes` or the quote registry store is mocked;
// only the network seam (`api.get`) is. `resetQuoteRegistryForTests` and
// `resetStockQuoteFeedForTests` reset both module-level seams every test.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';
import { resetQuoteRegistryForTests } from '@/stores/quote-registry.store';

import {
  oldestFetchedAt,
  resetStockQuoteFeedForTests,
  useStockQuotes,
  type QuoteCell,
} from './useStockQuotes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function newClient(): QueryClient {
  return new QueryClient();
}

function okOutcome(symbol: string, lastPrice = '100.00', fetchedAt = '2026-11-19T10:00:00.000Z') {
  return { symbol, status: 'ok' as const, lastPrice, fetchedAt };
}

function makeSymbols(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const first = String.fromCharCode(65 + Math.floor(i / 26));
    const second = String.fromCharCode(65 + (i % 26));
    out.push(`${first}${second}`);
  }
  return out;
}

function quotesCalls(): string[][] {
  return vi
    .mocked(api.get)
    .mock.calls.filter(([path]) => typeof path === 'string' && path.startsWith('/symbols/quotes?'))
    .map(([path]) => {
      const qs = (path as string).split('?')[1] ?? '';
      return (new URLSearchParams(qs).get('symbols') ?? '').split(',').filter(Boolean);
    });
}

function mockApi(configured: boolean, quotesHandler?: (symbolsParam: string) => unknown) {
  vi.mocked(api.get).mockImplementation((path: string) => {
    if (path === '/symbols/quote-config') {
      return Promise.resolve({ stockQuoteConfigured: configured });
    }
    if (path.startsWith('/symbols/quotes')) {
      const qs = path.split('?')[1] ?? '';
      const symbolsParam = new URLSearchParams(qs).get('symbols') ?? '';
      if (!quotesHandler) {
        return Promise.resolve({ configured: false });
      }
      return Promise.resolve(quotesHandler(symbolsParam));
    }
    return Promise.reject(new Error(`unexpected path in test: ${path}`));
  });
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  resetQuoteRegistryForTests();
  resetStockQuoteFeedForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStockQuotes', () => {
  // #1 — Req 8.3
  it('sends one request for the union when three consumers mount together', async () => {
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    function useThree() {
      return {
        a: useStockQuotes(['AAPL']),
        b: useStockQuotes(['MSFT']),
        c: useStockQuotes(['AAPL', 'GOOGL']),
      };
    }

    const { result } = renderHook(() => useThree(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.a.quote('AAPL').state).toBe('price'));
    await waitFor(() => expect(result.current.b.quote('MSFT').state).toBe('price'));
    await waitFor(() => expect(result.current.c.quote('GOOGL').state).toBe('price'));

    expect(quotesCalls().length).toBe(1);
    expect(quotesCalls()[0]!.slice().sort()).toEqual(['AAPL', 'GOOGL', 'MSFT']);
  });

  // #2
  it('sends nothing for a second consumer whose symbols are already fresh', async () => {
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    const { result: result1 } = renderHook(() => useStockQuotes(['AAPL']), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result1.current.quote('AAPL').state).toBe('price'));
    expect(quotesCalls().length).toBe(1);

    const { result: result2 } = renderHook(() => useStockQuotes(['AAPL']), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result2.current.configured).toBe(true));
    await waitFor(() => expect(result2.current.quote('AAPL').state).toBe('price'));

    expect(quotesCalls().length).toBe(1);
  });

  // #3 — pins QUOTE_DUE_AFTER_MS = 50_000 exactly: not due at 49 s, due at 51 s.
  it('does not re-request a symbol received under 50 s ago, but does once 50 s has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    renderHook(() => useStockQuotes(['AAPL']), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(quotesCalls().length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(49_000);
    });
    renderHook(() => useStockQuotes(['AAPL', 'MSFT']), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // At 49 s: AAPL is still fresh, so only the never-fetched MSFT is sent.
    const secondCall = quotesCalls()[1] ?? [];
    expect(secondCall).toEqual(['MSFT']);
    expect(secondCall).not.toContain('AAPL');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000); // AAPL is now 51 s old.
    });
    renderHook(() => useStockQuotes(['AAPL', 'GOOGL']), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const thirdCall = quotesCalls()[2] ?? [];
    expect(thirdCall.slice().sort()).toEqual(['AAPL', 'GOOGL']);
  });

  // #4 — Req 8.2
  it('refetches 60 s after the first fetch while the surface stays mounted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    renderHook(() => useStockQuotes(['AAPL']), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(quotesCalls().length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(quotesCalls().length).toBe(2);
  });

  // #5 — Req 8.2, "SHALL NOT refetch on window focus"
  it('does not refetch on a window focus / visibility event', async () => {
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    const { result } = renderHook(() => useStockQuotes(['AAPL']), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.quote('AAPL').state).toBe('price'));
    expect(quotesCalls().length).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(quotesCalls().length).toBe(1);
  });

  // #6 — Req 2.4, design C7.2
  it('never sends an invalid symbol and reads it as absent', async () => {
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    const { result } = renderHook(() => useStockQuotes(['AAPL', 'AAPL!']), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.quote('AAPL').state).toBe('price'));

    expect(quotesCalls().flat()).not.toContain('AAPL!');
    expect(result.current.quote('AAPL!').state).toBe('absent');
  });

  // #7 — Req 2.3, design C7.5 (QUOTE_BATCH_MAX chunking)
  it('splits 120 symbols into three requests of at most 50 each', async () => {
    const symbols = makeSymbols(120);
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    const { result } = renderHook(() => useStockQuotes(symbols), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.quote(symbols[0]!).state).toBe('price'));
    await waitFor(() => expect(result.current.quote(symbols[119]!).state).toBe('price'));

    const calls = quotesCalls();
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.length).toBeLessThanOrEqual(50);
    }
    expect(calls.flat().slice().sort()).toEqual(symbols.slice().sort());
  });

  // #8 — design C7.6; Restrictions (no retry)
  it('keeps an earlier price after a failed chunk; a never-fetched symbol reads absent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let quotesCallCount = 0;
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === '/symbols/quote-config') {
        return Promise.resolve({ stockQuoteConfigured: true });
      }
      if (path.startsWith('/symbols/quotes')) {
        quotesCallCount += 1;
        if (quotesCallCount === 1) {
          return Promise.resolve({ configured: true, quotes: [okOutcome('AAPL')] });
        }
        return Promise.reject(new Error('network error'));
      }
      return Promise.reject(new Error(`unexpected path in test: ${path}`));
    });
    const qc = newClient();

    renderHook(() => useStockQuotes(['AAPL']), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // AAPL is now due (≥ 50 s old); MSFT joins the union and has never been
    // fetched. Both land in the one request for the new union, which fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(51_000);
    });
    const { result } = renderHook(() => useStockQuotes(['AAPL', 'MSFT']), {
      wrapper: makeWrapper(qc),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.quote('AAPL').state).toBe('price');
    expect(result.current.quote('MSFT').state).toBe('absent');
    // Exactly 2: the first success and the one failed attempt — no retry.
    expect(quotesCallCount).toBe(2);
  });

  // #9a — Req 1.1, 1.2
  it('reads as not configured while the quote-config query is still loading, sending nothing', async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path === '/symbols/quote-config') {
        return new Promise(() => {
          // never resolves
        });
      }
      return Promise.reject(new Error(`unexpected path in test: ${path}`));
    });
    const qc = newClient();

    const { result } = renderHook(() => useStockQuotes(['AAPL']), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.configured).toBe(false);
    expect(quotesCalls().length).toBe(0);
  });

  // #9b — Req 1.1
  it('reads as not configured when the provider is not configured, sending nothing', async () => {
    mockApi(false);
    const qc = newClient();

    const { result } = renderHook(() => useStockQuotes(['AAPL']), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.configured).toBe(false));

    expect(quotesCalls().length).toBe(0);
  });

  // #10 — design C7.7, Req 4.5
  it('maps an ok outcome to price and unknown/unavailable outcomes to absent', async () => {
    mockApi(true, () => ({
      configured: true,
      quotes: [
        okOutcome('AAPL', '142.50', '2026-11-19T10:00:00.000Z'),
        { symbol: 'ZZZZ', status: 'unknown' as const },
        { symbol: 'BAD', status: 'unavailable' as const },
      ],
    }));
    const qc = newClient();

    const { result } = renderHook(() => useStockQuotes(['AAPL', 'ZZZZ', 'BAD']), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.quote('AAPL').state).toBe('price'));
    const priceCell = result.current.quote('AAPL');
    expect(priceCell.state === 'price' && priceCell.lastPrice).toBe('142.50');
    expect(result.current.quote('ZZZZ').state).toBe('absent');
    expect(result.current.quote('BAD').state).toBe('absent');
  });

  // #11 — Req 8.4
  it('sends at most 3 requests in 60 s for 50 symbols across widget, drawer and detail consumers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fifty = makeSymbols(50);
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    function useSurfaces() {
      return {
        widget: useStockQuotes(fifty.slice(0, 5)),
        drawer: useStockQuotes(fifty),
        detail: useStockQuotes([fifty[0]!]),
      };
    }

    const { result } = renderHook(() => useSurfaces(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.drawer.quote(fifty[0]!).state).toBe('price');
    expect(quotesCalls().length).toBeLessThanOrEqual(3);
  });

  // #12 — design C7.3 (unregister on unmount)
  it('drops a symbol from the union once its only consumer has unmounted', async () => {
    mockApi(true, (symbolsParam) => ({
      configured: true,
      quotes: symbolsParam.split(',').map((s) => okOutcome(s)),
    }));
    const qc = newClient();

    const hookA = renderHook(() => useStockQuotes(['AAPL']), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(hookA.result.current.quote('AAPL').state).toBe('price'));

    const hookB = renderHook(() => useStockQuotes(['MSFT']), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(hookB.result.current.quote('MSFT').state).toBe('price'));

    hookA.unmount();

    const { result: hookC } = renderHook(() => useStockQuotes(['GOOGL']), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(hookC.current.quote('GOOGL').state).toBe('price'));

    const lastCall = quotesCalls().at(-1) ?? [];
    expect(lastCall).not.toContain('AAPL');
    expect(lastCall).toContain('GOOGL');
  });
});

describe('oldestFetchedAt', () => {
  // #13a
  it('returns null when there is no price cell', () => {
    const cells: QuoteCell[] = [{ state: 'loading' }, { state: 'absent' }];
    expect(oldestFetchedAt(cells)).toBeNull();
  });

  // #13b
  it('returns the earliest fetchedAt among price cells', () => {
    const cells: QuoteCell[] = [
      { state: 'price', lastPrice: '1', fetchedAt: '2026-11-19T10:05:00.000Z' },
      { state: 'price', lastPrice: '2', fetchedAt: '2026-11-19T10:01:00.000Z' },
      { state: 'absent' },
      { state: 'price', lastPrice: '3', fetchedAt: '2026-11-19T10:03:00.000Z' },
    ];
    expect(oldestFetchedAt(cells)).toBe('2026-11-19T10:01:00.000Z');
  });
});
