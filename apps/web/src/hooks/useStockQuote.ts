// useStockQuote — mutation for the calculator's "pull last price" affordance
// (design §hooks; REQ-5.2/5.4). A useMutation, not a useQuery, because the fetch
// fires when the user activates the button — not on render and not per keystroke.
// The mutationFn takes a symbol and does GET /api/symbols/:symbol/quote, yielding
// the projected StockQuoteResponse or, on failure, the thrown coded error the
// button surfaces for its error state. No runtime parse — api.get casts to the
// shared type, so only the compile-time-erased type is imported.

import { useMutation } from '@tanstack/react-query';

import type { StockQuoteResponse } from '@tradr/shared';

import { api } from '@/lib/api';

export function useStockQuote() {
  return useMutation({
    mutationFn: (symbol: string) =>
      api.get<StockQuoteResponse>(`/symbols/${encodeURIComponent(symbol)}/quote`),
  });
}
