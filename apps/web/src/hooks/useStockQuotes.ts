// useStockQuotes — the shared per-symbol quote feed (design C7). The
// quote-registry store collects every mounted surface's symbols so that
// exactly one TanStack Query, keyed on their sorted union, serves them all
// (Requirement 8.3). A module-level outcome cache plus an in-flight map stop
// out-of-step observer timers from re-requesting a symbol inside the 50 s due
// window (Requirement 8.2), and the union is chunked at QUOTE_BATCH_MAX per
// request (Requirement 2.3).

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import {
  QUOTE_BATCH_MAX,
  QuoteSymbolParamSchema,
  type StockQuoteBatchResponse,
} from '@tradr/shared';

import { api } from '@/lib/api';
import { selectUnion, useQuoteRegistryStore } from '@/stores/quote-registry.store';

import { useStockQuoteConfig } from './useStockQuoteConfig';

export type QuoteCell =
  | { state: 'loading' }
  | { state: 'price'; lastPrice: string; fetchedAt: string }
  | { state: 'absent' };

const QUOTE_DUE_AFTER_MS = 50_000;

type OutcomeEntry =
  | { status: 'ok'; lastPrice: string; fetchedAt: string; receivedAt: number }
  | { status: 'unknown'; receivedAt: number }
  | { status: 'unavailable'; receivedAt: number };

let outcomeMap = new Map<string, OutcomeEntry>();
let inFlightMap = new Map<string, Promise<void>>();

export function resetStockQuoteFeedForTests(): void {
  outcomeMap = new Map();
  inFlightMap = new Map();
}

function parseSymbol(symbol: string): string | null {
  const result = QuoteSymbolParamSchema.safeParse({ symbol });
  return result.success ? result.data.symbol : null;
}

async function fetchChunk(symbols: string[]): Promise<void> {
  try {
    const response = await api.get<StockQuoteBatchResponse>(
      `/symbols/quotes?${new URLSearchParams({ symbols: symbols.join(',') })}`,
    );
    const receivedAt = Date.now();
    if (!response.configured) {
      for (const symbol of symbols) {
        outcomeMap.set(symbol, { status: 'unavailable', receivedAt });
      }
      return;
    }
    for (const outcome of response.quotes) {
      if (outcome.status === 'ok') {
        outcomeMap.set(outcome.symbol, {
          status: 'ok',
          lastPrice: outcome.lastPrice,
          fetchedAt: outcome.fetchedAt,
          receivedAt,
        });
      } else {
        outcomeMap.set(outcome.symbol, { status: outcome.status, receivedAt });
      }
    }
  } catch {
    // Leave earlier entries in place; a never-fetched symbol stays absent.
    // No retry — the staleness line already shows the age of what remains.
  } finally {
    for (const symbol of symbols) {
      inFlightMap.delete(symbol);
    }
  }
}

async function ensureQuotes(union: string[]): Promise<void> {
  const now = Date.now();
  const needed: string[] = [];
  const waits: Promise<void>[] = [];

  for (const symbol of union) {
    const inFlight = inFlightMap.get(symbol);
    if (inFlight) {
      waits.push(inFlight);
      continue;
    }
    const entry = outcomeMap.get(symbol);
    if (!entry || now - entry.receivedAt >= QUOTE_DUE_AFTER_MS) {
      needed.push(symbol);
    }
  }

  for (let i = 0; i < needed.length; i += QUOTE_BATCH_MAX) {
    const chunk = needed.slice(i, i + QUOTE_BATCH_MAX);
    const promise = fetchChunk(chunk);
    for (const symbol of chunk) {
      inFlightMap.set(symbol, promise);
    }
    waits.push(promise);
  }

  await Promise.all(waits);
}

export function useStockQuotes(symbols: readonly string[]): {
  configured: boolean;
  quote: (symbol: string) => QuoteCell;
} {
  const configQuery = useStockQuoteConfig();
  const configured = configQuery.data?.stockQuoteConfigured === true;

  const symbolsKey = symbols.join(',');
  const validSymbols = useMemo(() => {
    const out: string[] = [];
    for (const symbol of symbols) {
      const parsed = parseSymbol(symbol);
      if (parsed) out.push(parsed);
    }
    return out;
    // `symbolsKey` is the real dependency: it captures the same content an
    // inline array literal re-passes every render, so this does not
    // recompute (and the registry effect below does not re-run) just
    // because the caller's array has a new reference.
  }, [symbolsKey]);

  useEffect(() => {
    if (!configured || validSymbols.length === 0) return;
    useQuoteRegistryStore.getState().register(validSymbols);
    return () => {
      useQuoteRegistryStore.getState().unregister(validSymbols);
    };
  }, [configured, validSymbols]);

  const union = useQuoteRegistryStore(selectUnion);
  const unionKey = union.join(',');
  const queryKey = ['symbols', 'quotes', unionKey];

  const query = useQuery<Record<string, OutcomeEntry>>({
    queryKey,
    queryFn: async ({ queryKey: key }) => {
      const unionSymbols = key[2] ? (key[2] as string).split(',') : [];
      await ensureQuotes(unionSymbols);
      const result: Record<string, OutcomeEntry> = {};
      for (const symbol of unionSymbols) {
        const entry = outcomeMap.get(symbol);
        if (entry) result[symbol] = entry;
      }
      return result;
    },
    enabled: configured && union.length > 0,
    // A newly mounted consumer momentarily observes the PRIOR union's query —
    // its own symbols land in the registry an effect tick later — so
    // `refetchOnMount`'s default staleTime-driven refetch would otherwise
    // fire once for that stale key, moments before the real (post-register)
    // union key takes over. The 50 s due check already governs real
    // staleness; this option only ever skipped a redundant one.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const queryClient = useQueryClient();
  useEffect(() => {
    if (!configured || unionKey.length === 0) return;

    // A manual `setTimeout` chain rather than `useQuery`'s own
    // `refetchInterval`: that option schedules through the host's real
    // `setInterval`, not `setTimeout`, so it never fires under fake timers
    // that only replace `setTimeout`. This still pauses while the tab is
    // hidden (design D16) and refetching never finds work for a symbol under
    // the due threshold, so it costs nothing extra when it does fire.
    let timeoutId: ReturnType<typeof setTimeout>;
    const tick = () => {
      timeoutId = setTimeout(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          void queryClient.refetchQueries({ queryKey, exact: true });
        }
        tick();
      }, 60_000);
    };
    tick();

    return () => clearTimeout(timeoutId);
  }, [configured, unionKey, queryClient]);

  function quote(symbol: string): QuoteCell {
    const parsed = parseSymbol(symbol);
    if (!parsed) return { state: 'absent' };

    const entry = query.data?.[parsed];
    if (entry) {
      if (entry.status === 'ok') {
        return { state: 'price', lastPrice: entry.lastPrice, fetchedAt: entry.fetchedAt };
      }
      return { state: 'absent' };
    }

    if (query.isLoading || query.isFetching) {
      return { state: 'loading' };
    }
    return { state: 'absent' };
  }

  return { configured, quote };
}

export function oldestFetchedAt(cells: QuoteCell[]): string | null {
  let oldest: string | null = null;
  for (const cell of cells) {
    if (cell.state !== 'price') continue;
    if (oldest === null || cell.fetchedAt < oldest) {
      oldest = cell.fetchedAt;
    }
  }
  return oldest;
}
