import { createHash, randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db';
import {
  accountDeletions,
  accountDeletionSchedules,
  accounts,
  adminAuditLog,
  advisorConversations,
  advisorImageCounters,
  advisorMessages,
  advisorPersonas,
  advisorProviderKeys,
  advisorSummaries,
  advisorTurnCounters,
  billingCustomers,
  brokerages,
  csvImportCounters,
  csvImportStaging,
  dashboardLayouts,
  emailTokens,
  exchangeRates,
  expenses,
  externalApiKeys,
  feeSchedules,
  fills,
  ledgerEntries,
  positionImages,
  positionTags,
  positions,
  sessions,
  subscriptions,
  symbolSyncState,
  symbols,
  tags,
  usageRecords,
  users,
  walletTransactions,
  wallets,
} from '@/db/schema';

import { emailHash, executeDeletion } from './account-deletion.service';

// executeDeletion + emailHash (design C5) against real tradr_test, each test
// rolled back by the single-connection harness (test-setup.ts). Nothing optional
// is configured, so the post-commit purge and PostHog steps take their
// graceful-absence no-op path and the purge outcome is `not_applicable` (Req 9.1).

let seq = 0;
const uniq = (tag: string): string => `${tag}-${Date.now()}-${++seq}`;
const FUTURE = new Date('2035-01-01T00:00:00.000Z');

async function seedUser(
  overrides: Partial<{ email: string; isAdmin: boolean }> = {},
): Promise<{ id: string; email: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `${uniq('acct-del-svc')}@example.com`,
      passwordHash: 'x'.repeat(60),
      isAdmin: overrides.isAdmin ?? false,
    })
    .returning({ id: users.id, email: users.email });
  return row;
}

type SeededGraph = {
  brokerageId: string;
  accountId: string;
  positionId: string;
  conversationId: string;
  usageRecordId: string;
  systemBrokerageId: string;
  ticker: string;
  auditActorRowId: string;
  auditTargetRowId: string;
};

/**
 * Seed a row in every user-keyed table for `userId`, including a schedule row,
 * `writable_account_id`, and the four RESTRICT / NO ACTION edges Req 4.4 names
 * (ledger_entries.account_id, positions.account_id, accounts.brokerage_id,
 * wallet_transactions.usage_record_id). Also seeds system-wide survivors
 * (`symbols`, `symbol_sync_state`, a null-user brokerage) and two audit rows
 * keyed to the user. Returns the parent ids the one-hop cascade assertions read.
 */
async function seedAllUserData(userId: string): Promise<SeededGraph> {
  const [brokerage] = await db
    .insert(brokerages)
    .values({ userId, name: uniq('Brk') })
    .returning({ id: brokerages.id });
  await db.insert(feeSchedules).values({ brokerageId: brokerage.id });

  const [account] = await db
    .insert(accounts)
    .values({ userId, name: uniq('Acct'), currency: 'USD', brokerageId: brokerage.id })
    .returning({ id: accounts.id });

  // The writable_account_id edge (users → accounts, SET NULL in migration).
  await db.update(users).set({ writableAccountId: account.id }).where(eq(users.id, userId));

  // Direct insert: this test seeds raw rows to prove the delete cascade, not the
  // positions feature's behaviour.
  // eslint-disable-next-line no-restricted-syntax
  const [position] = await db
    .insert(positions)
    .values({
      userId,
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'draft',
    })
    .returning({ id: positions.id });
  await db.insert(fills).values({
    positionId: position.id,
    type: 'buy',
    price: '10',
    quantity: '1',
    filledAt: new Date(),
  });
  await db.insert(positionImages).values({ positionId: position.id, part: { kind: 'inline' } });

  const [tag] = await db
    .insert(tags)
    .values({ userId, name: uniq('tag'), category: 'general' })
    .returning({ id: tags.id });
  await db.insert(positionTags).values({ positionId: position.id, tagId: tag.id });

  await db.insert(ledgerEntries).values({
    userId,
    accountId: account.id,
    positionId: position.id,
    entryType: 'deposit',
    direction: 'credit',
    amount: '10',
    currency: 'USD',
    occurredAt: new Date(),
    groupId: randomUUID(),
  });
  await db.insert(exchangeRates).values({
    userId,
    baseCurrency: 'USD',
    quoteCurrency: 'EUR',
    rate: '1.1',
    effectiveDate: '2030-01-01',
  });
  await db.insert(expenses).values({
    userId,
    category: 'other',
    description: 'seed',
    amount: '5',
    currency: 'USD',
    occurredAt: '2030-01-01',
  });

  await db
    .insert(csvImportStaging)
    .values({ userId, accountId: account.id, result: {}, expiresAt: FUTURE });
  await db.insert(csvImportCounters).values({ userId });
  await db.insert(dashboardLayouts).values({ userId });
  await db
    .insert(emailTokens)
    .values({ userId, purpose: 'password_reset', tokenHash: uniq('etok'), expiresAt: FUTURE });

  await db
    .insert(advisorPersonas)
    .values({ id: uniq('persona'), userId, name: 'p', systemPrompt: 'sp' });
  const [conversation] = await db
    .insert(advisorConversations)
    .values({ userId, title: 't', providerId: 'openai', model: 'gpt-4' })
    .returning({ id: advisorConversations.id });
  await db.insert(advisorMessages).values({
    conversationId: conversation.id,
    role: 'user',
    contentParts: [{ type: 'text', text: 'hi' }],
  });
  await db.insert(advisorSummaries).values({
    conversationId: conversation.id,
    prose: 's',
    coveredThroughCreatedAt: new Date(),
  });
  await db.insert(advisorProviderKeys).values({
    userId,
    providerId: 'openai',
    encryptedKey: 'enc',
    keyVersion: 1,
    defaultModel: 'gpt-4',
    keyHintTail: 'abcd',
  });
  await db.insert(externalApiKeys).values({
    userId,
    provider: 'polygon',
    encryptedKey: 'enc',
    keyVersion: 1,
    keyHintTail: 'abcd',
  });

  await db.insert(wallets).values({ userId });
  const [usageRecord] = await db
    .insert(usageRecords)
    .values({
      userId,
      providerId: 'openai',
      model: 'm',
      inputTokens: 1n,
      outputTokens: 1n,
      creditCost: 1n,
    })
    .returning({ id: usageRecords.id });
  // The NO ACTION edge: wallet_transactions.usage_record_id references a row
  // that is also cascade-deleted with the user.
  await db.insert(walletTransactions).values({
    userId,
    kind: 'debit',
    amount: 1n,
    balanceAfter: 0n,
    usageRecordId: usageRecord.id,
  });
  await db.insert(subscriptions).values({
    userId,
    stripeCustomerId: 'cus_seed',
    stripeSubscriptionId: uniq('sub'),
    status: 'active',
    currentPeriodEnd: FUTURE,
    stripeCreatedAt: new Date(),
    lastEventCreated: new Date(),
  });
  await db.insert(billingCustomers).values({ userId, stripeCustomerId: uniq('cus') });

  await db.insert(advisorTurnCounters).values({ userId, periodKey: '2030-01' });
  await db.insert(advisorImageCounters).values({ userId, periodKey: '2030-01' });

  await db.insert(accountDeletionSchedules).values({ userId, state: 'scheduled', dueAt: FUTURE });

  await db.insert(sessions).values({ userId, tokenHash: uniq('sess'), expiresAt: FUTURE });

  // Two admin_audit_log rows keyed to the user: one as actor, one as target.
  const [auditActor] = await db
    .insert(adminAuditLog)
    .values({
      action: 'admin_toggle',
      actorUserId: userId,
      actorEmail: 'seed-actor@example.com',
      targetUserId: null,
      targetEmail: 'seed-other@example.com',
      oldValue: false,
      newValue: true,
    })
    .returning({ id: adminAuditLog.id });
  const [auditTarget] = await db
    .insert(adminAuditLog)
    .values({
      action: 'admin_toggle',
      actorUserId: null,
      actorEmail: 'seed-actor2@example.com',
      targetUserId: userId,
      targetEmail: 'seed-target@example.com',
      oldValue: true,
      newValue: false,
    })
    .returning({ id: adminAuditLog.id });

  // System-wide survivors: a global symbol, the singleton sync-state row, and a
  // null-user (system) brokerage. None is keyed to the user.
  const ticker = uniq('ZT').slice(0, 16);
  await db.insert(symbols).values({ ticker, name: 'Seed', exchange: 'NYSE' }).onConflictDoNothing();
  await db.insert(symbolSyncState).values({ id: 1 }).onConflictDoNothing();
  const [systemBrokerage] = await db
    .insert(brokerages)
    .values({ userId: null, name: uniq('SysBrk'), isSystem: true })
    .returning({ id: brokerages.id });

  return {
    brokerageId: brokerage.id,
    accountId: account.id,
    positionId: position.id,
    conversationId: conversation.id,
    usageRecordId: usageRecord.id,
    systemBrokerageId: systemBrokerage.id,
    ticker,
    auditActorRowId: auditActor.id,
    auditTargetRowId: auditTarget.id,
  };
}

/** Tables with a single-column FK to `parent(id)`, read from the live catalog. */
async function fkChildren(parent: string): Promise<Array<{ table: string; column: string }>> {
  const rows = (await db.execute(sql`
    SELECT kcu.table_name AS child_table, kcu.column_name AS child_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = ${parent}
      AND ccu.column_name = 'id'
  `)) as unknown as Array<{ child_table: string; child_column: string }>;
  return rows.map((r) => ({ table: r.child_table, column: r.child_column }));
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS c FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value}`,
  )) as unknown as Array<{ c: number }>;
  return Number(rows[0].c);
}

describe('emailHash', () => {
  it('hashes the trimmed, lowercased address to 64 hex chars', () => {
    const hash = emailHash('  Foo.BAR@Example.COM  ');
    const expected = createHash('sha256').update('foo.bar@example.com').digest('hex');
    expect(hash).toBe(expected);
    expect(hash).toHaveLength(64);
  });
});

describe('executeDeletion — cascade', () => {
  it('removes every user-keyed row, keeps system rows, writes the tombstone', async () => {
    const user = await seedUser();
    const graph = await seedAllUserData(user.id);
    const expectedMarker = `deleted:${emailHash(user.email)}`;

    const result = await executeDeletion({ userId: user.id, initiator: 'self' });

    // Nothing optional configured → the purge is a graceful no-op (Req 9.1).
    expect(result.purgeOutcome).toBe('not_applicable');

    // Every table with a direct FK to users(id) holds zero rows keyed to the
    // user — cascade deletes and ON DELETE SET NULL both satisfy this (Req 4.3).
    const directChildren = await fkChildren('users');
    // The seed exercised a broad surface, not one table.
    expect(directChildren.length).toBeGreaterThan(10);
    for (const { table, column } of directChildren) {
      expect(await countWhere(table, column, user.id)).toBe(0);
    }

    // Tables one hop away (through positions, brokerages, advisor_conversations)
    // hold zero rows for the seeded parents.
    for (const [parent, parentId] of [
      ['positions', graph.positionId],
      ['brokerages', graph.brokerageId],
      ['advisor_conversations', graph.conversationId],
    ] as const) {
      for (const { table, column } of await fkChildren(parent)) {
        expect(await countWhere(table, column, parentId)).toBe(0);
      }
    }

    // Sessions are gone with the cascade — no deleteAllUserSessions call needed.
    const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(sessionRows).toHaveLength(0);

    // System-wide rows are untouched.
    const symbolRows = await db.select().from(symbols).where(eq(symbols.ticker, graph.ticker));
    expect(symbolRows).toHaveLength(1);
    const syncRows = await db.select().from(symbolSyncState).where(eq(symbolSyncState.id, 1));
    expect(syncRows).toHaveLength(1);
    const sysBrk = await db
      .select()
      .from(brokerages)
      .where(eq(brokerages.id, graph.systemBrokerageId));
    expect(sysBrk).toHaveLength(1);
    expect(sysBrk[0].userId).toBeNull();

    // Audit rows: the user-id columns are null (ON DELETE SET NULL) and the email
    // snapshots carry the `deleted:` hash marker (Req 4.3).
    const [actorRow] = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.id, graph.auditActorRowId));
    expect(actorRow.actorUserId).toBeNull();
    expect(actorRow.actorEmail).toBe(expectedMarker);
    const [targetRow] = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.id, graph.auditTargetRowId));
    expect(targetRow.targetUserId).toBeNull();
    expect(targetRow.targetEmail).toBe(expectedMarker);

    // The tombstone survives with no FK to users; purge outcome not_applicable.
    const [tombstone] = await db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, user.id));
    expect(tombstone).toBeDefined();
    expect(tombstone.emailHash).toBe(emailHash(user.email));
    expect(tombstone.initiator).toBe('self');
    expect(['free', 'pro']).toContain(tombstone.tier);
    expect(tombstone.purgeOutcome).toBe('not_applicable');
  });

  it('answers 404 on a second run and leaves exactly one tombstone', async () => {
    const user = await seedUser();

    await executeDeletion({ userId: user.id, initiator: 'self' });
    await expect(executeDeletion({ userId: user.id, initiator: 'self' })).rejects.toMatchObject({
      statusCode: 404,
    });

    const tombstones = await db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, user.id));
    expect(tombstones).toHaveLength(1);
  });
});

describe('executeDeletion — admin path', () => {
  it('writes one account_deletion audit row naming the actor', async () => {
    const admin = await seedUser({ isAdmin: true });
    const target = await seedUser();
    const marker = `deleted:${emailHash(target.email)}`;

    const result = await executeDeletion({
      userId: target.id,
      initiator: 'admin',
      actorId: admin.id,
    });
    expect(result.purgeOutcome).toBe('not_applicable');

    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, 'account_deletion'));
    const entry = rows.find((r) => r.actorUserId === admin.id);
    expect(entry).toBeDefined();
    expect(entry?.targetUserId).toBeNull();
    expect(entry?.targetEmail).toBe(marker);
    // The acting admin's own row survives.
    const adminRow = await db.select().from(users).where(eq(users.id, admin.id));
    expect(adminRow).toHaveLength(1);
  });
});

describe('executeDeletion — last-admin guard (D2)', () => {
  it('lets two admins delete themselves in turn, refusing the last with 409', async () => {
    // Make the two seeded admins the only admins in the instance.
    await db.update(users).set({ isAdmin: false });
    const first = await seedUser({ isAdmin: true });
    const second = await seedUser({ isAdmin: true });

    // First admin deletes cleanly — one admin remains.
    await executeDeletion({ userId: first.id, initiator: 'self' });

    // Second admin is now the last — refused, nothing deleted.
    await expect(executeDeletion({ userId: second.id, initiator: 'self' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAST_ADMIN',
    });
    const stillThere = await db.select().from(users).where(eq(users.id, second.id));
    expect(stillThere).toHaveLength(1);
  });
});
