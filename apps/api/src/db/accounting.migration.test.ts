/**
 * Accounting migration test — verifies the covering index from Task 5 was
 * applied with `INCLUDE (amount)` so the balance-aggregation query plan can use
 * an Index Only Scan with Heap Fetches: 0 (see ledger-balances/design.md
 * §Data Models > index verification).
 *
 * Runs in the `migrations` vitest project against `tradr_test_migrate`
 * (migrations applied, no SAVEPOINT wrapping). Connects directly like
 * `migrate.test.ts` — does NOT use `apps/api/src/test-setup.ts`.
 */
import postgres from 'postgres';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';

import { runMigrations, runPostMigrations } from './migrate';

const DATABASE_URL =
  process.env.MIGRATE_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/tradr_test_migrate';

const INDEX_NAME = 'ledger_user_account_direction_amount_pnl_idx';
const OCCURRED_INDEX_NAME = 'ledger_user_account_occurred_pnl_idx';
const YEAR_INDEX_NAME = 'ledger_user_occurred_pnl_idx';

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  // Ensure migrations + post-migrations are applied before the index lookup.
  await runMigrations();
  await runPostMigrations();
  // The `types: { bigint }` override brands the client's `Sql` generic;
  // `sql`'s declared type is contravariant in that generic, so the cast is
  // required even though the client is unchanged at runtime.
  sql = postgres(DATABASE_URL, {
    max: 1,
    types: { bigint: postgres.BigInt },
  }) as unknown as postgres.Sql;
});

afterAll(async () => {
  await sql?.end();
});

describe('accounting migration — covering index', () => {
  it(`pg_indexes.indexdef for ${INDEX_NAME} contains "INCLUDE (amount)"`, async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;

    expect(
      rows,
      `Expected exactly one row in pg_indexes for "${INDEX_NAME}" — ` +
        `see ledger-balances/design.md §Data Models and tasks.md Task 5.`,
    ).toHaveLength(1);

    const indexdef = rows[0]!.indexdef;
    expect(
      indexdef.includes('INCLUDE (amount)'),
      `Expected pg_indexes.indexdef for "${INDEX_NAME}" to contain ` +
        `"INCLUDE (amount)" (the covering payload that enables Index Only ` +
        `Scan with Heap Fetches: 0 in the balance-aggregation query). ` +
        `Actual indexdef:\n  ${indexdef}\n` +
        `See ledger-balances/design.md §Data Models > index verification ` +
        `and tasks.md Task 5 (the manual-edit on migration 0006).`,
    ).toBe(true);
  });

  it('both partial index predicates and ledger_entry_type_chk admit "withdrawal_reversal"', async () => {
    // Migration 0035 (ledger-cash-movements) widens both partial indexes and the
    // CHECK with the four cash-movement entry types. A predicate silently reverting
    // to the three-value list (drizzle drops manual predicates on rebuild) must fail
    // loudly here rather than reject legitimate withdrawal-reversal rows in prod.
    const occurredIdx = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${OCCURRED_INDEX_NAME}
    `;
    expect(
      occurredIdx,
      `Expected exactly one row in pg_indexes for "${OCCURRED_INDEX_NAME}".`,
    ).toHaveLength(1);
    expect(
      occurredIdx[0]!.indexdef,
      `Expected pg_indexes.indexdef for "${OCCURRED_INDEX_NAME}" to contain ` +
        `"withdrawal_reversal" in its partial WHERE predicate.\n` +
        `Actual indexdef:\n  ${occurredIdx[0]?.indexdef}`,
    ).toContain('withdrawal_reversal');

    const directionIdx = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;
    expect(
      directionIdx,
      `Expected exactly one row in pg_indexes for "${INDEX_NAME}".`,
    ).toHaveLength(1);
    expect(
      directionIdx[0]!.indexdef,
      `Expected pg_indexes.indexdef for "${INDEX_NAME}" to contain ` +
        `"withdrawal_reversal" in its partial WHERE predicate.\n` +
        `Actual indexdef:\n  ${directionIdx[0]?.indexdef}`,
    ).toContain('withdrawal_reversal');

    const constraint = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conname = 'ledger_entry_type_chk'
    `;
    expect(
      constraint,
      `Expected exactly one row in pg_constraint for "ledger_entry_type_chk".`,
    ).toHaveLength(1);
    expect(
      constraint[0]!.def,
      `Expected pg_get_constraintdef for "ledger_entry_type_chk" to contain ` +
        `"withdrawal_reversal".\nActual def:\n  ${constraint[0]?.def}`,
    ).toContain('withdrawal_reversal');
  });
});

// Contract — ca-acb-pool-perf Task 4 (design.md §C4, AC 1.2/1.5/1.6):
//   Pre-condition: migrations (incl. 0041) applied to a fresh `tradr_test_migrate`.
//   Call (seam): `SELECT indexdef FROM pg_indexes WHERE indexname = 'ledger_user_occurred_pnl_idx'`.
//   Observable result: exactly one row; indexdef covers (user_id, occurred_at) and its
//     WHERE predicate names exactly 'position_pnl' and 'position_pnl_reversal', the same
//     two types `listRealisedPositionsForYear` filters on (expenses.query.ts:279), and
//     excludes every other ledger entry_type (e.g. 'balance_adjustment').
//   Source of expected value: design.md §C4 Interfaces + post-condition 2; the predicate
//     literal is copied from expenses.query.ts:279, not invented here.
// At base this index does not exist, so the row count is 0 and every assertion below fails.
describe('accounting migration — year-bounded P&L index (ca-acb-pool-perf C4)', () => {
  it(`pg_indexes has exactly one ${YEAR_INDEX_NAME} row, on (user_id, occurred_at), predicated on exactly the two position_pnl* types`, async () => {
    const rows = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = ${YEAR_INDEX_NAME}
    `;

    expect(
      rows,
      `Expected exactly one row in pg_indexes for "${YEAR_INDEX_NAME}" — ` +
        `see ca-acb-pool-perf/design.md §C4 and tasks.md Task 4.`,
    ).toHaveLength(1);

    const indexdef = rows[0]!.indexdef;

    expect(
      indexdef.includes('(user_id, occurred_at)'),
      `Expected pg_indexes.indexdef for "${YEAR_INDEX_NAME}" to cover ` +
        `(user_id, occurred_at) (design.md §C4 Interfaces).\n` +
        `Actual indexdef:\n  ${indexdef}`,
    ).toBe(true);

    // Quote-delimited with the trailing cast: a bare "'position_pnl'" substring
    // also matches inside "'position_pnl_reversal'", which would hide a predicate
    // that dropped the first type but kept the second.
    expect(
      indexdef.includes("'position_pnl'::character varying"),
      `Expected pg_indexes.indexdef for "${YEAR_INDEX_NAME}" to predicate on ` +
        `'position_pnl' (expenses.query.ts:279).\nActual indexdef:\n  ${indexdef}`,
    ).toBe(true);
    expect(
      indexdef.includes("'position_pnl_reversal'::character varying"),
      `Expected pg_indexes.indexdef for "${YEAR_INDEX_NAME}" to predicate on ` +
        `'position_pnl_reversal' (expenses.query.ts:279).\nActual indexdef:\n  ${indexdef}`,
    ).toBe(true);
    expect(
      indexdef.includes('balance_adjustment'),
      `Expected pg_indexes.indexdef for "${YEAR_INDEX_NAME}" to name only the two ` +
        `types the query filters on, not "balance_adjustment" (design.md §C4 ` +
        `post-condition 2).\nActual indexdef:\n  ${indexdef}`,
    ).toBe(false);
  });
});
