// Symbols service (design v4 §symbols.service, REQ-2.3/2.4/3.1).
//
// Owns symbol search and the multi-container-safe population/refresh. Two seams:
//
//   - `syncSymbolsIfStale({ force })` — the PUBLIC bootstrap/admin entry point.
//     A NO-OP under `NODE_ENV === 'test'` (returns `skipped-test-env`), and its
//     ENTIRE body is wrapped so it ALWAYS resolves a `SyncOutcome` and never
//     rejects — the bootstrap fire-and-forget cannot produce an unhandled
//     rejection (REQ-2.3). All freshness gating lives here (the pre-delegation
//     short-circuit), not in the claim.
//   - `populateSymbols(db, fetchSec)` — the UNGUARDED, directly-callable seam
//     (no test-env check). It binds `$force = true` in its claim because it is
//     the unconditional "do the work now" step; the admin `POST /refresh` path
//     reaches it via `syncSymbolsIfStale({ force: true })`, which skips the
//     freshness short-circuit — if the claim bound `force = false` it would gate
//     against the freshly-synced table, match 0 rows, and make admin refresh a
//     silent no-op (violating REQ-2.4(d)). Service unit tests drive THIS seam
//     with a stub loader (injecting a fetcher into `syncSymbolsIfStale` would
//     not bypass the test-env guard, which fires first).

import type { SymbolSearchItem } from '@tradr/shared';

import { db, type Database } from '@/db';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { withTransaction } from '@/lib/transaction';

import { fetchSecSymbols } from './sec-symbols.client';
import {
  claimSync,
  ensureSyncStateRow,
  finalizeSyncFailure,
  finalizeSyncSuccess,
  pruneDelistedSymbols,
  readSyncState,
  searchSymbolsByPrefix,
  upsertSymbols,
} from './symbols.query';
import type { SymbolRow, SyncOutcome } from './symbols.types';

/** Successful sync freshness window: symbol reference data changes slowly. */
export const SYMBOLS_SYNC_TTL_MS = 86_400_000; // 24h
/** Stale-claim reclaim window: a crashed sync's claim is reclaimable after this. */
export const SYMBOLS_SYNC_RECLAIM_MS = 600_000; // 10min

/**
 * Ranked ticker-prefix search (REQ-3.1). Empty/whitespace `q` short-circuits to
 * `[]` so the query never builds `LIKE '%'`; otherwise delegates to the ranked
 * prefix query with the design-pinned default limit.
 */
export async function searchSymbols(db: Database, q: string): Promise<SymbolSearchItem[]> {
  const trimmed = q.trim();
  if (trimmed === '') return [];
  return searchSymbolsByPrefix(db, trimmed);
}

/**
 * Public population/refresh entry point (REQ-2.3/2.4). A no-op under
 * `NODE_ENV === 'test'`. Otherwise ALWAYS resolves a `SyncOutcome` (never
 * rejects): ensure the singleton row, read it, and on the hot read path
 * short-circuit `skipped-fresh` / `skipped-claimed` WITHOUT a write when not
 * forced and the data is fresh or another container holds a live claim; else
 * delegate to `populateSymbols`.
 */
export async function syncSymbolsIfStale({ force }: { force: boolean }): Promise<SyncOutcome> {
  if (config.NODE_ENV === 'test') return { status: 'skipped-test-env' };

  try {
    await ensureSyncStateRow(db);
    const state = await readSyncState(db);

    if (!force && state) {
      const now = Date.now();
      const fresh =
        state.lastSyncedAt != null && now - state.lastSyncedAt.getTime() < SYMBOLS_SYNC_TTL_MS;
      if (fresh) return { status: 'skipped-fresh' };

      const claimed =
        state.syncing &&
        state.syncingStartedAt != null &&
        now - state.syncingStartedAt.getTime() < SYMBOLS_SYNC_RECLAIM_MS;
      if (claimed) return { status: 'skipped-claimed' };
    }

    return await populateSymbols(db);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('symbol sync failed', { reason });
    return { status: 'error', reason };
  }
}

/**
 * The unconditional "do the work now" seam (design §Coordination steps 3-5).
 * Binds `$force = true` in the claim (see file header) — freshness gating lives
 * in `syncSymbolsIfStale`, not here. Flow: atomic single-row claim (0 rows ⇒
 * `skipped-claimed`); the winner then fetches SEC symbols HOLDING NO LOCK (the
 * single-statement claim has committed); upsert + prune run in ONE transaction
 * (replace-semantics — the table is never observed empty); finalize success.
 * On any failure the upsert/prune transaction rolls back so existing rows stay
 * intact (no prune-on-a-bad-fetch) and `last_synced_at` is left unchanged while
 * `last_error` is recorded, and `{ status: 'error', reason }` is returned.
 */
export async function populateSymbols(
  db: Database,
  fetchSec: () => Promise<SymbolRow[]> = fetchSecSymbols,
): Promise<SyncOutcome> {
  const claim = await claimSync(db, {
    force: true,
    ttlMs: SYMBOLS_SYNC_TTL_MS,
    reclaimMs: SYMBOLS_SYNC_RECLAIM_MS,
  });
  if (!claim) return { status: 'skipped-claimed' };

  try {
    const rows = await fetchSec();
    await withTransaction(db, async (tx) => {
      await upsertSymbols(tx, rows);
      await pruneDelistedSymbols(tx, claim.syncingStartedAt);
    });
    await finalizeSyncSuccess(db, rows.length);
    return { status: 'completed', symbolCount: rows.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('symbol population failed', { reason });
    await finalizeSyncFailure(db, reason);
    return { status: 'error', reason };
  }
}
