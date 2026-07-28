import { eq, asc } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';

import { db } from '@/db';
import { accounts, fills, users } from '@/db/schema';

import { seedFills } from './fills.seed';
import { seedPositions } from './positions.seed';

let counter = 0;
function uniqueEmail() {
  return `seed-test-${Date.now()}-${++counter}@example.com`;
}

async function createUserAndAccount(currency = 'USD') {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user.id, name: `Acc-${user.id.slice(0, 8)}`, currency })
    .returning();
  return { user, account };
}

function strip(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id' || k === 'createdAt' || k === 'updatedAt') continue;
    out[k] = v;
  }
  return out;
}

describe('seedPositions', () => {
  let userId: string;
  let accountId: string;

  beforeEach(async () => {
    const { user, account } = await createUserAndAccount();
    userId = user.id;
    accountId = account.id;
  });

  it('produces identical row data for the same seed and count', async () => {
    const rows1 = await seedPositions(db, { userId, accountId, count: 10, rngSeed: 42 });

    const { user: u2, account: a2 } = await createUserAndAccount();
    const rows2 = await seedPositions(db, {
      userId: u2.id,
      accountId: a2.id,
      count: 10,
      rngSeed: 42,
    });

    const normalize = (rows: typeof rows1, uid: string, aid: string) =>
      rows.map((r) => {
        const stripped = strip(r as unknown as Record<string, unknown>) as Record<string, unknown>;
        stripped.userId = stripped.userId === uid ? '<USER>' : stripped.userId;
        stripped.accountId = stripped.accountId === aid ? '<ACCOUNT>' : stripped.accountId;
        return stripped;
      });

    expect(JSON.stringify(normalize(rows1, userId, accountId))).toBe(
      JSON.stringify(normalize(rows2, u2.id, a2.id)),
    );
  });

  it('respects the closed-status CHECK constraint (closed_at NOT NULL when status = closed)', async () => {
    const rows = await seedPositions(db, {
      userId,
      accountId,
      count: 25,
      status: 'closed',
      rngSeed: 7,
    });

    expect(rows.length).toBe(25);
    for (const row of rows) {
      expect(row.status).toBe('closed');
      expect(row.closedAt).not.toBeNull();
    }
  });

  it('honors closedAtRange bounds', async () => {
    const start = new Date('2026-02-01T00:00:00.000Z');
    const end = new Date('2026-02-15T00:00:00.000Z');
    const rows = await seedPositions(db, {
      userId,
      accountId,
      count: 20,
      status: 'closed',
      closedAtRange: { start, end },
      rngSeed: 99,
    });

    for (const row of rows) {
      const t = row.closedAt!.getTime();
      expect(t).toBeGreaterThanOrEqual(start.getTime());
      expect(t).toBeLessThan(end.getTime());
    }
  });
});

describe('seedFills', () => {
  let positionId: string;

  beforeEach(async () => {
    const { user, account } = await createUserAndAccount();
    const [pos] = await seedPositions(db, {
      userId: user.id,
      accountId: account.id,
      count: 1,
      status: 'closed',
      rngSeed: 1,
    });
    positionId = pos.id;
  });

  it('orders all entry fills strictly before all exit fills', async () => {
    await seedFills(db, {
      positionId,
      count: 8,
      typeDistribution: { entry: 0.5, exit: 0.5 },
      rngSeed: 5,
    });

    const rows = await db
      .select()
      .from(fills)
      .where(eq(fills.positionId, positionId))
      .orderBy(asc(fills.filledAt));

    const entries = rows.filter((r) => r.type === 'entry');
    const exits = rows.filter((r) => r.type === 'exit');
    expect(entries.length).toBeGreaterThan(0);
    expect(exits.length).toBeGreaterThan(0);

    const lastEntry = Math.max(...entries.map((r) => r.filledAt.getTime()));
    const firstExit = Math.min(...exits.map((r) => r.filledAt.getTime()));
    expect(lastEntry).toBeLessThan(firstExit);
  });

  it('produces identical fill data across runs with the same seed', async () => {
    const fills1 = await seedFills(db, {
      positionId,
      count: 6,
      typeDistribution: { entry: 0.5, exit: 0.5 },
      rngSeed: 13,
    });

    const { user, account } = await createUserAndAccount();
    const [pos2] = await seedPositions(db, {
      userId: user.id,
      accountId: account.id,
      count: 1,
      status: 'closed',
      rngSeed: 1,
    });
    const fills2 = await seedFills(db, {
      positionId: pos2.id,
      count: 6,
      typeDistribution: { entry: 0.5, exit: 0.5 },
      rngSeed: 13,
    });

    const normalize = (rows: typeof fills1, pid: string) =>
      rows.map((r) => {
        const stripped = strip(r as unknown as Record<string, unknown>) as Record<string, unknown>;
        stripped.positionId = stripped.positionId === pid ? '<POS>' : stripped.positionId;
        return stripped;
      });

    expect(JSON.stringify(normalize(fills1, positionId))).toBe(
      JSON.stringify(normalize(fills2, pos2.id)),
    );
  });
});
