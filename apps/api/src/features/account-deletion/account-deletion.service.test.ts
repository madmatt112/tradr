import { createHash, randomUUID } from 'node:crypto';

import bcrypt from 'bcrypt';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { logger } from '@/lib/logger';

import * as accountDeletionQuery from './account-deletion.query';
import { claimDueSchedules, claimForCancel } from './account-deletion.query';
import {
  adminDeleteUser,
  cancelScheduledDeletion,
  emailHash,
  executeDeletion,
  getDeletionStatus,
  requestSelfDeletion,
} from './account-deletion.service';

// executeDeletion + emailHash (design C5) against real tradr_test, each test
// rolled back by the single-connection harness (test-setup.ts). Nothing optional
// is configured, so the post-commit purge and PostHog steps take their
// graceful-absence no-op path and the purge outcome is `not_applicable` (Req 9.1).
//
// The self-service flows (requestSelfDeletion / cancelScheduledDeletion) reach
// Stripe through `getStripeClient()`; the C4 helpers they call take that client
// as a parameter, so stubbing this one seam (the `./stripe-client` mock in
// subscription.service.test.ts) drives every Stripe branch DB-side. The cascade,
// admin and last-admin blocks below never call it, so the stub is inert there.

const stripeMock = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/features/billing/stripe-client', () => ({
  getStripeClient: () => stripeMock.client,
}));

beforeEach(() => {
  stripeMock.client = null;
});

let seq = 0;
const uniq = (tag: string): string => `${tag}-${Date.now()}-${++seq}`;
const FUTURE = new Date('2035-01-01T00:00:00.000Z');

// A real bcrypt hash so `requestSelfDeletion`'s password gate accepts PASSWORD;
// cost 4 keeps the seed fast (bcrypt.compare reads the cost from the hash).
const PASSWORD = 'correct-horse-battery';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

/** A subscription the fake Stripe client returns from `subscriptions.list`. */
type FakeSub = { id: string; cancelAtPeriodEnd: boolean; periodEnd?: Date };

/**
 * A minimal Stripe stub for the C4 helpers: `subscriptions.list` yields the
 * live rows `extractSubscriptionMirror` parses, `subscriptions.update` records
 * `(id, cancel_at_period_end)` and may throw to drive the flip/restore failure
 * branches, and `subscriptions.cancel` records the admin path's immediate
 * cancels and may throw to drive its `502`. A thrown plain Error is a
 * non-already-canceled failure; an error whose `code` is `resource_missing`
 * makes `setRenewal`/`cancelNow` report `already_canceled`.
 */
function makeStripe(opts: {
  live?: FakeSub[];
  onUpdate?: (id: string, cancelAtPeriodEnd: boolean) => void;
  onCancel?: (id: string) => void;
}): unknown {
  const live = opts.live ?? [];
  return {
    subscriptions: {
      list: async () => ({
        data: live.map((s) => ({
          id: s.id,
          status: 'active',
          customer: 'cus_fake',
          cancel_at_period_end: s.cancelAtPeriodEnd,
          cancel_at: null,
          created: 1_600_000_000,
          items: {
            data: [
              {
                current_period_end: Math.floor((s.periodEnd ?? FUTURE).getTime() / 1000),
                price: { id: 'price_x', unit_amount: 1000, currency: 'usd' },
              },
            ],
          },
        })),
      }),
      update: async (id: string, params: { cancel_at_period_end: boolean }) => {
        opts.onUpdate?.(id, params.cancel_at_period_end);
        return {};
      },
      cancel: async (id: string) => {
        opts.onCancel?.(id);
        return {};
      },
    },
  };
}

/** A `resource_missing` Stripe error — `isAlreadyCanceledError` treats it as done. */
function alreadyCanceledError(): Error {
  return Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
}

async function seedUser(
  overrides: Partial<{ email: string; isAdmin: boolean; passwordHash: string }> = {},
): Promise<{ id: string; email: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `${uniq('acct-del-svc')}@example.com`,
      passwordHash: overrides.passwordHash ?? 'x'.repeat(60),
      isAdmin: overrides.isAdmin ?? false,
    })
    .returning({ id: users.id, email: users.email });
  return row;
}

/** A user with the real password hash and a Stripe billing-customer link. */
async function seedBillingUser(): Promise<{ id: string; email: string }> {
  const user = await seedUser({ passwordHash: PASSWORD_HASH });
  await db.insert(billingCustomers).values({ userId: user.id, stripeCustomerId: uniq('cus') });
  return user;
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

describe('executeDeletion — post-commit tombstone purge failure', () => {
  it('logs and still resolves when the post-commit purge-outcome UPDATE rejects', async () => {
    const user = await seedUser();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // The purge-outcome UPDATE runs after the deletion transaction commits.
    const purgeSpy = vi
      .spyOn(accountDeletionQuery, 'updateTombstonePurge')
      .mockRejectedValueOnce(new Error('tombstone boom'));

    // The deletion resolves — the post-commit throw is caught, not propagated.
    const result = await executeDeletion({ userId: user.id, initiator: 'self' });
    expect(result.purgeOutcome).toBe('not_applicable');

    // The commit stands: the user (and its cascade) is gone.
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
    // The tombstone survives, still `pending` for the gc sweeper to recover.
    const [tombstone] = await db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, user.id));
    expect(tombstone.purgeOutcome).toBe('pending');

    expect(purgeSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'account deletion tombstone purge update failed',
      expect.objectContaining({ userId: user.id }),
    );
    warnSpy.mockRestore();
    purgeSpy.mockRestore();
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

describe('adminDeleteUser', () => {
  it('cancels every live subscription, then deletes the target with one account_deletion audit row', async () => {
    const admin = await seedUser({ isAdmin: true });
    const target = await seedBillingUser();
    const marker = `deleted:${emailHash(target.email)}`;
    const canceled: string[] = [];
    stripeMock.client = makeStripe({
      live: [{ id: 'sub_A', cancelAtPeriodEnd: false }],
      onCancel: (id) => canceled.push(id),
    });

    const result = await adminDeleteUser(admin.id, target.id, target.email);

    expect(result).toEqual({
      userId: target.id,
      outcome: 'deleted',
      purgeOutcome: 'not_applicable',
    });
    // The live subscription was canceled immediately (not scheduled).
    expect(canceled).toEqual(['sub_A']);
    expect(await db.select().from(users).where(eq(users.id, target.id))).toHaveLength(0);

    // Exactly one account_deletion audit row: null target id, the marker email.
    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, 'account_deletion'));
    const entry = rows.find((r) => r.actorUserId === admin.id);
    expect(entry).toBeDefined();
    expect(entry?.targetUserId).toBeNull();
    expect(entry?.targetEmail).toBe(marker);
  });

  it('deletes nothing when a live-subscription cancel fails (502 STRIPE_CANCEL_FAILED)', async () => {
    const admin = await seedUser({ isAdmin: true });
    const target = await seedBillingUser();
    stripeMock.client = makeStripe({
      live: [{ id: 'sub_A', cancelAtPeriodEnd: false }],
      onCancel: () => {
        throw new Error('cancel boom');
      },
    });

    await expect(adminDeleteUser(admin.id, target.id, target.email)).rejects.toMatchObject({
      statusCode: 502,
      code: 'STRIPE_CANCEL_FAILED',
    });
    // Nothing deleted: the target row and no tombstone.
    expect(await db.select().from(users).where(eq(users.id, target.id))).toHaveLength(1);
    expect(
      await db.select().from(accountDeletions).where(eq(accountDeletions.userId, target.id)),
    ).toHaveLength(0);
  });

  it('erases a self-scheduled target, dropping the schedule row so a later due claim finds nothing (R4-2)', async () => {
    const admin = await seedUser({ isAdmin: true });
    const target = await seedUser();
    // The target had already self-scheduled a deletion.
    await db.insert(accountDeletionSchedules).values({
      userId: target.id,
      state: 'scheduled',
      dueAt: FUTURE,
      stripeSubscriptionIds: [],
    });

    // Stripe unconfigured (stripeMock.client null) and no live mirror row → the
    // admin path skips the cancel loop and deletes immediately.
    await adminDeleteUser(admin.id, target.id, target.email);

    expect(await db.select().from(users).where(eq(users.id, target.id))).toHaveLength(0);
    // The schedule row went with the user cascade.
    expect(
      await db
        .select()
        .from(accountDeletionSchedules)
        .where(eq(accountDeletionSchedules.userId, target.id)),
    ).toHaveLength(0);
    // A later fire finds nothing to claim.
    const due = await claimDueSchedules(
      db,
      new Date('2036-01-01T00:00:00.000Z'),
      15 * 60 * 1000,
      10,
    );
    expect(due.some((r) => r.userId === target.id)).toBe(false);
  });

  it('refuses a self-target, an unknown target and an email mismatch, changing nothing', async () => {
    const admin = await seedUser({ isAdmin: true });

    // An admin deleting themselves is pointed at the self-service path.
    await expect(adminDeleteUser(admin.id, admin.id, admin.email)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });

    // An unknown target is a 404.
    await expect(
      adminDeleteUser(admin.id, randomUUID(), 'nobody@example.com'),
    ).rejects.toMatchObject({ statusCode: 404 });

    // A typed-email mismatch is a 400 and the target survives.
    const target = await seedUser();
    await expect(adminDeleteUser(admin.id, target.id, 'wrong@example.com')).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(await db.select().from(users).where(eq(users.id, target.id))).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.id, admin.id))).toHaveLength(1);
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

describe('requestSelfDeletion — password gate and guards', () => {
  it('rejects a wrong password with 403 INVALID_PASSWORD and deletes nothing', async () => {
    const user = await seedUser({ passwordHash: PASSWORD_HASH });
    await expect(requestSelfDeletion(user.id, 'wrong-password')).rejects.toMatchObject({
      statusCode: 403,
      code: 'INVALID_PASSWORD',
    });
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
  });

  it('refuses with 409 SUBSCRIPTION_UNRESOLVED when Stripe is down but a live mirror remains', async () => {
    const user = await seedUser({ passwordHash: PASSWORD_HASH });
    await db.insert(subscriptions).values({
      userId: user.id,
      stripeCustomerId: 'cus_seed',
      stripeSubscriptionId: uniq('sub'),
      status: 'active',
      currentPeriodEnd: FUTURE,
      stripeCreatedAt: new Date(),
      lastEventCreated: new Date(),
    });
    // stripeMock.client stays null → getStripeClient() is null (Req 2.3).
    await expect(requestSelfDeletion(user.id, PASSWORD)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SUBSCRIPTION_UNRESOLVED',
    });
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
  });

  it('refuses with 409 DELETION_IN_PROGRESS when a firing row exists', async () => {
    const user = await seedUser({ passwordHash: PASSWORD_HASH });
    await db
      .insert(accountDeletionSchedules)
      .values({ userId: user.id, state: 'firing', dueAt: FUTURE, claimedAt: new Date() });
    await expect(requestSelfDeletion(user.id, PASSWORD)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DELETION_IN_PROGRESS',
    });
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
  });
});

describe('requestSelfDeletion — immediate vs scheduled', () => {
  it('deletes immediately when no live subscription exists', async () => {
    const user = await seedBillingUser();
    stripeMock.client = makeStripe({ live: [] });

    const result = await requestSelfDeletion(user.id, PASSWORD);

    expect(result).toEqual({ outcome: 'deleted' });
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
    expect(
      await db.select().from(accountDeletions).where(eq(accountDeletions.userId, user.id)),
    ).toHaveLength(1);
  });

  it('schedules to the latest period end and flips the renewing subscription (none → pending → scheduled)', async () => {
    const user = await seedBillingUser();
    const calls: Array<{ id: string; cancel: boolean }> = [];
    stripeMock.client = makeStripe({
      live: [{ id: 'sub_A', cancelAtPeriodEnd: false }],
      onUpdate: (id, cancel) => calls.push({ id, cancel }),
    });

    const result = await requestSelfDeletion(user.id, PASSWORD);

    expect(result).toEqual({ outcome: 'scheduled', scheduledFor: FUTURE.toISOString() });
    // setRenewal(id, false) → cancel_at_period_end true.
    expect(calls).toEqual([{ id: 'sub_A', cancel: true }]);
    const [row] = await db
      .select()
      .from(accountDeletionSchedules)
      .where(eq(accountDeletionSchedules.userId, user.id));
    expect(row.state).toBe('scheduled');
    expect(row.dueAt.toISOString()).toBe(FUTURE.toISOString());
    expect(row.stripeSubscriptionIds).toEqual(['sub_A']);
    // The user survives — the fire runs at the period end.
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
  });

  it('deletes immediately when every renewing subscription is already canceled (R4-3)', async () => {
    const user = await seedBillingUser();
    stripeMock.client = makeStripe({
      live: [{ id: 'sub_A', cancelAtPeriodEnd: false }],
      onUpdate: () => {
        throw alreadyCanceledError();
      },
    });

    const result = await requestSelfDeletion(user.id, PASSWORD);

    expect(result).toEqual({ outcome: 'deleted' });
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
    // The pending row it persisted is gone (deleted before the immediate delete).
    expect(
      await db
        .select()
        .from(accountDeletionSchedules)
        .where(eq(accountDeletionSchedules.userId, user.id)),
    ).toHaveLength(0);
  });
});

describe('requestSelfDeletion — compensation (Error Handling 6)', () => {
  it('restores only the flipped ids, deletes the row it inserted, and throws 502', async () => {
    const user = await seedBillingUser();
    const calls: Array<{ id: string; cancel: boolean }> = [];
    stripeMock.client = makeStripe({
      live: [
        { id: 'sub_A', cancelAtPeriodEnd: false },
        { id: 'sub_B', cancelAtPeriodEnd: false },
        { id: 'sub_C', cancelAtPeriodEnd: true }, // Portal-cancelled: never in renewingIds.
      ],
      onUpdate: (id, cancel) => {
        calls.push({ id, cancel });
        if (id === 'sub_B' && cancel === true) throw new Error('stripe boom');
      },
    });

    await expect(requestSelfDeletion(user.id, PASSWORD)).rejects.toMatchObject({
      statusCode: 502,
      code: 'STRIPE_CANCEL_FAILED',
    });

    // A flipped, B flip threw, A restored — C is never touched.
    expect(calls).toEqual([
      { id: 'sub_A', cancel: true },
      { id: 'sub_B', cancel: true },
      { id: 'sub_A', cancel: false },
    ]);
    expect(calls.some((c) => c.id === 'sub_C')).toBe(false);
    // The just-inserted row is gone; nothing was deleted.
    expect(
      await db
        .select()
        .from(accountDeletionSchedules)
        .where(eq(accountDeletionSchedules.userId, user.id)),
    ).toHaveLength(0);
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
  });

  it('logs one error naming the user and each still-flipped id when a restore also throws', async () => {
    const user = await seedBillingUser();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    stripeMock.client = makeStripe({
      live: [
        { id: 'sub_A', cancelAtPeriodEnd: false },
        { id: 'sub_B', cancelAtPeriodEnd: false },
      ],
      onUpdate: (id, cancel) => {
        if (id === 'sub_B' && cancel === true) throw new Error('flip boom');
        if (id === 'sub_A' && cancel === false) throw new Error('restore boom');
      },
    });

    await expect(requestSelfDeletion(user.id, PASSWORD)).rejects.toMatchObject({
      statusCode: 502,
      code: 'STRIPE_CANCEL_FAILED',
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'account deletion compensation failed',
      expect.objectContaining({ userId: user.id, subscriptionIds: ['sub_A'] }),
    );
    errorSpy.mockRestore();
  });
});

describe('cancelScheduledDeletion', () => {
  it('re-enables each stored subscription and deletes the claimed row (cancelling → deleted)', async () => {
    const user = await seedUser();
    await db.insert(accountDeletionSchedules).values({
      userId: user.id,
      state: 'scheduled',
      dueAt: FUTURE,
      stripeSubscriptionIds: ['sub_A'],
    });
    const calls: Array<{ id: string; cancel: boolean }> = [];
    stripeMock.client = makeStripe({ onUpdate: (id, cancel) => calls.push({ id, cancel }) });

    await cancelScheduledDeletion(user.id);

    // setRenewal(id, true) → cancel_at_period_end false (renewal restored).
    expect(calls).toEqual([{ id: 'sub_A', cancel: false }]);
    expect(
      await db
        .select()
        .from(accountDeletionSchedules)
        .where(eq(accountDeletionSchedules.userId, user.id)),
    ).toHaveLength(0);
  });

  it('throws 404 NO_DELETION_SCHEDULED when no row exists', async () => {
    const user = await seedUser();
    await expect(cancelScheduledDeletion(user.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NO_DELETION_SCHEDULED',
    });
  });

  it('reverts the row to scheduled and throws 402 when Stripe is unavailable', async () => {
    const user = await seedUser();
    await db.insert(accountDeletionSchedules).values({
      userId: user.id,
      state: 'scheduled',
      dueAt: FUTURE,
      stripeSubscriptionIds: ['sub_A'],
    });
    // stripeMock.client stays null.
    await expect(cancelScheduledDeletion(user.id)).rejects.toMatchObject({
      statusCode: 402,
      code: 'BILLING_NOT_AVAILABLE',
    });
    const [row] = await db
      .select()
      .from(accountDeletionSchedules)
      .where(eq(accountDeletionSchedules.userId, user.id));
    expect(row.state).toBe('scheduled');
    expect(row.claimedAt).toBeNull();
  });

  it('reverts the row to scheduled and throws 502 when re-enable fails (cancelling → scheduled)', async () => {
    const user = await seedUser();
    await db.insert(accountDeletionSchedules).values({
      userId: user.id,
      state: 'scheduled',
      dueAt: FUTURE,
      stripeSubscriptionIds: ['sub_A'],
    });
    stripeMock.client = makeStripe({
      onUpdate: () => {
        throw new Error('reenable boom');
      },
    });

    await expect(cancelScheduledDeletion(user.id)).rejects.toMatchObject({
      statusCode: 502,
      code: 'STRIPE_REENABLE_FAILED',
    });
    const [row] = await db
      .select()
      .from(accountDeletionSchedules)
      .where(eq(accountDeletionSchedules.userId, user.id));
    expect(row.state).toBe('scheduled');
    expect(row.claimedAt).toBeNull();
  });
});

describe('cancel versus fire — one atomic claim (D2)', () => {
  it('a cancel claim leaves nothing for a later fire to claim (scheduled → cancelling)', async () => {
    const user = await seedUser();
    await db
      .insert(accountDeletionSchedules)
      .values({ userId: user.id, state: 'scheduled', dueAt: FUTURE, stripeSubscriptionIds: [] });

    // Cancel claims first.
    const claimed = await claimForCancel(db, user.id);
    expect(claimed?.state).toBe('cancelling');

    // The fire's due-claim skips the now-cancelling row — a no-op.
    const due = await claimDueSchedules(
      db,
      new Date('2036-01-01T00:00:00.000Z'),
      15 * 60 * 1000,
      10,
    );
    expect(due.some((r) => r.userId === user.id)).toBe(false);
  });

  it('a fire claim makes a later cancel a 409 DELETION_IN_PROGRESS no-op (scheduled → firing)', async () => {
    const user = await seedUser();
    await db.insert(accountDeletionSchedules).values({
      userId: user.id,
      state: 'scheduled',
      dueAt: FUTURE,
      stripeSubscriptionIds: ['sub_A'],
    });

    // Fire claims first.
    const due = await claimDueSchedules(
      db,
      new Date('2036-01-01T00:00:00.000Z'),
      15 * 60 * 1000,
      10,
    );
    expect(due.some((r) => r.userId === user.id)).toBe(true);

    // Cancel loses the claim, makes no Stripe call, and reports in-progress.
    const calls: Array<{ id: string; cancel: boolean }> = [];
    stripeMock.client = makeStripe({ onUpdate: (id, cancel) => calls.push({ id, cancel }) });
    await expect(cancelScheduledDeletion(user.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DELETION_IN_PROGRESS',
    });
    expect(calls).toHaveLength(0);
    const [row] = await db
      .select()
      .from(accountDeletionSchedules)
      .where(eq(accountDeletionSchedules.userId, user.id));
    expect(row.state).toBe('firing');
  });
});

describe('getDeletionStatus', () => {
  it('returns null fields when no schedule row exists', async () => {
    const user = await seedUser();
    expect(await getDeletionStatus(user.id)).toEqual({ scheduledFor: null, state: null });
  });

  it('maps a schedule row to its due date and state', async () => {
    const user = await seedUser();
    await db
      .insert(accountDeletionSchedules)
      .values({ userId: user.id, state: 'scheduled', dueAt: FUTURE, stripeSubscriptionIds: [] });
    expect(await getDeletionStatus(user.id)).toEqual({
      scheduledFor: FUTURE.toISOString(),
      state: 'scheduled',
    });
  });
});
