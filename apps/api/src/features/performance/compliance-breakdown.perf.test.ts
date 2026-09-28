import { describe, it, expect } from 'vitest';

import { type BreakdownQueryInput } from '@tradr/shared';

import { db } from '@/db';
import { accounts, tradingRules, users } from '@/db/schema';
import { seedPositions } from '@/db/seed';

import { getBreakdown } from './breakdown.service';

// NFR Performance: the compliance breakdown scores its whole population in a
// second read-only transaction, in chunks, under the same ten-second budget the
// timeout middleware enforces. This exercises the budget end to end: 5,000
// closed positions scored against 50 enabled rules must answer inside 10s.

let counter = 0;
function uniqueEmail() {
  return `compliance-perf-${Date.now()}-${++counter}@example.com`;
}

async function createUser() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  return user!;
}

async function createAccount(userId: string, currency: string) {
  const [account] = await db
    .insert(accounts)
    .values({ userId, name: `Acc-${currency}-${++counter}`, currency })
    .returning();
  return account!;
}

async function insertRule(userId: string, definition: { type: string; params: object }) {
  await db.insert(tradingRules).values({
    userId,
    type: definition.type,
    params: definition.params as Record<string, unknown>,
    weight: 'important',
    enabled: true,
    accountId: null,
    tagId: null,
    dedupKey: crypto.randomUUID(),
  });
}

// Per-position rule types only — none build a cross-position population — rotated
// to fill the fifty-rule limit.
const RULE_ROTATION: { type: string; params: object }[] = [
  { type: 'allowed_directions', params: { directions: ['long', 'short'] } },
  { type: 'allowed_markets', params: { markets: ['stock', 'option'] } },
  { type: 'max_position_size', params: { amount: '1000000', currency: 'USD' } },
  { type: 'max_risk_amount', params: { amount: '1000000', currency: 'USD' } },
  { type: 'required_fields', params: { fields: ['notes'] } },
  { type: 'min_risk_reward', params: { ratio: '1' } },
];

function sumPositions(rows: readonly { stats: { totalPositions: number } }[]): number {
  return rows.reduce((n, r) => n + r.stats.totalPositions, 0);
}

describe('compliance breakdown performance', () => {
  it('scores 5,000 closed positions against 50 rules within 10 seconds', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');

    await seedPositions(db, {
      userId: user.id,
      accountId: usd.id,
      count: 5_000,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-01T00:00:00.000Z'),
        end: new Date('2026-01-31T00:00:00.000Z'),
      },
      rngSeed: 5,
    });

    for (let i = 0; i < 50; i++) {
      await insertRule(user.id, RULE_ROTATION[i % RULE_ROTATION.length]!);
    }

    const input: BreakdownQueryInput = {
      by: 'compliance',
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-31T00:00:00.000Z',
      tz: 'UTC',
    };

    // startTime is the service's own deadline anchor: if scoring overran 10s it
    // would throw TimeoutError and this test would reject, so a resolved result
    // is itself proof of the budget. The elapsed assertion documents it.
    const startTime = Date.now();
    const res = await getBreakdown(db, user.id, input, new AbortController().signal, startTime);
    const elapsed = Date.now() - startTime;

    expect(res.by).toBe('compliance');
    const cur = res.currencies.find((c) => c.code === 'USD')!;
    expect(cur.rows).toHaveLength(3);
    expect(sumPositions(cur.rows)).toBe(cur.total.totalPositions);
    expect(cur.total.totalPositions).toBe(5_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});
