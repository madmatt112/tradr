/**
 * option-lifecycle-events task 2 — schema and migration-level tests for the
 * five lifecycle tables (`option_settlements`, `option_settlement_rows`,
 * `option_settlement_fills`, `position_rolls`, `position_entry_greeks`;
 * design Data Models; Req 2.9, 11.4).
 *
 * Runs against the real test database via `src/test-setup.ts` (migrations
 * already applied in beforeAll; each test wrapped in a rolled-back
 * transaction). The DB is NOT mocked. Every table here is reached through
 * raw SQL rather than the Drizzle schema barrel, so this file does not
 * depend on the as-yet-unbuilt schema export's exact shape (same pattern as
 * `position-groups.schema.test.ts` and `ca-acb-pooling.schema.test.ts`).
 *
 * Contract:
 *  1. Migration 0043_option_lifecycle.sql contains no UPDATE or DELETE
 *     statement (task 2 Success — "the 0043 SQL holds no UPDATE or DELETE
 *     statement"). Pre: none. Call: read the migration file's text.
 *     Observe: no UPDATE/DELETE keyword.
 *     Source: task 2 _Prompt Success.
 *  2. Deleting a touched stock row sets option_settlement_rows.position_id
 *     to null and keeps the settlement (task 2 Success; Req 4.7). Pre: a
 *     leg position with a settlement, a stock position, and a settlement
 *     row touching that stock position. Call: db.delete(positions) for the
 *     stock position. Observe: the settlement row still exists with a null
 *     position_id, and the parent option_settlements row still exists.
 *     Source: design Data Models — "option_settlement_rows ... position_id
 *     uuid NULL -> positions SET NULL" and "SET NULL is deliberate: ...
 *     must leave the record standing so unsettle refuses (Req 4.7)".
 *  3. Deleting a recorded fill sets option_settlement_fills.fill_id to null
 *     and keeps the settlement (task 2 Success; Req 4.7). Pre: a leg
 *     position with a fill and a settlement, and a settlement-fill row
 *     recording that fill. Call: db.delete(fills) for the fill. Observe:
 *     the settlement-fill row still exists with a null fill_id, and the
 *     parent option_settlements row still exists.
 *     Source: design Data Models — "option_settlement_fills ... fill_id
 *     uuid NULL -> fills SET NULL".
 *  4. Deleting the leg removes its settlement and children (task 2
 *     Success). Pre: a leg position with a settlement, a settlement row
 *     and a settlement-fill row both belonging to it. Call:
 *     db.delete(positions) for the leg. Observe: the option_settlements
 *     row, its option_settlement_rows row and its option_settlement_fills
 *     row are all gone.
 *     Source: design Data Models — "option_settlements ... position_id ->
 *     positions CASCADE"; "Deleting the leg removes the record."; rows and
 *     fills cascade transitively via settlement_id CASCADE.
 *  5. Deleting a position removes its position_rolls and
 *     position_entry_greeks rows (task 2 Success). Pre: one position that
 *     is both a roll's from_position_id and the subject of an
 *     entry-greeks row. Call: db.delete(positions) for that position.
 *     Observe: the position_rolls row and the position_entry_greeks row
 *     are both gone.
 *     Source: design Data Models — "position_rolls ... from_position_id,
 *     to_position_id -> positions CASCADE"; "position_entry_greeks ...
 *     position_id pk -> positions CASCADE".
 *  6. Deleting the user removes rows in all five tables through the
 *     cascades (task 2 Success; Req 11.4 — "Deleting a user or account
 *     SHALL remove these records"). Pre: one user with a settlement, a
 *     settlement row, a settlement fill, a roll and an entry-greeks row,
 *     all reachable from that user. Call: db.delete(users) for that user.
 *     Observe: no row in any of the five tables remains for that user's
 *     data.
 *     Source: design Data Models — "Req 11.4 follows from the cascades:
 *     position_entry_greeks carries no user_id but still cascades via
 *     position_id."; requirements Req 11.4.
 *  7. option_settlements_outcome_chk (or equivalent) rejects an outcome
 *     outside worthless/assigned/exercised (task 2 Success — "the outcome
 *     ... checks refuse an unknown value"). Pre: a leg position. Call: raw
 *     INSERT into option_settlements with outcome = 'bogus'. Observe:
 *     rejects with a CHECK-violation error.
 *     Source: design Data Models — "outcome varchar(9), CHECK
 *     worthless|assigned|exercised".
 *  8. The touch check rejects a value outside leg/stock_exit/stock_opened
 *     (task 2 Success — "the ... touch ... checks refuse an unknown
 *     value"). Pre: a settlement. Call: raw INSERT into
 *     option_settlement_rows with touch = 'bogus'. Observe: rejects with a
 *     CHECK-violation error.
 *     Source: design Data Models — "touch varchar(12), CHECK
 *     leg|stock_exit|stock_opened".
 *  9. The source check rejects a value outside black_scholes/chain (task 2
 *     Success — "the ... source checks refuse an unknown value"). Pre: a
 *     position. Call: raw INSERT into position_entry_greeks with source =
 *     'bogus'. Observe: rejects with a CHECK-violation error.
 *     Source: design Data Models — "source varchar(13), CHECK
 *     black_scholes|chain".
 * 10. A second roll naming the same to_position_id is refused (task 2
 *     Success — "a second roll naming the same to_position_id is
 *     refused"). Pre: one stored roll. Call: raw INSERT into
 *     position_rolls reusing its to_position_id with a different
 *     from_position_id. Observe: rejects with a unique-violation error.
 *     Source: design Data Models — "position_rolls ... unique
 *     (to_position_id)".
 *
 * "The migration applies on a fresh database" (task 2 Success) is not an
 * independent case: every test above already depends on it, since
 * `src/test-setup.ts` applies every migration in `beforeAll` before any
 * test body runs — if 0043 failed to apply, every case here would error
 * rather than assert. "Account teardown reaches them through its position
 * deletes" (Req 11.4) is covered by case 4 and case 5 above: account
 * teardown's own mechanism is deleting positions, and the position-delete
 * cascade is identical however it is triggered; no separate case is added
 * for it.
 *
 * Req 2.4 (table-inventory classification, AC 9.4 in the archive spec) is
 * a regression guard, not a red test here:
 * `apps/api/src/features/account-data/table-inventory.test.ts` walks the
 * schema barrel dynamically and already passes at base, since none of the
 * five tables exist in the barrel yet. Once they are added to the schema
 * and to `EXPORTED_TABLES` in the same change those assertions keep
 * passing; omitting the classification would turn them red. Flag for the
 * implementer brief.
 *
 * `apps/api/src/app.self-host-parity.test.ts` is likewise a regression
 * guard: it enforces that no hosted-only capability becomes unconditional,
 * and this task gates nothing behind `is*Configured()`, so it stays green
 * and is not a red test here.
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
      email: `ole-schema-${Date.now()}-${++counter}@example.com`,
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
      name: `ole-acct-${Date.now()}-${++counter}`,
      currency: 'USD',
    })
    .returning();
  return { id: account!.id };
}

async function seedPosition(
  userId: string,
  accountId: string,
  side: 'long' | 'short',
  assetType: 'option' | 'stock',
): Promise<{ id: string }> {
  // Fixture — direct insert so no close hook or service invariant fires.
  // eslint-disable-next-line no-restricted-syntax
  const [position] = await db
    .insert(positions)
    .values({
      userId,
      accountId,
      symbol: assetType === 'option' ? 'AAPL_C' : 'AAPL',
      side,
      assetType,
    })
    .returning();
  return { id: position!.id };
}

async function seedFill(positionId: string, type: 'entry' | 'exit'): Promise<{ id: string }> {
  const [fill] = await db
    .insert(fills)
    .values({
      positionId,
      type,
      price: '1',
      quantity: '1',
      filledAt: new Date(),
    })
    .returning();
  return { id: fill!.id };
}

describe('option_settlements, option_settlement_rows, option_settlement_fills (design Data Models, Req 2.9)', () => {
  it('case 2: deleting a touched stock row nulls option_settlement_rows.position_id and keeps the settlement (Req 4.7)', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const leg = await seedPosition(user.id, account.id, 'short', 'option');
    const stockRow = await seedPosition(user.id, account.id, 'long', 'stock');

    const [settlement] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlements (user_id, position_id, outcome, quantity, premium, settled_at)
      VALUES (${user.id}, ${leg.id}, 'assigned', '1', '0', NOW())
      RETURNING id
    `);
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlement_rows (settlement_id, position_id, touch, closed_row)
      VALUES (${settlement!.id}, ${stockRow.id}, 'stock_opened', false)
      RETURNING id
    `);

    await db.delete(positions).where(sql`${positions.id} = ${stockRow.id}`);

    const rowRows = await db.execute<{ id: string; position_id: string | null }>(sql`
      SELECT id, position_id FROM option_settlement_rows WHERE id = ${row!.id}
    `);
    expect(rowRows).toHaveLength(1);
    expect(rowRows[0]?.position_id ?? null).toBeNull();

    const settlementRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlements WHERE id = ${settlement!.id}
    `);
    expect(settlementRows).toHaveLength(1);
  });

  it('case 3: deleting a recorded fill nulls option_settlement_fills.fill_id and keeps the settlement (Req 4.7)', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const leg = await seedPosition(user.id, account.id, 'short', 'option');
    const legFill = await seedFill(leg.id, 'exit');

    const [settlement] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlements (user_id, position_id, outcome, quantity, premium, settled_at)
      VALUES (${user.id}, ${leg.id}, 'worthless', '1', '0', NOW())
      RETURNING id
    `);
    const [settlementFill] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlement_fills (settlement_id, fill_id, written)
      VALUES (${settlement!.id}, ${legFill.id}, true)
      RETURNING id
    `);

    await db.delete(fills).where(sql`${fills.id} = ${legFill.id}`);

    const settlementFillRows = await db.execute<{ id: string; fill_id: string | null }>(sql`
      SELECT id, fill_id FROM option_settlement_fills WHERE id = ${settlementFill!.id}
    `);
    expect(settlementFillRows).toHaveLength(1);
    expect(settlementFillRows[0]?.fill_id ?? null).toBeNull();

    const settlementRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlements WHERE id = ${settlement!.id}
    `);
    expect(settlementRows).toHaveLength(1);
  });

  it('case 4: deleting the leg removes its settlement and children', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const leg = await seedPosition(user.id, account.id, 'short', 'option');

    const [settlement] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlements (user_id, position_id, outcome, quantity, premium, settled_at)
      VALUES (${user.id}, ${leg.id}, 'exercised', '1', '0', NOW())
      RETURNING id
    `);
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlement_rows (settlement_id, position_id, touch, closed_row)
      VALUES (${settlement!.id}, NULL, 'leg', true)
      RETURNING id
    `);
    const [settlementFill] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlement_fills (settlement_id, fill_id, written)
      VALUES (${settlement!.id}, NULL, false)
      RETURNING id
    `);

    await db.delete(positions).where(sql`${positions.id} = ${leg.id}`);

    const settlementRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlements WHERE id = ${settlement!.id}
    `);
    expect(settlementRows).toHaveLength(0);

    const rowRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlement_rows WHERE id = ${row!.id}
    `);
    expect(rowRows).toHaveLength(0);

    const fillRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlement_fills WHERE id = ${settlementFill!.id}
    `);
    expect(fillRows).toHaveLength(0);
  });

  it('case 7: an unknown outcome is rejected by the outcome CHECK', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const leg = await seedPosition(user.id, account.id, 'short', 'option');

    await expect(
      db.execute(sql`
        INSERT INTO option_settlements (user_id, position_id, outcome, quantity, premium, settled_at)
        VALUES (${user.id}, ${leg.id}, 'bogus', '1', '0', NOW())
      `),
    ).rejects.toThrow(/check constraint/i);
  });

  it('case 8: an unknown touch value is rejected by the touch CHECK', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const leg = await seedPosition(user.id, account.id, 'short', 'option');
    const [settlement] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlements (user_id, position_id, outcome, quantity, premium, settled_at)
      VALUES (${user.id}, ${leg.id}, 'worthless', '1', '0', NOW())
      RETURNING id
    `);

    await expect(
      db.execute(sql`
        INSERT INTO option_settlement_rows (settlement_id, position_id, touch, closed_row)
        VALUES (${settlement!.id}, NULL, 'bogus', false)
      `),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe('position_rolls and position_entry_greeks (design Data Models, Req 2.9)', () => {
  it('case 5: deleting a position removes its position_rolls and position_entry_greeks rows', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const fromLeg = await seedPosition(user.id, account.id, 'short', 'option');
    const toLeg = await seedPosition(user.id, account.id, 'short', 'option');
    const exitFill = await seedFill(fromLeg.id, 'exit');
    const entryFill = await seedFill(toLeg.id, 'entry');
    const chainId = crypto.randomUUID();

    const [roll] = await db.execute<{ id: string }>(sql`
      INSERT INTO position_rolls (user_id, chain_id, from_position_id, to_position_id, exit_fill_id, entry_fill_id, rolled_at)
      VALUES (${user.id}, ${chainId}, ${fromLeg.id}, ${toLeg.id}, ${exitFill.id}, ${entryFill.id}, NOW())
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO position_entry_greeks (position_id, delta, gamma, theta_per_day, vega_per_pct, source, captured_at)
      VALUES (${fromLeg.id}, '0.5', '0.1', '-0.02', '0.12', 'black_scholes', NOW())
    `);

    await db.delete(positions).where(sql`${positions.id} = ${fromLeg.id}`);

    const rollRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM position_rolls WHERE id = ${roll!.id}
    `);
    expect(rollRows).toHaveLength(0);

    const greeksRows = await db.execute<{ position_id: string }>(sql`
      SELECT position_id FROM position_entry_greeks WHERE position_id = ${fromLeg.id}
    `);
    expect(greeksRows).toHaveLength(0);
  });

  it('case 9: an unknown source value is rejected by the source CHECK', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const leg = await seedPosition(user.id, account.id, 'short', 'option');

    await expect(
      db.execute(sql`
        INSERT INTO position_entry_greeks (position_id, delta, gamma, theta_per_day, vega_per_pct, source, captured_at)
        VALUES (${leg.id}, '0.5', '0.1', '-0.02', '0.12', 'bogus', NOW())
      `),
    ).rejects.toThrow(/check constraint/i);
  });

  it('case 10: a second roll naming the same to_position_id is rejected (unique to_position_id)', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const fromLegA = await seedPosition(user.id, account.id, 'short', 'option');
    const fromLegB = await seedPosition(user.id, account.id, 'short', 'option');
    const toLeg = await seedPosition(user.id, account.id, 'short', 'option');
    const exitFillA = await seedFill(fromLegA.id, 'exit');
    const exitFillB = await seedFill(fromLegB.id, 'exit');
    const entryFill = await seedFill(toLeg.id, 'entry');

    await db.execute(sql`
      INSERT INTO position_rolls (user_id, chain_id, from_position_id, to_position_id, exit_fill_id, entry_fill_id, rolled_at)
      VALUES (${user.id}, ${crypto.randomUUID()}, ${fromLegA.id}, ${toLeg.id}, ${exitFillA.id}, ${entryFill.id}, NOW())
    `);

    await expect(
      db.execute(sql`
        INSERT INTO position_rolls (user_id, chain_id, from_position_id, to_position_id, exit_fill_id, entry_fill_id, rolled_at)
        VALUES (${user.id}, ${crypto.randomUUID()}, ${fromLegB.id}, ${toLeg.id}, ${exitFillB.id}, ${entryFill.id}, NOW())
      `),
    ).rejects.toThrow(/unique constraint/i);
  });
});

describe('user deletion cascades through all five tables (Req 11.4)', () => {
  it('case 6: deleting the user removes every row reachable from the five tables', async () => {
    const user = await seedUser();
    const account = await seedAccount(user.id);
    const leg = await seedPosition(user.id, account.id, 'short', 'option');
    const stockRow = await seedPosition(user.id, account.id, 'long', 'stock');
    const legFill = await seedFill(leg.id, 'exit');
    const fromLeg = await seedPosition(user.id, account.id, 'short', 'option');
    const toLeg = await seedPosition(user.id, account.id, 'short', 'option');
    const exitFill = await seedFill(fromLeg.id, 'exit');
    const entryFill = await seedFill(toLeg.id, 'entry');

    const [settlement] = await db.execute<{ id: string }>(sql`
      INSERT INTO option_settlements (user_id, position_id, outcome, quantity, premium, settled_at)
      VALUES (${user.id}, ${leg.id}, 'assigned', '1', '0', NOW())
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO option_settlement_rows (settlement_id, position_id, touch, closed_row)
      VALUES (${settlement!.id}, ${stockRow.id}, 'stock_opened', false)
    `);
    await db.execute(sql`
      INSERT INTO option_settlement_fills (settlement_id, fill_id, written)
      VALUES (${settlement!.id}, ${legFill.id}, true)
    `);
    await db.execute(sql`
      INSERT INTO position_rolls (user_id, chain_id, from_position_id, to_position_id, exit_fill_id, entry_fill_id, rolled_at)
      VALUES (${user.id}, ${crypto.randomUUID()}, ${fromLeg.id}, ${toLeg.id}, ${exitFill.id}, ${entryFill.id}, NOW())
    `);
    await db.execute(sql`
      INSERT INTO position_entry_greeks (position_id, delta, gamma, theta_per_day, vega_per_pct, source, captured_at)
      VALUES (${leg.id}, '0.5', '0.1', '-0.02', '0.12', 'black_scholes', NOW())
    `);

    await db.delete(users).where(sql`${users.id} = ${user.id}`);

    const settlementRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlements WHERE user_id = ${user.id}
    `);
    expect(settlementRows).toHaveLength(0);

    const rowRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlement_rows WHERE settlement_id = ${settlement!.id}
    `);
    expect(rowRows).toHaveLength(0);

    const fillRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM option_settlement_fills WHERE settlement_id = ${settlement!.id}
    `);
    expect(fillRows).toHaveLength(0);

    const rollRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM position_rolls WHERE user_id = ${user.id}
    `);
    expect(rollRows).toHaveLength(0);

    const greeksRows = await db.execute<{ position_id: string }>(sql`
      SELECT position_id FROM position_entry_greeks WHERE position_id = ${leg.id}
    `);
    expect(greeksRows).toHaveLength(0);
  });
});

describe('migration 0043 — no UPDATE or DELETE statement (task 2 Success)', () => {
  it('contains no UPDATE or DELETE statement', () => {
    const migrationPath = join(MIGRATIONS_DIR, '0043_option_lifecycle.sql');
    const migrationSql = readFileSync(migrationPath, 'utf8');
    expect(
      /\b(UPDATE\s+"|DELETE\s+FROM)\b/i.test(migrationSql),
      `Expected ${migrationPath} to contain no UPDATE or DELETE statement ` +
        `(additive migration, no backfill). Actual contents:\n` +
        migrationSql,
    ).toBe(false);
  });
});
