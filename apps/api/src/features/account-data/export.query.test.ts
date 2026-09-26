import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db';
import {
  accounts,
  advisorConversations,
  advisorMessages,
  advisorPersonas,
  advisorSummaries,
  brokerages,
  dashboardLayouts,
  exchangeRates,
  expenses,
  feeSchedules,
  fills,
  ledgerEntries,
  positionImages,
  positionTags,
  positions,
  tags,
  users,
} from '@/db/schema';
import { withTransaction } from '@/lib/transaction';

import { spoolAccountData, type SpoolSummary } from './export.query';

// Design C2 export reader, against real tradr_test rolled back by the
// single-connection harness (test-setup.ts). One row of every category is
// seeded (plus a decoy second user and unreferenced platform rows), spooled,
// and read back from disk.

const MICRO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const POSITION_CREATED = '2026-01-02T03:04:05.123456Z';
const MESSAGE_CREATED = '2026-02-03T04:05:06.654321Z';
const INLINE_IMAGE_PART = { type: 'image', format: 'png', dataBase64: 'aGVsbG8=' };
const MESSAGE_PARTS = [{ type: 'text', text: 'hello' }];

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'export-query-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Seed {
  userId: string;
  email: string;
  accountId: string;
  positionId: string;
  tagId: string;
  personaId: string;
  conversationId: string;
  messageId: string;
  userBrokerageName: string;
  systemBrokerageName: string;
}

async function seedUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `export-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id, email: users.email });
  return row.id;
}

async function seedFull(): Promise<Seed> {
  const [u] = await db
    .insert(users)
    .values({ email: `export-${randomUUID()}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id, email: users.email });
  const userId = u.id;

  const userBrokerageName = 'My Broker';
  const [bUser] = await db
    .insert(brokerages)
    .values({ userId, name: userBrokerageName, notes: 'personal', isSystem: false })
    .returning({ id: brokerages.id });
  await db.insert(feeSchedules).values({
    brokerageId: bUser.id,
    stockPerShareCommission: '0.01',
    stockMinPerFill: '1',
    stockMaxPerFill: '5',
    optionsPerContractCommission: '0.65',
    optionsPerContractExchangeFee: '0.02',
    optionsMinPerFill: '0',
    optionsMaxPerFill: '10',
  });

  const systemBrokerageName = 'Interactive Sys';
  const [bSysUsed] = await db
    .insert(brokerages)
    .values({ userId: null, name: systemBrokerageName, isSystem: true })
    .returning({ id: brokerages.id });
  await db.insert(feeSchedules).values({
    brokerageId: bSysUsed.id,
    stockPerShareCommission: '0.005',
    stockMinPerFill: '0',
    stockMaxPerFill: '0',
    optionsPerContractCommission: '0.5',
    optionsPerContractExchangeFee: '0',
    optionsMinPerFill: '0',
    optionsMaxPerFill: '0',
  });
  // A system brokerage no account uses — must NOT appear in the reference file.
  await db.insert(brokerages).values({ userId: null, name: 'Unused Sys', isSystem: true });

  const [acct] = await db
    .insert(accounts)
    .values({
      userId,
      name: 'Main',
      currency: 'USD',
      timezone: 'America/New_York',
      brokerageId: bSysUsed.id,
      startingBalance: '1234.56',
      defaultRiskPercent: '2.5',
      isDemo: false,
      isDefault: true,
    })
    .returning({ id: accounts.id });

  const [tag] = await db
    .insert(tags)
    .values({ userId, name: 'Breakout', category: 'setup', color: '#ffffff' })
    .returning({ id: tags.id });

  // eslint-disable-next-line no-restricted-syntax -- seeding a fixed closed position for the reader test
  const [pos] = await db
    .insert(positions)
    .values({
      userId,
      accountId: acct.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      targetPrice: '1.5',
      stopLoss: null,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatAt: new Date('2026-01-02T00:00:00Z'),
      lastFlatNetPnl: '123.45',
      createdAt: sql`timestamptz '2026-01-02 03:04:05.123456+00'`,
    })
    .returning({ id: positions.id });

  await db.insert(fills).values({
    positionId: pos.id,
    type: 'entry',
    price: '0.5',
    quantity: '10',
    fees: '0.01',
    filledAt: new Date('2026-01-01T12:00:00Z'),
  });

  await db.insert(positionTags).values({ positionId: pos.id, tagId: tag.id });
  await db.insert(positionImages).values({ positionId: pos.id, part: INLINE_IMAGE_PART });

  await db.insert(ledgerEntries).values({
    userId,
    accountId: acct.id,
    positionId: pos.id,
    entryType: 'position_pnl',
    direction: 'credit',
    amount: '10',
    currency: 'USD',
    symbol: 'AAPL',
    occurredAt: new Date('2026-01-02T00:00:00Z'),
    groupId: randomUUID(),
    reversesGroupId: null,
  });

  await db.insert(exchangeRates).values({
    userId,
    baseCurrency: 'USD',
    quoteCurrency: 'CAD',
    rate: '1.35',
    effectiveDate: '2026-01-03',
  });

  await db.insert(expenses).values({
    userId,
    category: 'data_subscription',
    description: 'Data feed',
    amount: '5',
    currency: 'USD',
    occurredAt: '2026-01-04',
    notes: null,
  });

  const personaId = randomUUID();
  await db.insert(advisorPersonas).values({
    id: personaId,
    userId,
    name: 'My Coach',
    description: null,
    systemPrompt: 'be helpful',
    isBuiltin: false,
    isDefault: false,
  });

  // Preferences: default persona is the user persona ({user:id}); writable
  // account set; a non-default theme so the value is meaningful.
  await db
    .update(users)
    .set({
      displayCurrency: 'USD',
      timezone: 'America/New_York',
      taxJurisdiction: 'US',
      theme: 'dark',
      buyingPowerBasis: 'balance',
      advisorDefaultPersonaId: personaId,
      advisorTradeDataConsent: true,
      writableAccountId: acct.id,
    })
    .where(sql`id = ${userId}`);

  // Conversation references a BUILTIN persona so the reference file names it.
  const [conv] = await db
    .insert(advisorConversations)
    .values({
      userId,
      title: 'Chat',
      personaId: 'default-trading-advisor',
      providerId: 'openai',
      model: 'gpt-4',
    })
    .returning({ id: advisorConversations.id });

  const [msg] = await db
    .insert(advisorMessages)
    .values({
      conversationId: conv.id,
      role: 'user',
      contentParts: MESSAGE_PARTS,
      promptTokens: 5,
      completionTokens: null,
      clientMessageId: randomUUID(),
      createdAt: sql`timestamptz '2026-02-03 04:05:06.654321+00'`,
    })
    .returning({ id: advisorMessages.id });

  await db.insert(advisorSummaries).values({
    conversationId: conv.id,
    prose: 'a summary',
    tradeDataFigures: null,
    coveredThroughMessageId: msg.id,
    coveredThroughCreatedAt: new Date('2026-02-03T04:05:06Z'),
  });

  await db
    .insert(dashboardLayouts)
    .values({ userId, widgets: [{ type: 'stats-summary', id: 'pnl', x: 0, y: 0, w: 4, h: 2 }] });

  return {
    userId,
    email: u.email,
    accountId: acct.id,
    positionId: pos.id,
    tagId: tag.id,
    personaId,
    conversationId: conv.id,
    messageId: msg.id,
    userBrokerageName,
    systemBrokerageName,
  };
}

async function runSpool(userId: string): Promise<SpoolSummary> {
  return withTransaction(db, (tx) => spoolAccountData(tx, userId, tmp));
}

async function readNdjson(name: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path.join(tmp, name), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(tmp, name), 'utf8'));
}

describe('spoolAccountData', () => {
  it('spools one row of every category with microsecond timestamps and exact decimals', async () => {
    const seed = await seedFull();
    const summary = await runSpool(seed.userId);

    expect(summary.email).toBe(seed.email);
    expect(summary.counts).toEqual({
      brokerages: 1,
      systemBrokerages: 1,
      accounts: 1,
      tags: 1,
      positions: 1,
      fills: 1,
      positionTags: 1,
      positionImages: 1,
      ledgerEntries: 1,
      exchangeRates: 1,
      expenses: 1,
      personas: 1,
      builtinPersonas: 1,
      conversations: 1,
      messages: 1,
      summaries: 1,
    });

    const [account] = await readNdjson('accounts.ndjson');
    expect(account.startingBalance).toBe('1234.5600');
    expect(account.defaultRiskPercent).toBe('2.50');
    expect(account.brokerage).toEqual({ system: seed.systemBrokerageName });
    expect(account.createdAt).toMatch(MICRO_TS_RE);

    const [position] = await readNdjson('positions.ndjson');
    expect(position.createdAt).toBe(POSITION_CREATED);
    expect(position.lastFlatNetPnl).toBe('123.4500');
    expect(position.targetPrice).toBe('1.50000000');
    expect(position.stopLoss).toBeNull();

    const [fill] = await readNdjson('fills.ndjson');
    expect(fill.price).toBe('0.50000000');
    expect(fill.fees).toBe('0.01000000');

    const [rate] = await readNdjson('exchange-rates.ndjson');
    expect(rate.rate).toBe('1.350000000000');
    expect(rate.effectiveDate).toBe('2026-01-03');

    const [expense] = await readNdjson('expenses.ndjson');
    expect(expense.amount).toBe('5.0000');
    expect(expense.occurredAt).toBe('2026-01-04');

    const [ledger] = await readNdjson('ledger-entries.ndjson');
    expect(ledger.amount).toBe('10.0000');
    expect(ledger.occurredAt).toMatch(MICRO_TS_RE);
  });

  it('spools message and image parts raw (no image decoding) and preferences without the email', async () => {
    const seed = await seedFull();
    await runSpool(seed.userId);

    const [image] = await readNdjson('position-images.ndjson');
    expect(image.part).toEqual(INLINE_IMAGE_PART);
    expect(image.createdAt).toMatch(MICRO_TS_RE);

    const [message] = await readNdjson('messages.ndjson');
    expect(message.contentParts).toEqual(MESSAGE_PARTS);
    expect(message.createdAt).toBe(MESSAGE_CREATED);
    expect(message.promptTokens).toBe(5);
    expect(message.completionTokens).toBeNull();

    const preferences = (await readJson('preferences.json')) as Record<string, unknown>;
    expect(preferences).not.toHaveProperty('email');
    expect(preferences.theme).toBe('dark');
    expect(preferences.buyingPowerBasis).toBe('balance');
    expect(preferences.advisorDefaultPersona).toEqual({ user: seed.personaId });
    expect(preferences.writableAccountId).toBe(seed.accountId);

    const layout = (await readJson('dashboard-layout.json')) as Record<string, unknown>;
    expect(layout.widgets).toEqual([{ type: 'stats-summary', id: 'pnl', x: 0, y: 0, w: 4, h: 2 }]);
    expect(layout.createdAt).toMatch(MICRO_TS_RE);
  });

  it('lists only referenced builtin personas and used system brokerages', async () => {
    const seed = await seedFull();
    await runSpool(seed.userId);

    const builtins = await readNdjson('builtin-personas.ndjson');
    expect(builtins).toEqual([{ id: 'default-trading-advisor' }]);

    const systemBrokerages = await readNdjson('system-brokerages.ndjson');
    expect(systemBrokerages).toHaveLength(1);
    expect(systemBrokerages[0].name).toBe(seed.systemBrokerageName);
    expect(systemBrokerages[0].feeSchedule).toMatchObject({
      stockPerShareCommission: '0.00500000',
    });

    const [conversation] = await readNdjson('conversations.ndjson');
    expect(conversation.persona).toEqual({ builtin: 'default-trading-advisor' });

    const userBrokerages = await readNdjson('brokerages.ndjson');
    expect(userBrokerages).toHaveLength(1);
    expect(userBrokerages[0].name).toBe(seed.userBrokerageName);
    expect(userBrokerages[0].feeSchedule).toMatchObject({
      stockPerShareCommission: '0.01000000',
      createdAt: expect.stringMatching(MICRO_TS_RE),
    });
  });

  it("never reads a second user's rows", async () => {
    const seed = await seedFull();

    // A decoy user with a full parallel surface.
    const otherId = await seedUser();
    const [otherAcct] = await db
      .insert(accounts)
      .values({ userId: otherId, name: 'Other', currency: 'USD', isDefault: true })
      .returning({ id: accounts.id });
    // eslint-disable-next-line no-restricted-syntax -- seeding a decoy position for the isolation test
    await db.insert(positions).values({
      userId: otherId,
      accountId: otherAcct.id,
      symbol: 'MSFT',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      openedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await db.insert(tags).values({ userId: otherId, name: 'Other', category: 'general' });
    await db.insert(ledgerEntries).values({
      userId: otherId,
      accountId: otherAcct.id,
      entryType: 'balance_adjustment',
      direction: 'credit',
      amount: '99',
      currency: 'USD',
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      groupId: randomUUID(),
    });
    const [otherConv] = await db
      .insert(advisorConversations)
      .values({ userId: otherId, title: 'Other', providerId: 'openai', model: 'gpt-4' })
      .returning({ id: advisorConversations.id });
    await db
      .insert(advisorMessages)
      .values({ conversationId: otherConv.id, role: 'user', contentParts: [] });

    const summary = await runSpool(seed.userId);

    // Counts stay at exactly one per category — the decoy never leaks in.
    expect(Object.values(summary.counts).every((n) => n === 1)).toBe(true);

    const accountRows = await readNdjson('accounts.ndjson');
    expect(accountRows.map((r) => r.id)).toEqual([seed.accountId]);
    const positionRows = await readNdjson('positions.ndjson');
    expect(positionRows.map((r) => r.id)).toEqual([seed.positionId]);
    const messageRows = await readNdjson('messages.ndjson');
    expect(messageRows.map((r) => r.id)).toEqual([seed.messageId]);
    const tagRows = await readNdjson('tags.ndjson');
    expect(tagRows.map((r) => r.id)).toEqual([seed.tagId]);
    const conversationRows = await readNdjson('conversations.ndjson');
    expect(conversationRows.map((r) => r.id)).toEqual([seed.conversationId]);
  });
});
