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

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  // Ensure migrations + post-migrations are applied before the index lookup.
  await runMigrations();
  await runPostMigrations();
  sql = postgres(DATABASE_URL, { max: 1, types: { bigint: postgres.BigInt } });
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
});
