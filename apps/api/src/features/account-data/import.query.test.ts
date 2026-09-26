import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import {
  accounts,
  advisorConversations,
  advisorPersonas,
  brokerages,
  dashboardLayouts,
  exchangeRates,
  expenses,
  externalApiKeys,
  ledgerEntries,
  tags,
  users,
  wallets,
} from '@/db/schema';

import { ImportTargetNotEmptyError } from './account-data.errors';
import {
  assertTargetEmpty,
  findExistingBuiltinPersonaIds,
  findSystemBrokeragesByName,
  insertArchivePositions,
  insertArchiveTags,
  IMPORT_BLOCKING_CATEGORIES,
  type PositionInsert,
  type TagInsert,
} from './import.query';

// Design C6 import query layer, against real tradr_test rolled back by the
// single-connection harness (test-setup.ts). `db` is the per-test transaction.

const TS = '2026-01-02T03:04:05.123456Z';

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `import-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return u.id;
}

async function seedAccount(userId: string): Promise<string> {
  const [a] = await db
    .insert(accounts)
    .values({ userId, name: `acct-${randomUUID()}`, currency: 'USD' })
    .returning({ id: accounts.id });
  return a.id;
}

// A minimal `open` position, seeded through the query layer under test (direct
// `db.insert(positions)` is barred by the positions-service eslint rule).
function minimalPosition(accountId: string): PositionInsert {
  return {
    id: randomUUID(),
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    status: 'open',
    notes: null,
    targetPrice: null,
    stopLoss: null,
    openedAt: TS,
    closedAt: null,
    lastFlatAt: null,
    lastFlatNetPnl: null,
    createdAt: TS,
    updatedAt: TS,
  };
}

// Seed exactly one row in the named blocking category, creating only the FK
// parents that row needs.
async function seedCategory(label: string, userId: string): Promise<void> {
  switch (label) {
    case 'accounts':
      await seedAccount(userId);
      return;
    case 'positions': {
      const accountId = await seedAccount(userId);
      await insertArchivePositions(db, userId, [minimalPosition(accountId)]);
      return;
    }
    case 'ledger entries': {
      const accountId = await seedAccount(userId);
      await db.insert(ledgerEntries).values({
        userId,
        accountId,
        entryType: 'deposit',
        direction: 'credit',
        amount: '100.0000',
        currency: 'USD',
        occurredAt: new Date(),
        groupId: randomUUID(),
      });
      return;
    }
    case 'exchange rates':
      await db.insert(exchangeRates).values({
        userId,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '1.100000000000',
        effectiveDate: '2026-01-01',
      });
      return;
    case 'expenses':
      await db.insert(expenses).values({
        userId,
        category: 'other',
        description: 'x',
        amount: '10.0000',
        currency: 'USD',
        occurredAt: '2026-01-01',
      });
      return;
    case 'brokerages':
      await db.insert(brokerages).values({ userId, name: 'My Broker', isSystem: false });
      return;
    case 'tags':
      await db.insert(tags).values({ userId, name: 'setup-a', category: 'general' });
      return;
    case 'conversations':
      await db
        .insert(advisorConversations)
        .values({ userId, title: 'c', providerId: 'openai', model: 'gpt-4' });
      return;
    case 'personas':
      await db.insert(advisorPersonas).values({
        id: randomUUID(),
        userId,
        name: 'p',
        systemPrompt: 'sp',
        isBuiltin: false,
      });
      return;
    default:
      throw new Error(`unhandled category ${label}`);
  }
}

describe('assertTargetEmpty', () => {
  it('resolves for a user with no data', async () => {
    const userId = await seedUser();
    await expect(assertTargetEmpty(db, userId)).resolves.toBeUndefined();
  });

  it.each(IMPORT_BLOCKING_CATEGORIES.map((c) => c.label))(
    'blocks when only %s holds data',
    async (label) => {
      const userId = await seedUser();
      await seedCategory(label, userId);
      const err = await assertTargetEmpty(db, userId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportTargetNotEmptyError);
      // Some categories need an account parent, which also blocks; the point is
      // that seeding this category names it among the non-empty ones.
      expect((err as ImportTargetNotEmptyError).categories).toContain(label);
    },
  );

  it('does not block on preferences, a layout, an API key or a wallet', async () => {
    const userId = await seedUser();
    await db.update(users).set({ displayCurrency: 'USD' }).where(eq(users.id, userId));
    await db.insert(dashboardLayouts).values({ userId });
    await db.insert(externalApiKeys).values({
      userId,
      provider: 'openai',
      encryptedKey: 'enc',
      keyVersion: 1,
      keyHintTail: 'abcd',
    });
    await db.insert(wallets).values({ userId });
    await expect(assertTargetEmpty(db, userId)).resolves.toBeUndefined();
  });
});

describe('reference lookups', () => {
  it('matches system brokerages by lower(name), never user brokerages', async () => {
    const userId = await seedUser();
    const [sysOne] = await db
      .insert(brokerages)
      .values({ userId: null, name: 'Sys One', isSystem: true })
      .returning({ id: brokerages.id });
    const [sysTwo] = await db
      .insert(brokerages)
      .values({ userId: null, name: 'Sys Two', isSystem: true })
      .returning({ id: brokerages.id });
    // A user brokerage that shares a name must NOT be matched.
    await db.insert(brokerages).values({ userId, name: 'Sys One', isSystem: false });

    const found = await findSystemBrokeragesByName(db, ['sys one', 'SYS TWO', 'Missing']);
    expect(found.size).toBe(2);
    expect(found.get('sys one')).toEqual({ id: sysOne.id, name: 'Sys One' });
    expect(found.get('sys two')).toEqual({ id: sysTwo.id, name: 'Sys Two' });
    expect(found.has('missing')).toBe(false);
  });

  it('reports which builtin persona ids exist on the target', async () => {
    const found = await findExistingBuiltinPersonaIds(db, [
      'default-trading-advisor',
      'risk-coach',
      'not-a-real-persona',
    ]);
    expect(found.has('default-trading-advisor')).toBe(true);
    expect(found.has('risk-coach')).toBe(true);
    expect(found.has('not-a-real-persona')).toBe(false);
  });

  it('returns empty for an empty input list', async () => {
    expect((await findSystemBrokeragesByName(db, [])).size).toBe(0);
    expect((await findExistingBuiltinPersonaIds(db, [])).size).toBe(0);
  });
});

describe('batched text-bind inserts', () => {
  it('round-trips a microsecond timestamp and an 18,8 decimal byte-for-byte', async () => {
    const userId = await seedUser();
    const accountId = await seedAccount(userId);
    const id = randomUUID();
    const row: PositionInsert = {
      id,
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      notes: null,
      targetPrice: '12345.12345678',
      stopLoss: null,
      openedAt: TS,
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
      createdAt: TS,
      updatedAt: TS,
    };
    await insertArchivePositions(db, userId, [row]);

    const read = (await db.execute(sql`
      SELECT to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "openedAt",
             target_price::text AS "targetPrice"
      FROM positions WHERE id = ${id}
    `)) as unknown as Array<{ openedAt: string; targetPrice: string }>;
    expect(read[0].openedAt).toBe(TS);
    expect(read[0].targetPrice).toBe('12345.12345678');
  });

  it('splits a 1,200-row insert into three statements of at most 500 rows', async () => {
    const userId = await seedUser();
    const rows: TagInsert[] = Array.from({ length: 1200 }, (_, i) => ({
      id: randomUUID(),
      name: `imp-${i}`,
      category: 'general',
      color: null,
      createdAt: TS,
      updatedAt: TS,
    }));

    const spy = vi.spyOn(db, 'execute');
    try {
      await insertArchiveTags(db, userId, rows);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }

    const [{ count }] = (await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM tags WHERE user_id = ${userId}`,
    )) as unknown as Array<{ count: number }>;
    expect(count).toBe(1200);
  });
});
