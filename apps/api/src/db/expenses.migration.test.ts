/**
 * Expenses migration test — verifies the schema artefacts introduced by
 * migration 0007 (`expenses` table, `users.tax_jurisdiction` column, the
 * partial UNIQUE index on `ledger_entries`) per expenses-tax/design.md
 * §Testing Strategy ("Migration test").
 *
 * Mirrors `accounting.migration.test.ts`: runs in the `migrations` vitest
 * project against `tradr_test_migrate` (migrations applied, no SAVEPOINT
 * wrapping), connects directly like `migrate.test.ts`, and does NOT use
 * `apps/api/src/test-setup.ts`.
 *
 * Tuple sources (`EXPENSE_CATEGORIES`, `CURRENCY_CODES`) are imported from
 * `@tradr/shared` so the assertions stay in sync with the runtime constants
 * — the whole point of this test is to catch tuple-vs-CHECK drift.
 */
import postgres from 'postgres';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';

import { CURRENCY_CODES } from '@tradr/shared/constants/currencies';
import { EXPENSE_CATEGORIES } from '@tradr/shared/constants/expense-categories';

import { runMigrations, runPostMigrations } from './migrate';

const DATABASE_URL =
  process.env.MIGRATE_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5433/tradr_test_migrate';

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  await runMigrations();
  await runPostMigrations();
  sql = postgres(DATABASE_URL, { max: 1, types: { bigint: postgres.BigInt } });
});

afterAll(async () => {
  await sql?.end();
});

async function getIndexDef(indexName: string): Promise<string | null> {
  const rows = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE indexname = ${indexName}
  `;
  return rows[0]?.indexdef ?? null;
}

async function getConstraintDef(constraintName: string): Promise<string | null> {
  const rows = await sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname = ${constraintName}
  `;
  return rows[0]?.def ?? null;
}

describe('expenses migration — indexes', () => {
  it('pg_indexes contains expenses_user_id_idx', async () => {
    const def = await getIndexDef('expenses_user_id_idx');
    expect(def, 'Expected expenses_user_id_idx in pg_indexes').not.toBeNull();
  });

  it('pg_indexes contains expenses_user_occurred_idx', async () => {
    const def = await getIndexDef('expenses_user_occurred_idx');
    expect(def, 'Expected expenses_user_occurred_idx in pg_indexes').not.toBeNull();
  });

  it('ledger_position_pnl_unique_idx is ABSENT — dropped by the ledger-balances reversal amendment (d-536e8750, migration 0020)', async () => {
    // A reopen→re-close legitimately writes multiple position_pnl rows per
    // position, so the former one-row-per-position UNIQUE partial index was
    // dropped (migration 0020). The "≤1 un-reversed position_pnl per position"
    // property is now guaranteed by the position state machine + the
    // reverse-hook co-registration invariant, not this index.
    const def = await getIndexDef('ledger_position_pnl_unique_idx');
    expect(
      def,
      'Expected ledger_position_pnl_unique_idx to be ABSENT from pg_indexes (dropped by migration 0020)',
    ).toBeNull();
  });
});

describe('expenses migration — constraints', () => {
  it('expenses_amount_positive_chk exists in pg_constraint', async () => {
    const def = await getConstraintDef('expenses_amount_positive_chk');
    expect(def, 'Expected expenses_amount_positive_chk in pg_constraint').not.toBeNull();
  });

  it('expenses_category_chk lists every EXPENSE_CATEGORIES value', async () => {
    const def = await getConstraintDef('expenses_category_chk');
    expect(def, 'Expected expenses_category_chk in pg_constraint').not.toBeNull();
    for (const category of EXPENSE_CATEGORIES) {
      expect(
        def!.includes(`'${category}'`),
        `Expected expenses_category_chk def to contain '${category}'. ` + `Actual:\n  ${def}`,
      ).toBe(true);
    }
  });

  it('expenses_currency_chk lists every CURRENCY_CODES value', async () => {
    const def = await getConstraintDef('expenses_currency_chk');
    expect(def, 'Expected expenses_currency_chk in pg_constraint').not.toBeNull();
    for (const code of CURRENCY_CODES) {
      expect(
        def!.includes(`'${code}'`),
        `Expected expenses_currency_chk def to contain '${code}'. ` + `Actual:\n  ${def}`,
      ).toBe(true);
    }
  });

  it('users_tax_jurisdiction_chk lists US, CA, other', async () => {
    const def = await getConstraintDef('users_tax_jurisdiction_chk');
    expect(def, 'Expected users_tax_jurisdiction_chk in pg_constraint').not.toBeNull();
    for (const value of ['US', 'CA', 'other']) {
      expect(
        def!.includes(`'${value}'`),
        `Expected users_tax_jurisdiction_chk def to contain '${value}'. ` + `Actual:\n  ${def}`,
      ).toBe(true);
    }
  });
});
