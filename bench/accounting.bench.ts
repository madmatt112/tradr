// Accounting bench — ledger LIST, accounts-list balance aggregation, and
// running-balance. Reuses the existing `tradr_test_migrate` DB the bench
// harness already targets (do NOT introduce a separate `tradr_bench`).
//
// Seeding strategy: 100k rows COPY-streamed across 50 accounts, plus an extra
// 50k rows COPY-streamed into account[0] so the ledger-list / running-balance
// cases have a deep single-account history. Drizzle inserts of 100k rows take
// minutes; postgres.js COPY drops it to ~1-2 seconds.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations, runPostMigrations } from '@/db/migrate';
import * as schema from '@/db/schema';
import { accounts as accountsTable, users as usersTable } from '@/db/schema';
import {
  aggregateBalancesForAccounts,
  listLedgerEntriesForAccount,
} from '@/features/accounting/accounting.query';

import { LEDGER_COPY_COLUMNS, buildLedgerCopyStream } from './fixtures/ledger-fixture';

// ---------------------------------------------------------------------------
// Bench tunables
// ---------------------------------------------------------------------------
const AGG_ACCOUNTS = 50;
const AGG_ROWS = 100_000;
const DEEP_ACCOUNT_ROWS = 50_000;
const N_ITERATIONS = 20;
const N_WARMUP = 3;
const RNG_SEED = 0xabcdef;
const CURRENCY = 'USD';

const LEDGER_LIST_BUDGET_MS = 50;
const AGGREGATION_BUDGET_MS = 100;
const RUNNING_BALANCE_BUDGET_MS = 200;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASELINE_PATH = path.resolve(__dirname, 'baselines/accounting.json');

// ---------------------------------------------------------------------------
// Stats helpers (mirrors performance.bench.ts — kept inline rather than
// extracted because the harness deliberately avoids a shared utils module
// to keep each bench file standalone).
// ---------------------------------------------------------------------------
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx]!;
}

function summarize(samples: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length > 0 ? sum / sorted.length : 0,
  };
}

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

// ---------------------------------------------------------------------------
// EXPLAIN parsing — assert plan-node FIRST, heap-fetches SECOND.
// The two-step order distinguishes "wrong plan" from "right plan, sparse
// visibility map" (per design §Testing Strategy). The plan-node assertion
// fails loudly when the planner picks a different scan; the heap-fetches
// assertion fails loudly when the covering index loses its `INCLUDE (amount)`.
// ---------------------------------------------------------------------------
interface ExplainCheck {
  /** Whole EXPLAIN output (joined). */
  text: string;
  /** Lines for easier per-line searches. */
  lines: string[];
}

function parseExplain(rows: Array<Record<string, unknown>>): ExplainCheck {
  // postgres.js returns `EXPLAIN ANALYZE` rows as `{ 'QUERY PLAN': '...' }`.
  // The exact key name is "QUERY PLAN" (Postgres preserves the case).
  const lines = rows.map((r) => String(r['QUERY PLAN'] ?? ''));
  return { text: lines.join('\n'), lines };
}

function assertIndexOnlyScan(check: ExplainCheck, indexName: string): void {
  // Look for the EXACT "Index Only Scan using <indexName>" plan-node line.
  // The plan-node line appears as e.g.
  //   `->  Index Only Scan using ledger_user_account_direction_amount_pnl_idx on ledger_entries`
  const needle = `Index Only Scan using ${indexName}`;
  const found = check.lines.some((line) => line.includes(needle));
  if (!found) {
    throw new Error(
      `EXPLAIN plan does not contain expected node "${needle}".\n` + `Full plan:\n${check.text}`,
    );
  }
}

function assertHeapFetchesZero(check: ExplainCheck): void {
  // After Postgres `EXPLAIN (ANALYZE, BUFFERS)`, an Index Only Scan emits a
  // line like `Heap Fetches: 0`. Anything > 0 means the visibility map is
  // sparse OR (more importantly) the covering index lost `INCLUDE (amount)`
  // and Postgres had to visit the heap.
  const heapLine = check.lines.find((line) => /Heap Fetches:\s+\d+/.test(line));
  if (!heapLine) {
    throw new Error(
      `EXPLAIN plan does not contain a "Heap Fetches:" line — Index Only ` +
        `Scan may not have been chosen.\nFull plan:\n${check.text}`,
    );
  }
  const m = heapLine.match(/Heap Fetches:\s+(\d+)/);
  const count = m ? Number(m[1]) : NaN;
  if (!(count === 0)) {
    throw new Error(
      `Expected "Heap Fetches: 0" — got "${heapLine.trim()}". Covering ` +
        `index may have lost INCLUDE (amount).\nFull plan:\n${check.text}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Bench DB lifecycle
// ---------------------------------------------------------------------------
let benchSql: ReturnType<typeof postgres>;
let benchDb: ReturnType<typeof drizzle<typeof schema>>;
let benchUserId: string;
let benchAccountIds: string[];
let deepAccountId: string; // the account with DEEP_ACCOUNT_ROWS entries

async function resetDatabase(sql: ReturnType<typeof postgres>): Promise<void> {
  // Mirrors performance.bench.ts — bench DB is dedicated, safe to drop.
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql`GRANT ALL ON SCHEMA public TO postgres`;
  await sql`GRANT ALL ON SCHEMA public TO public`;
}

async function seedUserAndAccounts(): Promise<void> {
  const [user] = await benchDb
    .insert(usersTable)
    .values({
      email: `bench-accounting-${Date.now()}@bench.local`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  if (!user) throw new Error('failed to seed bench user');
  benchUserId = user.id;

  const accountValues = Array.from({ length: AGG_ACCOUNTS }, (_, i) => ({
    userId: user.id,
    name: `bench-acct-${i.toString().padStart(3, '0')}`,
    currency: CURRENCY,
  }));
  const inserted = await benchDb.insert(accountsTable).values(accountValues).returning();
  benchAccountIds = inserted.map((a) => a.id);
  deepAccountId = benchAccountIds[0]!;
}

async function copyLedgerRows(opts: {
  userId: string;
  accountIds: string[];
  count: number;
  rngSeed: number;
  start: Date;
  end: Date;
}): Promise<void> {
  const stream = buildLedgerCopyStream({
    userId: opts.userId,
    accountIds: opts.accountIds,
    count: opts.count,
    start: opts.start,
    end: opts.end,
    rngSeed: opts.rngSeed,
    currency: CURRENCY,
  });
  const cols = LEDGER_COPY_COLUMNS.join(',');
  // postgres.js text-format COPY: tab delimiter, `\N` for NULL — matches
  // the byte layout produced by `buildLedgerCopyStream`.
  const writable = await benchSql.unsafe(`COPY ledger_entries (${cols}) FROM STDIN`).writable();
  await pipeline(stream, writable);
}

beforeAll(async () => {
  // eslint-disable-next-line no-restricted-syntax
  benchSql = postgres(process.env.DATABASE_URL!, { max: 5 });
  benchDb = drizzle(benchSql, { schema });

  await resetDatabase(benchSql);
  await runMigrations();
  await runPostMigrations();

  await seedUserAndAccounts();

  // ---- Round-robin 100k across all 50 accounts (aggregation case) ----
  const start = new Date('2024-01-01T00:00:00.000Z');
  const end = new Date('2026-01-01T00:00:00.000Z');
  await copyLedgerRows({
    userId: benchUserId,
    accountIds: benchAccountIds,
    count: AGG_ROWS,
    rngSeed: RNG_SEED,
    start,
    end,
  });

  // ---- 50k extra rows into account[0] (ledger-list + running-balance) ----
  await copyLedgerRows({
    userId: benchUserId,
    accountIds: [deepAccountId],
    count: DEEP_ACCOUNT_ROWS,
    rngSeed: RNG_SEED + 1,
    start,
    end,
  });

  // VACUUM ANALYZE so the planner has fresh stats AND the visibility map is
  // built (the latter is what lets the covering index achieve Heap Fetches: 0).
  // Run once here; each describe block reasserts with a per-case ANALYZE in
  // case prior measurements dirty stats. ANALYZE must run OUTSIDE a transaction
  // — postgres.js `sql.unsafe` issues each call as its own simple-query.
  await benchSql.unsafe('VACUUM ANALYZE ledger_entries');
  await benchSql.unsafe('VACUUM ANALYZE accounts');
}, 600_000);

afterAll(async () => {
  await benchSql?.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('accounting bench — ledger LIST page 50', () => {
  it(`p95 < ${LEDGER_LIST_BUDGET_MS}ms over 50k entries`, async () => {
    await benchSql.unsafe('VACUUM ANALYZE ledger_entries');

    const params = {
      userId: benchUserId,
      accountId: deepAccountId,
      limit: 50,
      offset: 50 * 49, // page 50 (1-indexed), pageSize 50
    };

    // warmup
    for (let i = 0; i < N_WARMUP; i++) {
      await listLedgerEntriesForAccount(benchDb, params);
    }

    const samples: number[] = [];
    for (let i = 0; i < N_ITERATIONS; i++) {
      const t0 = nowMs();
      await listLedgerEntriesForAccount(benchDb, params);
      samples.push(nowMs() - t0);
    }

    const stats = summarize(samples);
    console.log(
      `[bench] ledger-list page 50 — p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms`,
    );
    expect(stats.p95).toBeLessThan(LEDGER_LIST_BUDGET_MS);
  }, 600_000);
});

describe('accounting bench — accounts-list balance aggregation', () => {
  it(
    `p95 < ${AGGREGATION_BUDGET_MS}ms over 50 accounts × 100k entries, ` +
      `with Index Only Scan + Heap Fetches: 0`,
    async () => {
      await benchSql.unsafe('VACUUM ANALYZE ledger_entries');

      // ---- Plan assertion FIRST: confirm the planner picks the covering index. ----
      // ---- Heap-fetches assertion SECOND: confirm the index is actually covering. ----
      // The two-step order distinguishes "wrong plan" from "right plan, sparse
      // visibility map" — see design §Testing Strategy.
      //
      // DRIFT NOTE: the EXPLAIN body below is a hand-mirror of
      // `aggregateBalancesForAccounts`. If that service query gains an ORDER BY,
      // an extra projection, or otherwise changes shape, this EXPLAIN will keep
      // asserting on the OLD shape. Reviewers should re-sync this block when
      // editing `aggregateBalancesForAccounts`.
      const accountIdsLiteral = benchAccountIds.map((id) => `'${id}'::uuid`).join(',');
      const explainRows = await benchSql.unsafe(`
        EXPLAIN (ANALYZE, BUFFERS)
        SELECT
          account_id,
          (
            COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)
          )::text AS balance
        FROM ledger_entries
        WHERE user_id = '${benchUserId}'::uuid
          AND account_id IN (${accountIdsLiteral})
          AND entry_type IN ('position_pnl', 'position_pnl_reversal')
        GROUP BY account_id
      `);
      const check = parseExplain(explainRows as Array<Record<string, unknown>>);
      assertIndexOnlyScan(check, 'ledger_user_account_direction_amount_pnl_idx');
      assertHeapFetchesZero(check);

      // ---- Timed measurement ----
      // warmup
      for (let i = 0; i < N_WARMUP; i++) {
        await aggregateBalancesForAccounts(benchDb, benchUserId, benchAccountIds);
      }
      const samples: number[] = [];
      for (let i = 0; i < N_ITERATIONS; i++) {
        const t0 = nowMs();
        await aggregateBalancesForAccounts(benchDb, benchUserId, benchAccountIds);
        samples.push(nowMs() - t0);
      }
      const stats = summarize(samples);
      console.log(
        `[bench] aggregation 50×100k — p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms`,
      );
      expect(stats.p95).toBeLessThan(AGGREGATION_BUDGET_MS);
    },
    600_000,
  );
});

describe('accounting bench — running-balance LIST page 50', () => {
  it(`p95 < ${RUNNING_BALANCE_BUDGET_MS}ms over 50k entries`, async () => {
    await benchSql.unsafe('VACUUM ANALYZE ledger_entries');

    // `listLedgerEntriesForAccount` already computes the running-balance
    // anchor via a SUM aggregate over the older rows — that's the case the
    // task targets. We re-measure it here at a deeper page where the
    // SUM-over-older-rows is largest (the running-balance work scales with
    // offset position).
    const params = {
      userId: benchUserId,
      accountId: deepAccountId,
      limit: 50,
      offset: 50 * 49,
    };

    for (let i = 0; i < N_WARMUP; i++) {
      await listLedgerEntriesForAccount(benchDb, params);
    }

    const samples: number[] = [];
    for (let i = 0; i < N_ITERATIONS; i++) {
      const t0 = nowMs();
      const res = await listLedgerEntriesForAccount(benchDb, params);
      samples.push(nowMs() - t0);
      // Sanity check: the anchor balance should be a non-null numeric string.
      if (i === 0) {
        if (typeof res.runningBalanceAtFirstRow !== 'string') {
          throw new Error('runningBalanceAtFirstRow missing');
        }
      }
    }

    const stats = summarize(samples);
    console.log(
      `[bench] running-balance page 50 — p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms`,
    );
    expect(stats.p95).toBeLessThan(RUNNING_BALANCE_BUDGET_MS);

    // ---- Write the baseline so a CI/manual run leaves a record. ----
    const baseline = {
      generatedAt: new Date().toISOString(),
      aggregateAccounts: AGG_ACCOUNTS,
      aggregateRows: AGG_ROWS,
      deepAccountRows: DEEP_ACCOUNT_ROWS,
      iterations: N_ITERATIONS,
      warmup: N_WARMUP,
      rngSeed: RNG_SEED,
      node: process.version,
      platform: process.platform,
      cases: {
        ledgerListBudgetMs: LEDGER_LIST_BUDGET_MS,
        aggregationBudgetMs: AGGREGATION_BUDGET_MS,
        runningBalanceBudgetMs: RUNNING_BALANCE_BUDGET_MS,
      },
    };
    await mkdir(path.dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  }, 600_000);
});
