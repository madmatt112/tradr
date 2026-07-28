// Internal types for the symbols feature (design v4, REQ-2).
//
// Pinned by the design so tasks need not invent them: the projected upsertable
// row shape (`SymbolRow`) and the always-resolving population/refresh result
// (`SyncOutcome`). Kept here so the source client, query layer, and service
// share one definition.

/** One SEC-sourced, upsertable reference row. `exchange` is canonicalized. */
export type SymbolRow = {
  ticker: string;
  name: string;
  exchange: 'NYSE' | 'NASDAQ';
  cik: number | null;
};

/**
 * The outcome of `syncSymbolsIfStale` — a discriminated union that NEVER
 * rejects (the bootstrap fire-and-forget cannot produce an unhandled
 * rejection, REQ-2.3). Verbatim from design v4.
 */
export type SyncOutcome =
  | { status: 'completed'; symbolCount: number }
  | { status: 'skipped-fresh' }
  | { status: 'skipped-claimed' }
  | { status: 'skipped-test-env' }
  | { status: 'error'; reason: string };
