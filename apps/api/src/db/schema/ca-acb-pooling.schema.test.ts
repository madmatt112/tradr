/**
 * ca-acb-pooling task 1 — schema and migration-level tests for the
 * `accounts.tax_treatment` column and the new `fill_transfer_links` table
 * (design C1, C7, Data Models; AC 1.1, 1.2, 6.4).
 *
 * Runs against the real test database via `src/test-setup.ts` (migrations
 * already applied in beforeAll; each test wrapped in a rolled-back
 * transaction). The DB is NOT mocked. `fill_transfer_links` is reached
 * through raw SQL rather than the Drizzle schema barrel, so this file does
 * not depend on the as-yet-unbuilt schema export's exact shape.
 *
 * Contract:
 *  1. accounts.tax_treatment rejects NULL (AC 1.1 — NOT NULL).
 *     Pre: a bare user row. Call: raw INSERT with tax_treatment = NULL.
 *     Observe: rejects with a not-null-constraint error.
 *     Source: design Data Models — "tax_treatment varchar(10) NOT NULL".
 *  2. accounts_tax_treatment_chk rejects a value outside taxable/registered
 *     (AC 1.1). Pre: a bare user row. Call: raw INSERT with
 *     tax_treatment = 'bogus'. Observe: rejects with a CHECK-violation error
 *     naming accounts_tax_treatment_chk.
 *     Source: design Data Models — "CHECK accounts_tax_treatment_chk:
 *     tax_treatment IN ('taxable', 'registered')".
 *  3. an account inserted with no tax_treatment given reads back 'taxable'
 *     (AC 1.2 — every existing account gets taxable from the column
 *     default). Pre: a bare user row. Call: typed db.insert(accounts) with
 *     no tax_treatment field. Observe: the stored row's tax_treatment is
 *     'taxable'.
 *     Source: design Data Models — "DEFAULT 'taxable'"; AC 1.2.
 *  4. an account can be stored as 'registered' (AC 1.1 — "taxable OR
 *     registered"). Pre: a bare user row. Call: raw INSERT with
 *     tax_treatment = 'registered'. Observe: the stored row reads back
 *     'registered'.
 *     Source: requirements AC 1.1.
 *  5. migration 0040 contains no INSERT, UPDATE or DELETE statement (AC 1.2
 *     — "with no other row changed"; the Restrictions line: "no backfill
 *     statement"). Pre: none. Call: read the migration file's text.
 *     Observe: no INSERT/UPDATE/DELETE keyword. Source: task 1 Restrictions.
 *  6. fill_transfer_links_distinct_fills_chk rejects a link whose exit and
 *     entry fill ids are equal (task 1 Success: "a link row whose two fill
 *     ids are equal is refused by the CHECK"). Pre: one exit fill. Call: raw
 *     INSERT with exit_fill_id = entry_fill_id. Observe: rejects with a
 *     CHECK-violation error naming fill_transfer_links_distinct_fills_chk.
 *     Source: design Data Models.
 *  7. fill_transfer_links_exit_unique rejects a second link reusing the same
 *     exit fill id (task 1 Success: "a second link on the same exit fill …
 *     is refused by its unique index"). Pre: one stored link. Call: raw
 *     INSERT reusing its exit_fill_id with a different entry_fill_id.
 *     Observe: rejects with a unique-violation error naming
 *     fill_transfer_links_exit_unique. Source: design Data Models.
 *  8. fill_transfer_links_entry_unique rejects a second link reusing the
 *     same entry fill id (task 1 Success, mirrored on the entry side).
 *     Source: design Data Models.
 *  9. deleting the exit fill removes its fill_transfer_links row (AC 6.4 —
 *     "WHEN either fill or its position is removed THEN the link SHALL be
 *     removed with it"). Pre: one stored link. Call: db.delete(fills) on
 *     the exit fill. Observe: no fill_transfer_links row with that
 *     exit_fill_id remains. Source: design Data Models — exit_fill_id FK
 *     ON DELETE CASCADE.
 * 10. deleting the entry fill removes its fill_transfer_links row (AC 6.4,
 *     mirrored on the entry side). Source: design Data Models — entry_fill_id
 *     FK ON DELETE CASCADE.
 *
 * AC 9.4 (table-inventory classification) and AC 9.5 (erasure on account
 * deletion) are regression guards, not red tests here — see the
 * sdd-test-author report for task 1.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { db } from '@/db';
import { accounts, positions, fills, users } from '@/db/schema';

import { MIGRATIONS_DIR } from '../migrate';

let counter = 0;

async function seedUser(): Promise<{ id: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `ca-acb-schema-${Date.now()}-${++counter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return { id: user!.id };
}

async function seedTransferLinkFixture(): Promise<{
  userId: string;
  exitFillId: string;
  entryFillId: string;
}> {
  const user = await seedUser();
  const [account] = await db
    .insert(accounts)
    .values({
      userId: user.id,
      name: `ca-acb-acct-${Date.now()}-${++counter}`,
      currency: 'USD',
    })
    .returning();
  // Fixture — direct insert so no close hook or service invariant fires.
  // eslint-disable-next-line no-restricted-syntax
  const [position] = await db
    .insert(positions)
    .values({
      userId: user.id,
      accountId: account!.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    })
    .returning();
  const [exitFill] = await db
    .insert(fills)
    .values({
      positionId: position!.id,
      type: 'exit',
      price: '10',
      quantity: '1',
      filledAt: new Date(),
    })
    .returning();
  const [entryFill] = await db
    .insert(fills)
    .values({
      positionId: position!.id,
      type: 'entry',
      price: '10',
      quantity: '1',
      filledAt: new Date(),
    })
    .returning();
  return { userId: user.id, exitFillId: exitFill!.id, entryFillId: entryFill!.id };
}

describe('accounts.tax_treatment (design C1, Data Models)', () => {
  it('case 1: NULL tax_treatment is rejected (AC 1.1 — NOT NULL)', async () => {
    const user = await seedUser();
    await expect(
      db.execute(sql`
        INSERT INTO accounts (user_id, name, currency, tax_treatment)
        VALUES (${user.id}, ${`nn-acct-${Date.now()}-${++counter}`}, 'USD', NULL)
      `),
    ).rejects.toThrow(/null value in column "tax_treatment"|not-null constraint/i);
  });

  it('case 2: a value outside taxable/registered is rejected (accounts_tax_treatment_chk, AC 1.1)', async () => {
    const user = await seedUser();
    await expect(
      db.execute(sql`
        INSERT INTO accounts (user_id, name, currency, tax_treatment)
        VALUES (${user.id}, ${`chk-acct-${Date.now()}-${++counter}`}, 'USD', 'bogus')
      `),
    ).rejects.toThrow(/accounts_tax_treatment_chk|check constraint/i);
  });

  it('case 3: omitting tax_treatment on insert reads back taxable (AC 1.2)', async () => {
    const user = await seedUser();
    const [account] = await db
      .insert(accounts)
      .values({
        userId: user.id,
        name: `default-acct-${Date.now()}-${++counter}`,
        currency: 'USD',
      })
      .returning();
    const rows = await db.execute<{ tax_treatment: string }>(sql`
      SELECT tax_treatment FROM accounts WHERE id = ${account!.id}
    `);
    expect(rows[0]?.tax_treatment).toBe('taxable');
  });

  it('case 4: a registered account reads back registered (AC 1.1)', async () => {
    const user = await seedUser();
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO accounts (user_id, name, currency, tax_treatment)
      VALUES (${user.id}, ${`reg-acct-${Date.now()}-${++counter}`}, 'USD', 'registered')
      RETURNING id
    `);
    const rows = await db.execute<{ tax_treatment: string }>(sql`
      SELECT tax_treatment FROM accounts WHERE id = ${row!.id}
    `);
    expect(rows[0]?.tax_treatment).toBe('registered');
  });
});

describe('migration 0040 — no row rewrites (AC 1.2)', () => {
  it('contains no INSERT, UPDATE or DELETE statement', () => {
    const migrationPath = join(MIGRATIONS_DIR, '0040_ca_acb_pooling.sql');
    const migrationSql = readFileSync(migrationPath, 'utf8');
    expect(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i.test(migrationSql),
      `Expected ${migrationPath} to contain no INSERT, UPDATE or DELETE statement ` +
        `(no backfill — the column default alone gives every existing account taxable). ` +
        `Actual contents:\n` +
        migrationSql,
    ).toBe(false);
  });
});

describe('fill_transfer_links (design C7, Data Models)', () => {
  it('case 1: a link whose exit and entry fill ids are equal is rejected (fill_transfer_links_distinct_fills_chk)', async () => {
    const { userId, exitFillId } = await seedTransferLinkFixture();
    await expect(
      db.execute(sql`
        INSERT INTO fill_transfer_links (user_id, exit_fill_id, entry_fill_id)
        VALUES (${userId}, ${exitFillId}, ${exitFillId})
      `),
    ).rejects.toThrow(/fill_transfer_links_distinct_fills_chk|check constraint/i);
  });

  it('case 2: a second link reusing the same exit fill id is rejected (fill_transfer_links_exit_unique)', async () => {
    const { userId, exitFillId, entryFillId } = await seedTransferLinkFixture();
    const other = await seedTransferLinkFixture();
    await db.execute(sql`
      INSERT INTO fill_transfer_links (user_id, exit_fill_id, entry_fill_id)
      VALUES (${userId}, ${exitFillId}, ${entryFillId})
    `);
    await expect(
      db.execute(sql`
        INSERT INTO fill_transfer_links (user_id, exit_fill_id, entry_fill_id)
        VALUES (${userId}, ${exitFillId}, ${other.entryFillId})
      `),
    ).rejects.toThrow(/fill_transfer_links_exit_unique|unique constraint/i);
  });

  it('case 3: a second link reusing the same entry fill id is rejected (fill_transfer_links_entry_unique)', async () => {
    const { userId, exitFillId, entryFillId } = await seedTransferLinkFixture();
    const other = await seedTransferLinkFixture();
    await db.execute(sql`
      INSERT INTO fill_transfer_links (user_id, exit_fill_id, entry_fill_id)
      VALUES (${userId}, ${exitFillId}, ${entryFillId})
    `);
    await expect(
      db.execute(sql`
        INSERT INTO fill_transfer_links (user_id, exit_fill_id, entry_fill_id)
        VALUES (${userId}, ${other.exitFillId}, ${entryFillId})
      `),
    ).rejects.toThrow(/fill_transfer_links_entry_unique|unique constraint/i);
  });

  it('case 4: deleting the exit fill removes its link row (AC 6.4)', async () => {
    const { userId, exitFillId, entryFillId } = await seedTransferLinkFixture();
    await db.execute(sql`
      INSERT INTO fill_transfer_links (user_id, exit_fill_id, entry_fill_id)
      VALUES (${userId}, ${exitFillId}, ${entryFillId})
    `);
    await db.delete(fills).where(sql`${fills.id} = ${exitFillId}`);
    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM fill_transfer_links WHERE exit_fill_id = ${exitFillId}
    `);
    expect(rows).toHaveLength(0);
  });

  it('case 5: deleting the entry fill removes its link row (AC 6.4)', async () => {
    const { userId, exitFillId, entryFillId } = await seedTransferLinkFixture();
    await db.execute(sql`
      INSERT INTO fill_transfer_links (user_id, exit_fill_id, entry_fill_id)
      VALUES (${userId}, ${exitFillId}, ${entryFillId})
    `);
    await db.delete(fills).where(sql`${fills.id} = ${entryFillId}`);
    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM fill_transfer_links WHERE entry_fill_id = ${entryFillId}
    `);
    expect(rows).toHaveLength(0);
  });
});
