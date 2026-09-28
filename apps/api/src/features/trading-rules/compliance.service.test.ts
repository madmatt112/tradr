import { eq } from 'drizzle-orm';
import { describe, it, expect, afterEach, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { tradingRules, users } from '@/db/schema';
import { ledgerEntries } from '@/db/schema/accounting.schema';
import { positions } from '@/db/schema/positions.schema';
import { logger } from '@/lib/logger';

import { getPositionCompliance } from './compliance.service';
import * as ruleEvaluator from './rule-evaluator';
import { loadScoringData } from './trading-rules.query';

// A DB-backed test for the scoring loader (design C4) and the compliance service
// (C6). Positions, fills, ledger rows and rules are seeded directly so the read
// paths are exercised against tradr_test without going through a position write.

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `compliance-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.98.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerUser(): Promise<{ cookie: string; userId: string }> {
  const email = uniqueEmail();
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { cookie, userId: user.id };
}

async function createAccount(cookie: string, currency = 'USD'): Promise<{ id: string }> {
  const res = await app.request('/api/accounts', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ name: `Acct ${++testCounter}`, currency }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

type PositionOverrides = Partial<typeof positions.$inferInsert>;

async function insertPosition(
  userId: string,
  accountId: string,
  overrides: PositionOverrides = {},
): Promise<string> {
  // eslint-disable-next-line no-restricted-syntax
  const [row] = await db
    .insert(positions)
    .values({
      userId,
      accountId,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'open',
      ...overrides,
    })
    .returning();
  return row!.id;
}

async function insertRule(
  userId: string,
  definition: { type: string; params: Record<string, unknown> },
  overrides: { enabled?: boolean; accountId?: string | null; tagId?: string | null } = {},
) {
  await db.insert(tradingRules).values({
    userId,
    type: definition.type,
    params: definition.params,
    weight: 'important',
    enabled: overrides.enabled ?? true,
    accountId: overrides.accountId ?? null,
    tagId: overrides.tagId ?? null,
    dedupKey: crypto.randomUUID(),
  });
}

async function insertBalanceEntry(userId: string, accountId: string, occurredAt: Date) {
  await db.insert(ledgerEntries).values({
    userId,
    accountId,
    positionId: null,
    entryType: 'position_pnl',
    direction: 'credit',
    amount: '100.0000',
    currency: 'USD',
    occurredAt,
    groupId: crypto.randomUUID(),
    reversesGroupId: null,
  });
}

const DIRECTIONS_RULE = { type: 'allowed_directions', params: { directions: ['long', 'short'] } };
const PERCENT_RULE = { type: 'max_risk_percent', params: { percent: '2' } };

const T0 = new Date('2026-06-15T15:00:00Z'); // one target's open instant
const BEFORE_LO = new Date('2026-05-20T15:00:00Z'); // more than 8 days before T0

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPositionCompliance', () => {
  it('returns undefined when the user holds no rules (Req 6.1)', async () => {
    const { cookie, userId } = await registerUser();
    const account = await createAccount(cookie);
    const positionId = await insertPosition(userId, account.id, { openedAt: T0 });

    expect(await getPositionCompliance(db, userId, positionId, 'open')).toBeUndefined();
  });

  it('returns the draft shape for a draft when rules exist (D19)', async () => {
    const { cookie, userId } = await registerUser();
    const account = await createAccount(cookie);
    await insertRule(userId, DIRECTIONS_RULE);
    const draftId = await insertPosition(userId, account.id, { status: 'draft', openedAt: null });

    expect(await getPositionCompliance(db, userId, draftId, 'draft')).toEqual({
      finality: null,
      score: null,
      status: 'unscored',
      entries: [],
    });
  });

  it('logs and returns an unscored result when scoring throws (Req 5.2)', async () => {
    const { cookie, userId } = await registerUser();
    const account = await createAccount(cookie);
    await insertRule(userId, DIRECTIONS_RULE);
    const positionId = await insertPosition(userId, account.id, { openedAt: T0 });

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(ruleEvaluator, 'scorePosition').mockImplementation(() => {
      throw new Error('forced scoring failure');
    });

    const result = await getPositionCompliance(db, userId, positionId, 'open');

    expect(result).toEqual({
      finality: 'provisional',
      score: null,
      status: 'unscored',
      entries: [],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'trading_rules_scoring_failed',
      expect.objectContaining({ positionId }),
    );
  });
});

describe('loadScoringData', () => {
  it('keeps a still-open position opened before the window and drops one flat before it', async () => {
    const { cookie, userId } = await registerUser();
    const account = await createAccount(cookie);
    await insertRule(userId, DIRECTIONS_RULE);

    const targetId = await insertPosition(userId, account.id, { openedAt: T0 });
    const stillOpenId = await insertPosition(userId, account.id, {
      openedAt: new Date('2026-05-15T15:00:00Z'), // before lo, but still open
      status: 'open',
    });
    const flatBeforeId = await insertPosition(userId, account.id, {
      openedAt: new Date('2026-05-10T15:00:00Z'),
      closedAt: BEFORE_LO, // went flat before lo, no fills after lo
      status: 'closed',
    });

    const data = await loadScoringData(db, userId, [targetId]);
    const ids = data.positions.map((p) => p.id);

    expect(ids).toContain(targetId);
    expect(ids).toContain(stillOpenId);
    expect(ids).not.toContain(flatBeforeId);
  });

  it('loads balance ledger rows only when an enabled percent rule needs them', async () => {
    const withPercent = await registerUser();
    const accountA = await createAccount(withPercent.cookie);
    const targetA = await insertPosition(withPercent.userId, accountA.id, { openedAt: T0 });
    await insertRule(withPercent.userId, PERCENT_RULE);
    await insertBalanceEntry(withPercent.userId, accountA.id, new Date('2026-06-14T15:00:00Z'));

    const withPercentData = await loadScoringData(db, withPercent.userId, [targetA]);
    expect(withPercentData.ledger.length).toBeGreaterThan(0);

    const withoutPercent = await registerUser();
    const accountB = await createAccount(withoutPercent.cookie);
    const targetB = await insertPosition(withoutPercent.userId, accountB.id, { openedAt: T0 });
    await insertRule(withoutPercent.userId, DIRECTIONS_RULE);
    await insertBalanceEntry(withoutPercent.userId, accountB.id, new Date('2026-06-14T15:00:00Z'));

    const withoutPercentData = await loadScoringData(db, withoutPercent.userId, [targetB]);
    expect(withoutPercentData.ledger).toEqual([]);
  });

  it('reports has_notes but never selects the notes text (NFR Security)', async () => {
    const { cookie, userId } = await registerUser();
    const account = await createAccount(cookie);
    await insertRule(userId, DIRECTIONS_RULE);

    const notesId = await insertPosition(userId, account.id, {
      openedAt: T0,
      notes: 'super secret notes the loader must never read',
    });
    const blankId = await insertPosition(userId, account.id, {
      openedAt: T0,
      notes: '   ',
    });

    const data = await loadScoringData(db, userId, [notesId]);
    const withNotes = data.positions.find((p) => p.id === notesId)!;
    const blank = data.positions.find((p) => p.id === blankId)!;

    expect(withNotes.hasNotes).toBe(true);
    expect('notes' in withNotes).toBe(false);
    expect((withNotes as unknown as Record<string, unknown>).notes).toBeUndefined();
    expect(blank.hasNotes).toBe(false);
  });

  it("never loads another user's positions or ledger rows (NFR Security)", async () => {
    const owner = await registerUser();
    const ownerAccount = await createAccount(owner.cookie);
    const targetId = await insertPosition(owner.userId, ownerAccount.id, { openedAt: T0 });
    await insertRule(owner.userId, PERCENT_RULE);
    await insertBalanceEntry(owner.userId, ownerAccount.id, new Date('2026-06-14T15:00:00Z'));

    const stranger = await registerUser();
    const strangerAccount = await createAccount(stranger.cookie);
    const strangerPosition = await insertPosition(stranger.userId, strangerAccount.id, {
      openedAt: T0,
    });
    await insertBalanceEntry(stranger.userId, strangerAccount.id, new Date('2026-06-14T15:00:00Z'));

    const data = await loadScoringData(db, owner.userId, [targetId]);

    expect(data.positions.map((p) => p.id)).not.toContain(strangerPosition);
    expect(data.positions.every((p) => p.accountId === ownerAccount.id)).toBe(true);
    expect(data.ledger.length).toBeGreaterThan(0);
    expect(data.ledger.every((e) => e.accountId === ownerAccount.id)).toBe(true);
  });
});
