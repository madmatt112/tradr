/**
 * Symbols service unit tests (symbol-search-quotes Task 7; design v4
 * §symbols.service). Real Postgres via `src/test-setup.ts` — each test body
 * runs inside one rolled-back transaction, and `withTransaction` nests a
 * SAVEPOINT, so these exercise the REAL upsert + prune against live Postgres
 * with ZERO SEC egress: the population tests call `populateSymbols` DIRECTLY
 * with stub loaders (the unguarded seam). Injecting a fetcher into
 * `syncSymbolsIfStale` would NOT bypass the `NODE_ENV === 'test'` guard, which
 * fires first.
 *
 * FROZEN-`now()` caveat (load-bearing): Postgres `now()` = transaction_timestamp
 * is frozen across the whole test, so two back-to-back syncs would stamp both
 * `updated_at` and `syncing_started_at` to the same `T0` and never prune. The
 * replace-semantics test therefore DIRECT-INSERTS the "already-loaded" rows
 * with an explicitly OLDER `updated_at`, then calls `populateSymbols` ONCE.
 *
 * _Requirements: REQ-2.3, REQ-2.4(a-d), REQ-3.1_
 */
import { describe, expect, it } from 'vitest';

import { db } from '@/db';
import { symbols, symbolSyncState } from '@/db/schema';

import { readSyncState } from './symbols.query';
import { populateSymbols, searchSymbols, syncSymbolsIfStale } from './symbols.service';
import type { SymbolRow } from './symbols.types';

/** An explicitly back-dated `updated_at` — older than this test's frozen `now()`. */
const OLD_UPDATED_AT = new Date(Date.now() - 3_600_000); // T0 − 1h

/** Set of tickers currently in the `symbols` table (isolated per rolled-back test). */
async function tickerSet(): Promise<Set<string>> {
  const rows = await db.select({ ticker: symbols.ticker }).from(symbols);
  return new Set(rows.map((r) => r.ticker));
}

describe('searchSymbols (REQ-3.1)', () => {
  it('ranks exact-match first, then ascending length, then alphabetical', async () => {
    // Clear any committed leftovers first (inside the tx, rolled back at test end)
    // so the seeded fixture is isolated from a pre-populated shared DB.
    await db.delete(symbols);
    await db.insert(symbols).values([
      { ticker: 'AAP', name: 'Advance Auto Parts', exchange: 'NYSE', cik: 1 },
      { ticker: 'AAPL', name: 'Apple', exchange: 'NASDAQ', cik: 2 },
      { ticker: 'AA', name: 'Alcoa', exchange: 'NYSE', cik: 3 },
      { ticker: 'AAL', name: 'American Airlines', exchange: 'NASDAQ', cik: 4 },
    ]);

    const results = await searchSymbols(db, 'AA');
    // AA (exact) → AAL, AAP (len 3, alpha) → AAPL (len 4).
    expect(results.map((r) => r.ticker)).toEqual(['AA', 'AAL', 'AAP', 'AAPL']);
    // Projects the SymbolSearchItem shape (no `cik`).
    expect(results[0]).toEqual({ ticker: 'AA', name: 'Alcoa', exchange: 'NYSE' });
  });

  it('surfaces the exact ticker first for a fully-typed query', async () => {
    await db.delete(symbols); // clear committed leftovers within the rolled-back tx
    await db.insert(symbols).values([
      { ticker: 'AAPL', name: 'Apple', exchange: 'NASDAQ', cik: 2 },
      { ticker: 'AA', name: 'Alcoa', exchange: 'NYSE', cik: 3 },
    ]);

    const results = await searchSymbols(db, 'AAPL');
    expect(results[0].ticker).toBe('AAPL');
    expect(results.map((r) => r.ticker)).toEqual(['AAPL']);
  });

  it('returns [] for an empty or whitespace-only query (never LIKE %)', async () => {
    await db.delete(symbols); // clear committed leftovers within the rolled-back tx
    await db
      .insert(symbols)
      .values([{ ticker: 'AAPL', name: 'Apple', exchange: 'NASDAQ', cik: 2 }]);

    expect(await searchSymbols(db, '')).toEqual([]);
    expect(await searchSymbols(db, '   ')).toEqual([]);
  });

  it('respects the default result limit', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ticker: `ZZ${String(i).padStart(2, '0')}`,
      name: `Z ${i}`,
      exchange: 'NYSE' as const,
      cik: null,
    }));
    await db.delete(symbols); // clear committed leftovers within the rolled-back tx
    await db.insert(symbols).values(many);

    const results = await searchSymbols(db, 'ZZ');
    expect(results).toHaveLength(10);
    expect(results[0].ticker).toBe('ZZ00');
    expect(results[9].ticker).toBe('ZZ09');
  });
});

describe('populateSymbols (REQ-2.4)', () => {
  it('replace-semantics: prunes delisted tickers and adds new ones on success', async () => {
    await db.delete(symbols); // clear committed leftovers within the rolled-back tx
    // Reset the (possibly polluted) symbol_sync_state singleton to its pristine
    // migration-seed state — populateSymbols CLAIMS (not ensures) the id=1 row, so
    // keep exactly one, matching ensureSyncStateRow.
    await db.delete(symbolSyncState);
    await db.insert(symbolSyncState).values({ id: 1 });
    // Direct-insert the "already-loaded" rows with an explicitly OLDER updated_at
    // so the frozen-now() prune boundary can actually delete the dropped ticker.
    await db.insert(symbols).values([
      { ticker: 'AAPL', name: 'Apple', exchange: 'NASDAQ', cik: 320193, updatedAt: OLD_UPDATED_AT },
      {
        ticker: 'MSFT',
        name: 'Microsoft',
        exchange: 'NASDAQ',
        cik: 789019,
        updatedAt: OLD_UPDATED_AT,
      },
    ]);

    // Loader DROPS AAPL (delisted) and ADDS TSLA; keeps MSFT.
    const loader = async (): Promise<SymbolRow[]> => [
      { ticker: 'MSFT', name: 'Microsoft Corp', exchange: 'NASDAQ', cik: 789019 },
      { ticker: 'TSLA', name: 'Tesla', exchange: 'NASDAQ', cik: 1318605 },
    ];

    const outcome = await populateSymbols(db, loader);
    expect(outcome).toEqual({ status: 'completed', symbolCount: 2 });

    const present = await tickerSet();
    expect(present.has('AAPL')).toBe(false); // pruned (old updated_at < T0)
    expect(present.has('MSFT')).toBe(true); // upserted → survives
    expect(present.has('TSLA')).toBe(true); // newly inserted

    // Success finalization: last_error cleared, symbol_count recorded.
    const state = await readSyncState(db);
    expect(state?.lastError).toBeNull();
    expect(state?.symbolCount).toBe(2);
    expect(state?.syncing).toBe(false);
  });

  it('leaves existing rows intact and records last_error when the loader throws', async () => {
    await db.delete(symbols); // clear committed leftovers within the rolled-back tx
    // Reset the singleton to pristine so `last_synced_at` starts NULL — a failed
    // sync leaves it unchanged, so the toBeNull() assertion needs a clean baseline.
    await db.delete(symbolSyncState);
    await db.insert(symbolSyncState).values({ id: 1 });
    await db.insert(symbols).values([
      { ticker: 'AAPL', name: 'Apple', exchange: 'NASDAQ', cik: 320193, updatedAt: OLD_UPDATED_AT },
      {
        ticker: 'MSFT',
        name: 'Microsoft',
        exchange: 'NASDAQ',
        cik: 789019,
        updatedAt: OLD_UPDATED_AT,
      },
    ]);

    const loader = async (): Promise<SymbolRow[]> => {
      throw new Error('SEC fetch boom');
    };

    const outcome = await populateSymbols(db, loader);
    expect(outcome).toEqual({ status: 'error', reason: 'SEC fetch boom' });

    // No prune-on-a-bad-fetch: both existing rows survive.
    const present = await tickerSet();
    expect(present.has('AAPL')).toBe(true);
    expect(present.has('MSFT')).toBe(true);

    // Failure finalization: last_error set, claim released, last_synced_at unchanged.
    const state = await readSyncState(db);
    expect(state?.lastError).toBe('SEC fetch boom');
    expect(state?.syncing).toBe(false);
    expect(state?.lastSyncedAt).toBeNull();
  });
});

describe('syncSymbolsIfStale (REQ-2.3/2.4(b))', () => {
  it('is a guarded no-op returning skipped-test-env under NODE_ENV=test', async () => {
    expect(await syncSymbolsIfStale({ force: false })).toEqual({ status: 'skipped-test-env' });
    expect(await syncSymbolsIfStale({ force: true })).toEqual({ status: 'skipped-test-env' });
  });
});
