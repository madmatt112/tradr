/**
 * ibkr.query.ts against real tradr_test (design C1; Req 1.1, 1.4, 5.6, 5.7,
 * 7.4). Each test runs inside the rolled-back transaction `src/test-setup.ts`
 * wraps every test in.
 *
 * Contract (one bullet per success criterion this file covers):
 *
 * - replaceConnection gives a new id and an empty last-fetch record.
 *   Pre-condition: a connection already exists for an account, with a
 *   recorded fetch on it.
 *   Test: `replaceConnection(tx, row)` for the same account a second time.
 *   Observable result: the returned row's id differs from the first save's
 *   id; lastFetchedAt, lastPeriodStart and lastPeriodEnd are all null.
 *   Source: requirements.md Req 1 AC 4 ("a new save replaces the old values
 *   and clears the last-fetch record"); design D13.
 *
 * - the unique index on account_id refuses a second row for one account.
 *   Pre-condition: a connection row exists for an account.
 *   Test: a direct `db.insert(ibkrFlexConnections)` for the same account_id.
 *   Observable result: the insert rejects.
 *   Source: requirements.md Req 1 AC 4 ("Each Tradr account holds at most
 *   one connection"); design Data Models, unique index on account_id.
 *
 * - recordFetch against a replaced connection's old id is a no-op.
 *   Pre-condition: a connection replaced once, so its first id no longer
 *   names a row.
 *   Test: `recordFetch(db, <old id>, record)`.
 *   Observable result: the surviving (new) row's last-fetch columns stay
 *   null.
 *   Source: design C1 ("a connection replaced or removed during a fetch
 *   keeps its state; the write is a no-op").
 *
 * - recordFetch stores only the fetch time and period span.
 *   Pre-condition: a connection with no last-fetch record.
 *   Test: `recordFetch(db, connectionId, { fetchedAt, periodStart,
 *   periodEnd })`.
 *   Observable result: the row's lastFetchedAt, lastPeriodStart and
 *   lastPeriodEnd equal exactly the given values.
 *   Source: requirements.md Req 7 AC 1 and AC 4 ("the record SHALL hold no
 *   report content").
 *
 * - listConnections returns no ciphertext.
 *   Pre-condition: a connection row holds ciphertext values.
 *   Test: `listConnections(db, userId)`.
 *   Observable result: the returned entry carries accountId and
 *   tokenHintTail but no encrypted* key and neither ciphertext value.
 *   Source: requirements.md Req 1 AC 1 and AC 2.
 *
 * - deleteConnection is scoped by userId.
 *   Pre-condition: a connection belongs to one user.
 *   Test: `deleteConnection(db, <another user's id>, accountId)`.
 *   Observable result: returns 0; the row still exists.
 *   Source: requirements.md Req 5 AC 7 ("A user SHALL NOT read, change or
 *   fetch through another user's connection").
 *
 * - deleting one account removes its connection and leaves the user's other
 *   connection (also proves the independent-storage half of Req 1 AC 4).
 *   Pre-condition: a user holds two accounts, each with its own connection.
 *   Test: `deleteAccount(tx, accountOneId, userId)`.
 *   Observable result: zero connection rows remain for accountOne; the
 *   accountTwo connection is untouched.
 *   Source: requirements.md Req 5 AC 6.
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { db } from '@/db';
import { accounts, ibkrFlexConnections, users } from '@/db/schema';
import { deleteAccount } from '@/features/accounts/accounts.query';

import { deleteConnection, listConnections, recordFetch, replaceConnection } from './ibkr.query';

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `ibkr-q-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning();
  return user!.id;
}

async function seedAccount(userId: string): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ userId, name: 'Acct', currency: 'USD' })
    .returning();
  return account!.id;
}

function connectionRow(
  userId: string,
  accountId: string,
  overrides: Partial<typeof ibkrFlexConnections.$inferInsert> = {},
) {
  return {
    userId,
    accountId,
    encryptedToken: 'enc-token-ciphertext',
    encryptedQueryId: 'enc-query-ciphertext',
    keyVersion: 1,
    tokenHintTail: '1234',
    ...overrides,
  };
}

describe('replaceConnection — delete then insert (design D13, Req 1.4)', () => {
  it('gives a new id and an empty last-fetch record on a second save for the same account', async () => {
    const userId = await seedUser();
    const accountId = await seedAccount(userId);

    const first = await db.transaction((tx) =>
      replaceConnection(tx, connectionRow(userId, accountId)),
    );
    await recordFetch(db, first.id, {
      fetchedAt: new Date('2026-01-15T00:00:00.000Z'),
      periodStart: '2026-01-01',
      periodEnd: '2026-01-10',
    });

    const second = await db.transaction((tx) =>
      replaceConnection(tx, connectionRow(userId, accountId, { tokenHintTail: '5678' })),
    );

    expect(second.id).not.toBe(first.id);
    expect(second.lastFetchedAt).toBeNull();
    expect(second.lastPeriodStart).toBeNull();
    expect(second.lastPeriodEnd).toBeNull();

    const rows = await db
      .select()
      .from(ibkrFlexConnections)
      .where(eq(ibkrFlexConnections.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(second.id);
  });
});

describe('ibkr_flex_connections — unique index on account_id (Req 1.4)', () => {
  it('refuses a second row for the same account inserted directly', async () => {
    const userId = await seedUser();
    const accountId = await seedAccount(userId);
    await db.transaction((tx) => replaceConnection(tx, connectionRow(userId, accountId)));

    await expect(
      db
        .insert(ibkrFlexConnections)
        .values(connectionRow(userId, accountId, { tokenHintTail: '9999' })),
    ).rejects.toThrow();
  });
});

describe('recordFetch — updates by id (design C1)', () => {
  it("is a no-op against a replaced connection's old id, leaving the new row untouched", async () => {
    const userId = await seedUser();
    const accountId = await seedAccount(userId);
    const first = await db.transaction((tx) =>
      replaceConnection(tx, connectionRow(userId, accountId)),
    );
    const second = await db.transaction((tx) =>
      replaceConnection(tx, connectionRow(userId, accountId, { tokenHintTail: '4242' })),
    );

    await recordFetch(db, first.id, {
      fetchedAt: new Date('2026-02-01T00:00:00.000Z'),
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    });

    const rows = await db
      .select()
      .from(ibkrFlexConnections)
      .where(eq(ibkrFlexConnections.id, second.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastFetchedAt).toBeNull();
    expect(rows[0]!.lastPeriodStart).toBeNull();
    expect(rows[0]!.lastPeriodEnd).toBeNull();
  });

  it('records only the fetch time and period span (Req 7.1, 7.4)', async () => {
    const userId = await seedUser();
    const accountId = await seedAccount(userId);
    const connection = await db.transaction((tx) =>
      replaceConnection(tx, connectionRow(userId, accountId)),
    );
    const fetchedAt = new Date('2026-03-01T12:00:00.000Z');

    await recordFetch(db, connection.id, {
      fetchedAt,
      periodStart: '2026-02-01',
      periodEnd: '2026-02-20',
    });

    const [row] = await db
      .select()
      .from(ibkrFlexConnections)
      .where(eq(ibkrFlexConnections.id, connection.id));
    expect(row!.lastFetchedAt?.getTime()).toBe(fetchedAt.getTime());
    expect(row!.lastPeriodStart).toBe('2026-02-01');
    expect(row!.lastPeriodEnd).toBe('2026-02-20');
  });
});

describe('listConnections — masked columns only (Req 1.1, 1.2)', () => {
  it('returns no ciphertext column for a stored connection', async () => {
    const userId = await seedUser();
    const accountId = await seedAccount(userId);
    await db.transaction((tx) =>
      replaceConnection(tx, connectionRow(userId, accountId, { tokenHintTail: '4321' })),
    );

    const [status] = await listConnections(db, userId);

    expect(status).toMatchObject({ accountId, tokenHintTail: '4321' });
    expect(status).not.toHaveProperty('encryptedToken');
    expect(status).not.toHaveProperty('encryptedQueryId');
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('enc-token-ciphertext');
    expect(serialized).not.toContain('enc-query-ciphertext');
  });
});

describe("deleteConnection — scoped by userId (Req 5's cross-user boundary, AC 7)", () => {
  it("returns 0 and leaves the row for another user's account", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const accountId = await seedAccount(owner);
    await db.transaction((tx) => replaceConnection(tx, connectionRow(owner, accountId)));

    const deletedCount = await deleteConnection(db, attacker, accountId);

    expect(deletedCount).toBe(0);
    const rows = await db
      .select()
      .from(ibkrFlexConnections)
      .where(eq(ibkrFlexConnections.accountId, accountId));
    expect(rows).toHaveLength(1);
  });
});

describe('account deletion cascades the connection (Req 5.6, design C12)', () => {
  it("removes the deleted account's connection and leaves the user's other connection", async () => {
    const userId = await seedUser();
    const accountOne = await seedAccount(userId);
    const accountTwo = await seedAccount(userId);
    await db.transaction((tx) => replaceConnection(tx, connectionRow(userId, accountOne)));
    await db.transaction((tx) =>
      replaceConnection(tx, connectionRow(userId, accountTwo, { tokenHintTail: '0000' })),
    );

    await db.transaction((tx) => deleteAccount(tx, accountOne, userId));

    const remaining = await db
      .select()
      .from(ibkrFlexConnections)
      .where(eq(ibkrFlexConnections.userId, userId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.accountId).toBe(accountTwo);
  });
});
