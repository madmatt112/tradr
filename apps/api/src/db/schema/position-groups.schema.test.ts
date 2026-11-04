/**
 * multi-leg-positions task 1 — schema and migration-level tests for the
 * `position_groups` table and `positions.group_id` (design C1, Data Models;
 * AC 1.7, 9.5).
 *
 * Runs against the real test database via `src/test-setup.ts` (migrations
 * already applied in beforeAll; each test wrapped in a rolled-back
 * transaction). The DB is NOT mocked. `position_groups` and
 * `positions.group_id` are reached through raw SQL rather than the Drizzle
 * schema barrel, so this file does not depend on the as-yet-unbuilt schema
 * export's exact shape.
 *
 * Contract:
 *  1. An existing (ungrouped) position reads back a null group_id (AC 1.7 —
 *     "a position belongs to no group ... its lifecycle, figures and fills
 *     SHALL behave as today"). Pre: a bare user, account and position,
 *     inserted with no group reference. Call: raw SELECT group_id FROM
 *     positions for that row. Observe: group_id is null.
 *     Source: design Data Models — "positions.group_id: uuid null".
 *  2. Migration 0042_position_groups.sql contains no INSERT, UPDATE or
 *     DELETE statement (AC 1.7 — "no migration SHALL rewrite positions,
 *     fills or ledger_entries rows"). Pre: none. Call: read the migration
 *     file's text. Observe: no INSERT/UPDATE/DELETE keyword.
 *     Source: design C1 — "updates no row".
 *  3. Deleting a position_groups row sets its leg's group_id to null and
 *     leaves the leg — the position row and its fill both still exist (AC
 *     1.7's "behave as today" once a leg is ungrouped again). Pre: a user,
 *     account, position with one fill, and a position_groups row the
 *     position's group_id points at. Call: raw DELETE FROM position_groups
 *     for that group id. Observe: the position row still exists with a null
 *     group_id, and its fill row still exists.
 *     Source: design Data Models — "positions.group_id: ... references
 *     position_groups, set null".
 *  4. Deleting the user removes their position_groups row through the
 *     cascade (AC 9.5 — "WHEN a user deletes their account THEN their
 *     groups SHALL be deleted with it"). Pre: a user and a position_groups
 *     row referencing it. Call: db.delete(users) for that user. Observe: no
 *     position_groups row with that user_id remains.
 *     Source: design Data Models — "position_groups { user_id: ... cascade }".
 *
 * AC 9.4 (table-inventory classification) is a regression guard, not a red
 * test here: `table-inventory.test.ts` walks the schema barrel dynamically
 * and already passes at base (lines 18-19, 44-46 assert exactly-one-list
 * membership and count parity for every barrel table). Once `position_groups`
 * is added to the schema and to `EXPORTED_TABLES` in the same change, those
 * assertions keep passing; omitting the classification would turn them red.
 * See the sdd-test-author report for task 1.
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
      email: `mlp-schema-${Date.now()}-${++counter}@example.com`,
      passwordHash: 'x'.repeat(60),
    })
    .returning();
  return { id: user!.id };
}

async function seedAccount(userId: string): Promise<{ id: string }> {
  const [account] = await db
    .insert(accounts)
    .values({
      userId,
      name: `mlp-acct-${Date.now()}-${++counter}`,
      currency: 'USD',
    })
    .returning();
  return { id: account!.id };
}

async function seedPositionWithFill(
  userId: string,
  accountId: string,
): Promise<{ id: string; fillId: string }> {
  // Fixture — direct insert so no close hook or service invariant fires.
  // eslint-disable-next-line no-restricted-syntax
  const [position] = await db
    .insert(positions)
    .values({
      userId,
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    })
    .returning();
  const [fill] = await db
    .insert(fills)
    .values({
      positionId: position!.id,
      type: 'entry',
      price: '10',
      quantity: '1',
      filledAt: new Date(),
    })
    .returning();
  return { id: position!.id, fillId: fill!.id };
}

describe('position_groups and positions.group_id (design C1, Data Models)', () => {
  it('case 1: an ungrouped position reads back a null group_id (AC 1.7)', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const { id: positionId } = await seedPositionWithFill(user.id, account.id);

    const rows = await db.execute<{ group_id: string | null }>(sql`
      SELECT group_id FROM positions WHERE id = ${positionId}
    `);
    expect(rows[0]?.group_id ?? null).toBeNull();
  });

  it('case 2: deleting a group sets its leg group_id to null and leaves the leg (AC 1.7)', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const { id: positionId, fillId } = await seedPositionWithFill(user.id, account.id);

    const [group] = await db.execute<{ id: string }>(sql`
      INSERT INTO position_groups (user_id)
      VALUES (${user.id})
      RETURNING id
    `);
    await db.execute(sql`
      UPDATE positions SET group_id = ${group!.id} WHERE id = ${positionId}
    `);

    await db.execute(sql`
      DELETE FROM position_groups WHERE id = ${group!.id}
    `);

    const positionRows = await db.execute<{ id: string; group_id: string | null }>(sql`
      SELECT id, group_id FROM positions WHERE id = ${positionId}
    `);
    expect(positionRows).toHaveLength(1);
    expect(positionRows[0]?.group_id ?? null).toBeNull();

    const fillRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM fills WHERE id = ${fillId}
    `);
    expect(fillRows).toHaveLength(1);
  });

  it('case 3: deleting the user removes their position_groups row (cascade, AC 9.5)', async () => {
    const user = await seedUser();
    const [group] = await db.execute<{ id: string }>(sql`
      INSERT INTO position_groups (user_id)
      VALUES (${user.id})
      RETURNING id
    `);

    await db.delete(users).where(sql`${users.id} = ${user.id}`);

    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM position_groups WHERE id = ${group!.id}
    `);
    expect(rows).toHaveLength(0);
  });
});

describe('migration 0042 — no row rewrites (AC 1.7)', () => {
  it('contains no INSERT, UPDATE or DELETE statement', () => {
    const migrationPath = join(MIGRATIONS_DIR, '0042_position_groups.sql');
    const migrationSql = readFileSync(migrationPath, 'utf8');
    expect(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i.test(migrationSql),
      `Expected ${migrationPath} to contain no INSERT, UPDATE or DELETE statement ` +
        `(no backfill — the new column is nullable with no default). ` +
        `Actual contents:\n` +
        migrationSql,
    ).toBe(false);
  });
});
