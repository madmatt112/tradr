// Quote registry store (design C6) — collects the symbols every mounted
// surface wants to display, so useStockQuotes can fetch one union instead of
// one request per surface (Requirement 8.3).

import { create } from 'zustand';

export interface QuoteRegistryState {
  counts: Record<string, number>;
  // Derived from `counts` on every `register`/`unregister`, not recomputed per
  // selector call: `useSyncExternalStore` (what zustand's hook is built on)
  // requires a selector's result to stay referentially stable between renders
  // when nothing changed, or it re-renders forever.
  union: string[];
  register: (symbols: string[]) => void;
  unregister: (symbols: string[]) => void;
}

function computeUnion(counts: Record<string, number>): string[] {
  return Object.keys(counts)
    .filter((symbol) => counts[symbol]! > 0)
    .sort();
}

export const useQuoteRegistryStore = create<QuoteRegistryState>((set) => ({
  counts: {},
  union: [],
  register: (symbols) =>
    set((state) => {
      const counts = { ...state.counts };
      for (const symbol of symbols) {
        counts[symbol] = (counts[symbol] ?? 0) + 1;
      }
      return { counts, union: computeUnion(counts) };
    }),
  unregister: (symbols) =>
    set((state) => {
      const counts = { ...state.counts };
      for (const symbol of symbols) {
        const next = (counts[symbol] ?? 0) - 1;
        if (next <= 0) {
          delete counts[symbol];
        } else {
          counts[symbol] = next;
        }
      }
      return { counts, union: computeUnion(counts) };
    }),
}));

export function selectUnion(state: QuoteRegistryState): string[] {
  return state.union;
}

export function resetQuoteRegistryForTests(): void {
  useQuoteRegistryStore.setState({ counts: {}, union: [] });
}
