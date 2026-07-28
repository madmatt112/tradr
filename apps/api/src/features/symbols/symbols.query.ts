// Drizzle access to `symbols` and `symbol_sync_state` (design §Backend —
// symbols.query). Every function takes a `Database | Transaction` handle as its
// first argument so callers compose them inside or outside a transaction, and
// all SQL is parameterized (no string interpolation of user input) — the
// prefix `LIKE` relies on the `varchar_pattern_ops` index from the schema.

import { eq, lt, sql } from 'drizzle-orm';

import type { SymbolSearchItem } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { symbols, symbolSyncState } from '@/db/schema';

import type { SymbolRow } from './symbols.types';

type Db = Database | Transaction;

/** Max autocomplete results returned by the search endpoint (design-pinned). */
export const SYMBOL_SEARCH_LIMIT = 10;

/**
 * Max rows per `upsertSymbols` INSERT. Each row binds 4 params
 * (ticker/name/exchange/cik); 1000 keeps every chunk far under Postgres'
 * 65535-parameter ceiling.
 */
const UPSERT_CHUNK_SIZE = 1000;

/** The full singleton coordination row shape (design §symbol_sync_state). */
export type SymbolSyncStateRow = typeof symbolSyncState.$inferSelect;

/**
 * Ranked ticker-prefix search (REQ-3.1/3.3). Projects the `SymbolSearchItem`
 * shape (`{ ticker, name, exchange }` — not the full `SymbolRow` with `cik`).
 * Ranking = exact match first, then ascending length, then alphabetical.
 *
 * ASSUMES a non-empty `q`: the handler short-circuits an empty/whitespace `q`
 * to `[]` before calling this, so this never builds `LIKE '%'` (which would
 * scan arbitrary rows). The `LIKE '<q>%'` prefix scan uses the
 * `symbols_ticker_prefix_idx` (`varchar_pattern_ops`) btree.
 */
export function searchSymbolsByPrefix(
  db: Db,
  q: string,
  limit: number = SYMBOL_SEARCH_LIMIT,
): Promise<SymbolSearchItem[]> {
  return db
    .select({ ticker: symbols.ticker, name: symbols.name, exchange: symbols.exchange })
    .from(symbols)
    .where(sql`${symbols.ticker} LIKE ${q + '%'}`)
    .orderBy(sql`(${symbols.ticker} = ${q}) DESC`, sql`length(${symbols.ticker})`, symbols.ticker)
    .limit(limit);
}

/**
 * Idempotent bulk upsert on conflict target `symbols.ticker` (REQ-2.4(a)).
 * Chunked to stay within Postgres parameter limits. **Callers pass already
 * DEDUPED rows** (`parseSecTickers`) so no single INSERT contains a duplicate
 * conflict-target key — otherwise Postgres raises SQLSTATE 21000 (`ON CONFLICT
 * DO UPDATE cannot affect row a second time`). Every upserted row is stamped
 * `updated_at = now()`, which `pruneDelistedSymbols` uses as the "touched this
 * sync" marker.
 */
export async function upsertSymbols(db: Db, rows: SymbolRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    await db
      .insert(symbols)
      .values(
        chunk.map((r) => ({
          ticker: r.ticker,
          name: r.name,
          exchange: r.exchange,
          cik: r.cik,
        })),
      )
      .onConflictDoUpdate({
        target: symbols.ticker,
        set: {
          name: sql`excluded.name`,
          exchange: sql`excluded.exchange`,
          cik: sql`excluded.cik`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/**
 * Remove rows the current successful fetch did NOT touch (delisted tickers) —
 * every surviving row was re-stamped `updated_at = now()` by `upsertSymbols`,
 * so anything older than this run's claim boundary is stale. Runs in the SAME
 * transaction as the upsert so the table is never observed empty, giving the
 * `symbols` table replace-semantics against the SEC source (REQ-2.1).
 */
export async function pruneDelistedSymbols(db: Db, syncStartedAt: Date): Promise<void> {
  // `lt(column, date)` (not a raw `sql` fragment) so drizzle applies the
  // timestamp column's driver encoder to the JS Date — a raw template has no
  // column-type context and postgres.js then rejects the un-encoded Date.
  await db.delete(symbols).where(lt(symbols.updatedAt, syncStartedAt));
}

/**
 * Idempotent guard: ensure the singleton `symbol_sync_state` row (id = 1)
 * exists before the first claim, so a missing seed row can never silently
 * disable population forever. `syncing` defaults to false.
 */
export async function ensureSyncStateRow(db: Db): Promise<void> {
  await db.insert(symbolSyncState).values({ id: 1 }).onConflictDoNothing();
}

/** Read the singleton coordination row (id = 1), or `undefined` if absent. */
export async function readSyncState(db: Db): Promise<SymbolSyncStateRow | undefined> {
  const [row] = await db.select().from(symbolSyncState).where(eq(symbolSyncState.id, 1)).limit(1);
  return row;
}

/**
 * Atomic single-row claim (REQ-2.4(c)): exactly one container wins per
 * staleness window. Sets `syncing = true`, `syncing_started_at = now()` iff no
 * other container holds a live claim (or its claim is older than `reclaimMs`)
 * AND the data is due (`force`, never synced, or older than `ttlMs`). Returns
 * the winning `syncing_started_at` (the prune boundary for this run), or
 * `undefined` (zero rows) for the loser / fresh / already-claimed case.
 *
 * The reclaim/ttl values are internal design constants (not user input); they
 * are still bound as parameters and cast to avoid interval-operator ambiguity.
 */
export async function claimSync(
  db: Db,
  opts: { force: boolean; ttlMs: number; reclaimMs: number },
): Promise<{ syncingStartedAt: Date } | undefined> {
  const { force, ttlMs, reclaimMs } = opts;
  const [row] = await db
    .update(symbolSyncState)
    .set({ syncing: true, syncingStartedAt: sql`now()` })
    .where(
      sql`${symbolSyncState.id} = 1
        AND (
          ${symbolSyncState.syncing} = false
          OR ${symbolSyncState.syncingStartedAt} < now() - make_interval(secs => ${reclaimMs}::double precision / 1000)
        )
        AND (
          ${force}::boolean
          OR ${symbolSyncState.lastSyncedAt} IS NULL
          OR ${symbolSyncState.lastSyncedAt} < now() - make_interval(secs => ${ttlMs}::double precision / 1000)
        )`,
    )
    .returning({ syncingStartedAt: symbolSyncState.syncingStartedAt });
  if (!row?.syncingStartedAt) return undefined;
  return { syncingStartedAt: row.syncingStartedAt };
}

/**
 * Finalize a successful sync (design §Coordination step 4): release the claim,
 * stamp `last_synced_at = now()`, record `symbol_count`, clear `last_error`.
 */
export async function finalizeSyncSuccess(db: Db, symbolCount: number): Promise<void> {
  await db
    .update(symbolSyncState)
    .set({
      syncing: false,
      lastSyncedAt: sql`now()`,
      symbolCount,
      lastError: null,
    })
    .where(eq(symbolSyncState.id, 1));
}

/**
 * Finalize a failed sync (design §Coordination step 5): release the claim and
 * record `last_error`. `last_synced_at` is left UNCHANGED so a later attempt
 * retries (the upsert+prune transaction rolled back, leaving existing rows
 * intact — no partial replace, no prune-on-a-bad-fetch).
 */
export async function finalizeSyncFailure(db: Db, reason: string): Promise<void> {
  await db
    .update(symbolSyncState)
    .set({ syncing: false, lastError: reason })
    .where(eq(symbolSyncState.id, 1));
}
