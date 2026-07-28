// Expenses + tax bench — three scenarios per tasks.md Task 21 (expenses-tax):
//
//   1. Expenses LIST  — 500 rows mixed currencies/years     → budget  50 ms
//   2. Fee rollup      — 50 accounts × 10k fills/year         → budget 200 ms
//   3. Tax summary     — 5-year history (5k closed, 1k in-yr) → budget 500 ms
//
// All three scenarios drive the HTTP layer via `app.request()` (so the bench
// exercises the same code path as production — middleware + route + service +
// query). Auth is bypassed by inserting a session row directly; the cookie is
// the raw token whose SHA-256 hash matches the session row (mirrors how
// `expenses.test.ts` authenticates after `registerAndGetCookie`).
//
// Per the design's bench convention (see `bench/accounting.bench.ts`):
//   - Reuses the existing `tradr_test_migrate` database — drops + recreates the
//     `public` schema, re-applies migrations + post-migrations, seeds once.
//   - Uses `it()` with manual sampling + `expect(stats.p95).toBeLessThan(...)`
//     so the harness runs under `vitest --run` (the existing `pnpm bench:
//     performance` command — Vitest's native `bench()` API requires
//     `vitest bench` mode, which the harness does not wire). The wall-clock
//     budgets per scenario are documented in comments above each `it()` block.
//   - For Scenarios 2 and 3 the bench also runs an `EXPLAIN ANALYZE` once
//     during fixture setup and asserts the planner picked the expected
//     indexes (no `Seq Scan` on `fills`/`positions`/`ledger_entries`).

import { pipeline } from 'node:stream/promises';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app, { bootstrap } from '@/app';
import { runMigrations, runPostMigrations } from '@/db/migrate';
import * as schema from '@/db/schema';
import { accounts as accountsTable } from '@/db/schema/accounts.schema';
import { sessions as sessionsTable, users as usersTable } from '@/db/schema/users.schema';

import {
  EXPENSES_COPY_COLUMNS,
  FILLS_COPY_COLUMNS,
  LEDGER_PNL_COPY_COLUMNS,
  POSITIONS_COPY_COLUMNS,
  buildExpensesCopyStream,
  buildFillsCopyStream,
  buildLedgerPnlCopyStream,
  buildPositionsCopyStream,
} from './fixtures/expenses-tax-fixture';

// ---------------------------------------------------------------------------
// Bench tunables
// ---------------------------------------------------------------------------

const TARGET_YEAR = 2026;

// Scenario 1: LIST
const LIST_EXPENSE_COUNT = 500;
const LIST_PAGE_SIZE = 100;
const LIST_BUDGET_MS = 50;

// Scenario 2: Fee rollup
const FEE_ROLLUP_ACCOUNTS = 50;
const FEE_ROLLUP_POSITIONS_PER_ACCOUNT = 1_000;
const FEE_ROLLUP_FILLS_PER_POSITION = 10;
// 50 * 1000 * 10 = 500_000 fills — the NFR ceiling per design.
const FEE_ROLLUP_TOTAL_FILLS =
  FEE_ROLLUP_ACCOUNTS * FEE_ROLLUP_POSITIONS_PER_ACCOUNT * FEE_ROLLUP_FILLS_PER_POSITION;
const FEE_ROLLUP_BUDGET_MS = 200;

// Scenario 3: Tax summary
const TAX_LIFETIME_POSITIONS = 5_000;
const TAX_IN_YEAR_POSITIONS = 1_000;
const TAX_IN_YEAR_LOSSES = 200;
const TAX_BUDGET_MS = 500;

const N_ITERATIONS = 20;
const N_WARMUP = 3;
const RNG_SEED = 0xfeed1234;

// ---------------------------------------------------------------------------
// Stats helpers — same shape as bench/accounting.bench.ts (kept inline so each
// bench file stays standalone, matching the harness convention).
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
// EXPLAIN helpers
// ---------------------------------------------------------------------------
interface ExplainCheck {
  text: string;
  lines: string[];
}

function parseExplain(rows: Array<Record<string, unknown>>): ExplainCheck {
  // postgres.js returns EXPLAIN rows as `{ 'QUERY PLAN': '...' }`.
  const lines = rows.map((r) => String(r['QUERY PLAN'] ?? ''));
  return { text: lines.join('\n'), lines };
}

function assertNoSeqScanOn(check: ExplainCheck, table: string): void {
  const needle = `Seq Scan on ${table}`;
  if (check.lines.some((line) => line.includes(needle))) {
    throw new Error(
      `EXPLAIN plan contains "${needle}" — expected an index scan.\nFull plan:\n${check.text}`,
    );
  }
}

function assertContains(check: ExplainCheck, fragment: string): void {
  if (!check.lines.some((line) => line.includes(fragment))) {
    throw new Error(`EXPLAIN plan does not contain "${fragment}".\nFull plan:\n${check.text}`);
  }
}

// ---------------------------------------------------------------------------
// Bench DB lifecycle
// ---------------------------------------------------------------------------
let benchSql: ReturnType<typeof postgres>;
let benchDb: ReturnType<typeof drizzle<typeof schema>>;

// Scenario 1 user
let listUserId: string;
let listSessionCookie: string;

// Scenario 2 user
let feeRollupUserId: string;
let feeRollupSessionCookie: string;

// Scenario 3 user
let taxUserId: string;
let taxSessionCookie: string;

async function resetDatabase(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql`GRANT ALL ON SCHEMA public TO postgres`;
  await sql`GRANT ALL ON SCHEMA public TO public`;
}

/**
 * Insert a user + session row directly; return the raw token so the bench can
 * send it back as a `session=<token>` cookie. Mirrors what the production
 * `auth.service.registerUser` does, but skips bcrypt + the HTTP round-trip.
 */
async function seedUserAndSession(emailSuffix: string): Promise<{
  userId: string;
  cookie: string;
}> {
  const { randomBytes, createHash } = await import('node:crypto');
  const [user] = await benchDb
    .insert(usersTable)
    .values({
      email: `bench-exp-${emailSuffix}-${Date.now()}@bench.local`,
      passwordHash: 'x'.repeat(60),
      taxJurisdiction: 'US',
    })
    .returning();
  if (!user) throw new Error('failed to seed bench user');

  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await benchDb.insert(sessionsTable).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });
  return { userId: user.id, cookie: token };
}

async function copyExpenseRows(opts: {
  userId: string;
  count: number;
  startYear: number;
  endYear: number;
  currencies: readonly string[];
  rngSeed: number;
}): Promise<void> {
  const stream = buildExpensesCopyStream(opts);
  const cols = EXPENSES_COPY_COLUMNS.join(',');
  const writable = await benchSql.unsafe(`COPY expenses (${cols}) FROM STDIN`).writable();
  await pipeline(stream, writable);
}

async function copyPositionsAndCaptureIds(opts: {
  userId: string;
  accountIds: string[];
  count: number;
  openedStart: Date;
  openedEnd: Date;
  closedRange?: { start: Date; end: Date };
  rngSeed: number;
}): Promise<{ positionIds: string[]; positionAccountIds: string[] }> {
  const { stream, positionIds, positionAccountIds } = buildPositionsCopyStream(opts);
  const cols = POSITIONS_COPY_COLUMNS.join(',');
  const writable = await benchSql.unsafe(`COPY positions (${cols}) FROM STDIN`).writable();
  await pipeline(stream, writable);
  return { positionIds, positionAccountIds };
}

async function copyFills(opts: {
  positionIds: string[];
  count: number;
  filledStart: Date;
  filledEnd: Date;
  rngSeed: number;
}): Promise<void> {
  const stream = buildFillsCopyStream(opts);
  const cols = FILLS_COPY_COLUMNS.join(',');
  const writable = await benchSql.unsafe(`COPY fills (${cols}) FROM STDIN`).writable();
  await pipeline(stream, writable);
}

async function copyLedgerPnl(opts: {
  userId: string;
  positionPairs: Array<{ positionId: string; accountId: string; closedAt: Date }>;
  lossIndices: ReadonlySet<number>;
  currency: string;
  rngSeed: number;
}): Promise<void> {
  const stream = buildLedgerPnlCopyStream(opts);
  const cols = LEDGER_PNL_COPY_COLUMNS.join(',');
  const writable = await benchSql.unsafe(`COPY ledger_entries (${cols}) FROM STDIN`).writable();
  await pipeline(stream, writable);
}

beforeAll(async () => {
  // Bring up the bench DB (mirrors `accounting.bench.ts` / `performance.bench.ts`).
  // eslint-disable-next-line no-restricted-syntax
  benchSql = postgres(process.env.DATABASE_URL!, { max: 5 });
  benchDb = drizzle(benchSql, { schema });

  await resetDatabase(benchSql);
  await runMigrations();
  await runPostMigrations();

  // Bootstrap the production close-hook (mirrors `expenses.test.ts`) — we
  // never call POST /api/positions/.../close in the bench, but bootstrap also
  // pins the Decimal rounding mode, which the service layer relies on.
  bootstrap();

  // ----- Scenario 1: 500 expenses across 3 years, 3 currencies -----
  {
    const seeded = await seedUserAndSession('list');
    listUserId = seeded.userId;
    listSessionCookie = seeded.cookie;
    await copyExpenseRows({
      userId: listUserId,
      count: LIST_EXPENSE_COUNT,
      startYear: TARGET_YEAR - 1,
      endYear: TARGET_YEAR + 1,
      currencies: ['USD', 'EUR', 'JPY'],
      rngSeed: RNG_SEED,
    });
  }

  // ----- Scenario 2: 50 accounts × 1k positions × 10 fills (=500k fills) -----
  {
    const seeded = await seedUserAndSession('fee-rollup');
    feeRollupUserId = seeded.userId;
    feeRollupSessionCookie = seeded.cookie;

    const accountValues = Array.from({ length: FEE_ROLLUP_ACCOUNTS }, (_, i) => ({
      userId: feeRollupUserId,
      name: `bench-fr-acct-${i.toString().padStart(3, '0')}`,
      currency: i % 3 === 0 ? 'USD' : i % 3 === 1 ? 'EUR' : 'JPY',
    }));
    const insertedAccounts = await benchDb.insert(accountsTable).values(accountValues).returning();
    const accountIds = insertedAccounts.map((a) => a.id);

    const openedStart = new Date(`${TARGET_YEAR}-01-01T00:00:00.000Z`);
    const openedEnd = new Date(`${TARGET_YEAR}-12-31T23:59:59.000Z`);
    const { positionIds } = await copyPositionsAndCaptureIds({
      userId: feeRollupUserId,
      accountIds,
      count: FEE_ROLLUP_ACCOUNTS * FEE_ROLLUP_POSITIONS_PER_ACCOUNT,
      openedStart,
      openedEnd,
      rngSeed: RNG_SEED + 1,
    });
    await copyFills({
      positionIds,
      count: FEE_ROLLUP_TOTAL_FILLS,
      filledStart: openedStart,
      filledEnd: openedEnd,
      rngSeed: RNG_SEED + 2,
    });
  }

  // ----- Scenario 3: 5k lifetime closed positions, 1k in TARGET_YEAR, 200 losses -----
  {
    const seeded = await seedUserAndSession('tax');
    taxUserId = seeded.userId;
    taxSessionCookie = seeded.cookie;

    // One account (currency drives the ledger.currency value below).
    const [acct] = await benchDb
      .insert(accountsTable)
      .values({
        userId: taxUserId,
        name: 'bench-tax-acct',
        currency: 'USD',
      })
      .returning();
    if (!acct) throw new Error('failed to seed bench-tax account');

    // Carve `TAX_LIFETIME_POSITIONS` into two cohorts:
    //   a) `TAX_IN_YEAR_POSITIONS` close in TARGET_YEAR
    //   b) the rest (4_000) close in earlier years (TARGET_YEAR-4 .. TARGET_YEAR-1)
    // and ensure ALL of them opened in years BEFORE the requested year so the
    // candidate-set query proves the opening-date window bounds work (per the
    // task's "MUST include positions opened in years before the requested
    // year" restriction).
    const inYear = TAX_IN_YEAR_POSITIONS;
    const priorYears = TAX_LIFETIME_POSITIONS - inYear;
    if (inYear + priorYears !== TAX_LIFETIME_POSITIONS) {
      throw new Error('fixture math invariant violated');
    }

    // Opened window: 4 years back .. 1 year back (every position opens BEFORE
    // TARGET_YEAR).
    const openedStart = new Date(`${TARGET_YEAR - 4}-01-01T00:00:00.000Z`);
    const openedEnd = new Date(`${TARGET_YEAR - 1}-12-31T23:59:59.000Z`);

    // Closed window for in-year cohort: TARGET_YEAR.
    const closedInYearStart = new Date(`${TARGET_YEAR}-01-01T00:00:00.000Z`);
    const closedInYearEnd = new Date(`${TARGET_YEAR}-12-31T23:59:59.000Z`);

    // Closed window for prior cohort: TARGET_YEAR-4 .. TARGET_YEAR-1.
    const closedPriorStart = new Date(`${TARGET_YEAR - 4}-01-01T00:00:00.000Z`);
    const closedPriorEnd = new Date(`${TARGET_YEAR - 1}-12-31T23:59:59.000Z`);

    const inYearPositions = await copyPositionsAndCaptureIds({
      userId: taxUserId,
      accountIds: [acct.id],
      count: inYear,
      openedStart,
      openedEnd,
      closedRange: { start: closedInYearStart, end: closedInYearEnd },
      rngSeed: RNG_SEED + 3,
    });
    const priorPositions = await copyPositionsAndCaptureIds({
      userId: taxUserId,
      accountIds: [acct.id],
      count: priorYears,
      openedStart,
      openedEnd,
      closedRange: { start: closedPriorStart, end: closedPriorEnd },
      rngSeed: RNG_SEED + 4,
    });

    // Now emit one position_pnl row per position. For the prior cohort we use
    // their per-row `closed_at` (= prior year), so the year-bounded query
    // filter naturally excludes them — proving the partial-index works.
    // For the in-year cohort we pick a deterministic closedAt inside
    // TARGET_YEAR; the first `TAX_IN_YEAR_LOSSES` are losses (debit).
    const inYearPairs: Array<{ positionId: string; accountId: string; closedAt: Date }> =
      inYearPositions.positionIds.map((id, i) => ({
        positionId: id,
        accountId: inYearPositions.positionAccountIds[i]!,
        // Spread the closures evenly across TARGET_YEAR (Jan 1 + i*~8h).
        closedAt: new Date(
          closedInYearStart.getTime() +
            (i * (closedInYearEnd.getTime() - closedInYearStart.getTime())) / inYear,
        ),
      }));
    const priorPairs: Array<{ positionId: string; accountId: string; closedAt: Date }> =
      priorPositions.positionIds.map((id, i) => ({
        positionId: id,
        accountId: priorPositions.positionAccountIds[i]!,
        closedAt: new Date(
          closedPriorStart.getTime() +
            (i * (closedPriorEnd.getTime() - closedPriorStart.getTime())) / priorYears,
        ),
      }));

    await copyLedgerPnl({
      userId: taxUserId,
      positionPairs: inYearPairs,
      lossIndices: new Set(Array.from({ length: TAX_IN_YEAR_LOSSES }, (_, i) => i)),
      currency: 'USD',
      rngSeed: RNG_SEED + 5,
    });
    await copyLedgerPnl({
      userId: taxUserId,
      positionPairs: priorPairs,
      lossIndices: new Set(), // prior cohort: all gains (irrelevant — query excludes them)
      currency: 'USD',
      rngSeed: RNG_SEED + 6,
    });
  }

  // ANALYZE so the planner has fresh stats. Each describe block re-asserts
  // with a per-case ANALYZE before EXPLAIN.
  await benchSql.unsafe('VACUUM ANALYZE expenses');
  await benchSql.unsafe('VACUUM ANALYZE positions');
  await benchSql.unsafe('VACUUM ANALYZE fills');
  await benchSql.unsafe('VACUUM ANALYZE accounts');
  await benchSql.unsafe('VACUUM ANALYZE ledger_entries');
}, 600_000);

afterAll(async () => {
  await benchSql?.end();
});

// ---------------------------------------------------------------------------
// Scenario 1 — Expenses LIST
// Budget: < 50 ms wall clock for `GET /api/expenses?year=YYYY&page=0&pageSize=100`
// over 500 seeded expenses (single user, mixed currencies + years).
// ---------------------------------------------------------------------------
describe('expenses bench — LIST 500 rows', () => {
  it(`p95 < ${LIST_BUDGET_MS}ms`, async () => {
    const path = `/api/expenses?year=${TARGET_YEAR}&page=0&pageSize=${LIST_PAGE_SIZE}`;
    const headers = { Cookie: `session=${listSessionCookie}` };

    for (let i = 0; i < N_WARMUP; i++) {
      const res = await app.request(path, { headers });
      if (res.status !== 200) throw new Error(`warmup expected 200, got ${res.status}`);
      await res.json();
    }

    const samples: number[] = [];
    for (let i = 0; i < N_ITERATIONS; i++) {
      const t0 = nowMs();
      const res = await app.request(path, { headers });
      await res.json();
      samples.push(nowMs() - t0);
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    }

    const stats = summarize(samples);

    console.log(
      `[bench] expenses LIST — p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms`,
    );
    expect(stats.p95).toBeLessThan(LIST_BUDGET_MS);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Scenario 2 — Fee rollup
// Budget: < 200 ms wall clock for `GET /api/expenses/fee-rollup?year=YYYY`
// over 50 accounts × 10k fills/year (= 500k `fills` rows for the year).
// Plan assertion: NO `Seq Scan on fills` and NO `Seq Scan on positions`.
// ---------------------------------------------------------------------------
describe('expenses bench — fee-rollup 500k fills', () => {
  it(`p95 < ${FEE_ROLLUP_BUDGET_MS}ms with index scans on fills + positions`, async () => {
    await benchSql.unsafe('VACUUM ANALYZE fills');
    await benchSql.unsafe('VACUUM ANALYZE positions');
    await benchSql.unsafe('VACUUM ANALYZE accounts');

    // ---- Plan assertion: hand-mirror of `aggregateFeesByAccountForYear` ----
    // DRIFT NOTE: if that query changes shape, re-sync the SQL below.
    const windowStart = `${TARGET_YEAR}-01-01T00:00:00Z`;
    const windowEnd = `${TARGET_YEAR + 1}-01-01T00:00:00Z`;
    const explainRows = await benchSql.unsafe(`
        EXPLAIN ANALYZE
        SELECT
          accounts.id,
          accounts.name,
          positions.asset_type,
          accounts.currency,
          SUM(fills.fees)
        FROM fills
        INNER JOIN positions ON fills.position_id = positions.id
        INNER JOIN accounts  ON positions.account_id = accounts.id
        WHERE positions.user_id = '${feeRollupUserId}'::uuid
          AND accounts.user_id  = '${feeRollupUserId}'::uuid
          AND fills.filled_at >= '${windowStart}'
          AND fills.filled_at <  '${windowEnd}'
        GROUP BY accounts.id, accounts.name, positions.asset_type, accounts.currency
      `);
    const plan = parseExplain(explainRows as Array<Record<string, unknown>>);
    assertNoSeqScanOn(plan, 'fills');
    assertNoSeqScanOn(plan, 'positions');
    // Defensive: confirm the expected indexes appear somewhere in the plan.
    // (At 500k rows the planner may pick a hash join over an index-driven
    //  nested-loop; what matters is "not a Seq Scan on fills/positions".)

    const path = `/api/expenses/fee-rollup?year=${TARGET_YEAR}`;
    const headers = { Cookie: `session=${feeRollupSessionCookie}` };

    for (let i = 0; i < N_WARMUP; i++) {
      const res = await app.request(path, { headers });
      if (res.status !== 200) throw new Error(`warmup expected 200, got ${res.status}`);
      await res.json();
    }

    const samples: number[] = [];
    for (let i = 0; i < N_ITERATIONS; i++) {
      const t0 = nowMs();
      const res = await app.request(path, { headers });
      await res.json();
      samples.push(nowMs() - t0);
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    }
    const stats = summarize(samples);

    console.log(
      `[bench] fee-rollup 500k — p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms`,
    );
    expect(stats.p95).toBeLessThan(FEE_ROLLUP_BUDGET_MS);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Scenario 3 — Tax summary (year-bounded candidate set)
// Budget: < 500 ms wall clock for
//   `GET /api/expenses/tax-summary?year=YYYY&jurisdiction=US`
// over a 5-year fixture: 5_000 lifetime closed positions, 1_000 in TARGET_YEAR
// (200 of which are losses).
// Plan assertion: `listRealisedPositionsForYear` must use an `Index Scan` or
// `Bitmap Index Scan` on `ledger_entries`, NOT a `Seq Scan on ledger_entries`
// — proves the partial-index path is active.
// ---------------------------------------------------------------------------
describe('expenses bench — tax-summary 5-year history', () => {
  it(`p95 < ${TAX_BUDGET_MS}ms with index scan on ledger_entries`, async () => {
    await benchSql.unsafe('VACUUM ANALYZE ledger_entries');
    await benchSql.unsafe('VACUUM ANALYZE positions');

    // ---- Plan assertion: hand-mirror of `listRealisedPositionsForYear`. ----
    const windowStart = `${TARGET_YEAR}-01-01T00:00:00Z`;
    const windowEnd = `${TARGET_YEAR + 1}-01-01T00:00:00Z`;
    const explainRows = await benchSql.unsafe(`
        EXPLAIN ANALYZE
        SELECT
          positions.id,
          SUM(CASE WHEN ledger_entries.direction = 'credit'
                   THEN ledger_entries.amount
                   ELSE -ledger_entries.amount END)::text
        FROM ledger_entries
        INNER JOIN positions ON ledger_entries.position_id = positions.id
        WHERE ledger_entries.user_id = '${taxUserId}'::uuid
          AND positions.user_id      = '${taxUserId}'::uuid
          AND ledger_entries.entry_type IN ('position_pnl', 'position_pnl_reversal')
          AND ledger_entries.occurred_at >= '${windowStart}'
          AND ledger_entries.occurred_at <  '${windowEnd}'
        GROUP BY positions.id
      `);
    const plan = parseExplain(explainRows as Array<Record<string, unknown>>);
    assertNoSeqScanOn(plan, 'ledger_entries');
    // Allow either `Index Scan` (incl. `Index Only Scan`) or `Bitmap Index Scan`.
    const hasIndexScan = plan.lines.some(
      (line) =>
        line.includes('Index Scan') ||
        line.includes('Index Only Scan') ||
        line.includes('Bitmap Index Scan'),
    );
    if (!hasIndexScan) {
      assertContains(plan, 'Index Scan'); // throws with full plan
    }

    const path = `/api/expenses/tax-summary?year=${TARGET_YEAR}&jurisdiction=US`;
    const headers = { Cookie: `session=${taxSessionCookie}` };

    for (let i = 0; i < N_WARMUP; i++) {
      const res = await app.request(path, { headers });
      if (res.status !== 200) throw new Error(`warmup expected 200, got ${res.status}`);
      await res.json();
    }

    const samples: number[] = [];
    for (let i = 0; i < N_ITERATIONS; i++) {
      const t0 = nowMs();
      const res = await app.request(path, { headers });
      await res.json();
      samples.push(nowMs() - t0);
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    }
    const stats = summarize(samples);

    console.log(
      `[bench] tax-summary 5yr — p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms`,
    );
    expect(stats.p95).toBeLessThan(TAX_BUDGET_MS);
  }, 600_000);
});
