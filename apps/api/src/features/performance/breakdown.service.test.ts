import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import {
  type BreakdownQueryInput,
  type BreakdownRow,
  type PerformanceQueryInput,
} from '@tradr/shared';

import { db } from '@/db';
import { accounts, fills, positionTags, tags, users } from '@/db/schema';
import { seedPositions } from '@/db/seed';
import { ClientAbortError, TimeoutError } from '@/lib/errors';

import { getBreakdown } from './breakdown.service';
import { getPerformance } from './performance.service';

let counter = 0;
function uniqueEmail() {
  return `breakdown-svc-${Date.now()}-${++counter}@example.com`;
}

async function createUser() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  return user!;
}

async function createAccount(userId: string, currency: string, name?: string) {
  const [account] = await db
    .insert(accounts)
    .values({ userId, name: name ?? `Acc-${currency}-${++counter}`, currency })
    .returning();
  return account!;
}

async function createTag(userId: string, name: string, category = 'general') {
  const [row] = await db.insert(tags).values({ userId, name, category }).returning();
  return row!;
}

interface SeedPositionOpts {
  symbol: string;
  side?: 'long' | 'short';
  assetType?: 'stock' | 'option';
  /** ISO instant of the flat close (drives both window membership and attribution). */
  closedAt: string;
  /** The latched net P&L; classifyOne reads it directly, so no fills are needed. */
  netPnl: string;
}

// Positions are inserted via raw SQL on purpose: db.insert(positions) is
// lint-forbidden outside the positions feature. last_flat_net_pnl is set and
// last_flat_at left null, so classifyOne reads netPnl from the latch and the
// flat instant from closed_at — deterministic without fill arithmetic.
async function insertClosedPosition(
  userId: string,
  accountId: string,
  opts: SeedPositionOpts,
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO positions
      (user_id, account_id, symbol, side, asset_type, status, opened_at, closed_at, last_flat_net_pnl)
    VALUES
      (${userId}, ${accountId}, ${opts.symbol}, ${opts.side ?? 'long'},
       ${opts.assetType ?? 'stock'}, 'closed',
       ${opts.closedAt}::timestamptz - interval '1 day', ${opts.closedAt}::timestamptz,
       ${opts.netPnl}::numeric)
    RETURNING id
  `);
  return result[0]!.id;
}

function breakdownInput(overrides: Partial<BreakdownQueryInput> = {}): BreakdownQueryInput {
  return {
    by: 'symbol',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-31T00:00:00.000Z',
    tz: 'UTC',
    ...overrides,
  };
}

function perfInput(overrides: Partial<PerformanceQueryInput> = {}): PerformanceQueryInput {
  return {
    granularity: 'day',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-31T00:00:00.000Z',
    tz: 'UTC',
    ...overrides,
  };
}

function freshController() {
  return new AbortController();
}

function sumPositions(rows: readonly BreakdownRow[]): number {
  return rows.reduce((n, r) => n + r.stats.totalPositions, 0);
}

function sumNet(rows: readonly BreakdownRow[]): Decimal {
  return rows.reduce((acc, r) => acc.plus(r.stats.totalNetPnl), new Decimal(0));
}

describe('getBreakdown', () => {
  // R3.6, R5.5: for the single-valued dimensions the rows partition the
  // population — counts and Decimal net sums both reconcile to `total`.
  describe('single-valued dimensions partition the population', () => {
    async function seedPartitionUser() {
      const user = await createUser();
      const usd = await createAccount(user.id, 'USD');
      // Five closed USD trades across four symbols, five weekdays, five hours.
      await insertClosedPosition(user.id, usd.id, {
        symbol: 'AAPL',
        closedAt: '2026-01-05T14:00:00.000Z', // Mon, 14:00
        netPnl: '100',
      });
      await insertClosedPosition(user.id, usd.id, {
        symbol: 'AAPL',
        closedAt: '2026-01-06T09:00:00.000Z', // Tue, 09:00
        netPnl: '50',
      });
      await insertClosedPosition(user.id, usd.id, {
        symbol: 'MSFT',
        closedAt: '2026-01-07T20:00:00.000Z', // Wed, 20:00
        netPnl: '-30',
      });
      await insertClosedPosition(user.id, usd.id, {
        symbol: 'NVDA',
        closedAt: '2026-01-08T02:00:00.000Z', // Thu, 02:00
        netPnl: '0',
      });
      await insertClosedPosition(user.id, usd.id, {
        symbol: 'TSLA',
        closedAt: '2026-01-09T23:00:00.000Z', // Fri, 23:00
        netPnl: '-10',
      });
      return user;
    }

    it('symbol rows sum to the total (counts and net P&L)', async () => {
      const user = await seedPartitionUser();
      const res = await getBreakdown(
        db,
        user.id,
        breakdownInput({ by: 'symbol' }),
        freshController().signal,
        Date.now(),
      );
      expect(res.by).toBe('symbol');
      expect(res.multiValued).toBe(false);
      const cur = res.currencies.find((c) => c.code === 'USD')!;
      expect(cur.total.totalPositions).toBe(5);
      expect(cur.total.totalNetPnl).toBe('110');
      expect(sumPositions(cur.rows)).toBe(cur.total.totalPositions);
      expect(sumNet(cur.rows).equals(new Decimal(cur.total.totalNetPnl))).toBe(true);
    });

    it('weekday has seven rows; zero-count rows carry totalPositions 0 and null rates', async () => {
      const user = await seedPartitionUser();
      const res = await getBreakdown(
        db,
        user.id,
        breakdownInput({ by: 'weekday' }),
        freshController().signal,
        Date.now(),
      );
      const cur = res.currencies.find((c) => c.code === 'USD')!;
      expect(cur.rows).toHaveLength(7);
      expect(sumPositions(cur.rows)).toBe(cur.total.totalPositions);
      expect(sumNet(cur.rows).equals(new Decimal(cur.total.totalNetPnl))).toBe(true);
      // Saturday (key '6') has no trades in the seed.
      const saturday = cur.rows.find((r) => r.key === '6')!;
      expect(saturday.stats.totalPositions).toBe(0);
      expect(saturday.stats.winRate).toBeNull();
      expect(saturday.stats.breakevenRate).toBeNull();
      expect(saturday.stats.expectancy).toBeNull();
    });

    it('hour has twenty-four rows; zero-count rows carry totalPositions 0 and null rates', async () => {
      const user = await seedPartitionUser();
      const res = await getBreakdown(
        db,
        user.id,
        breakdownInput({ by: 'hour' }),
        freshController().signal,
        Date.now(),
      );
      const cur = res.currencies.find((c) => c.code === 'USD')!;
      expect(cur.rows).toHaveLength(24);
      expect(sumPositions(cur.rows)).toBe(cur.total.totalPositions);
      expect(sumNet(cur.rows).equals(new Decimal(cur.total.totalNetPnl))).toBe(true);
      const midnight = cur.rows.find((r) => r.key === '0')!;
      expect(midnight.stats.totalPositions).toBe(0);
      expect(midnight.stats.winRate).toBeNull();
      expect(midnight.stats.breakevenRate).toBeNull();
    });
  });

  // R5.1–R5.5: tag is multi-valued; a position with N tags joins N groups, the
  // untagged group is always present, and the total matches the symbol total for
  // the same window (R5.5).
  it('tag overlaps, covers untagged, and totals equal the symbol total (R5.5)', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');
    const t1 = await createTag(user.id, 'Breakout');
    const t2 = await createTag(user.id, 'Earnings');

    const p1 = await insertClosedPosition(user.id, usd.id, {
      symbol: 'AAPL',
      closedAt: '2026-01-05T14:00:00.000Z',
      netPnl: '100',
    });
    const p2 = await insertClosedPosition(user.id, usd.id, {
      symbol: 'MSFT',
      closedAt: '2026-01-06T14:00:00.000Z',
      netPnl: '-40',
    });
    await insertClosedPosition(user.id, usd.id, {
      symbol: 'NVDA',
      closedAt: '2026-01-07T14:00:00.000Z',
      netPnl: '20',
    });
    await db.insert(positionTags).values([
      { positionId: p1, tagId: t1.id },
      { positionId: p2, tagId: t1.id },
      { positionId: p2, tagId: t2.id },
    ]);

    const tagRes = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'tag' }),
      freshController().signal,
      Date.now(),
    );
    expect(tagRes.multiValued).toBe(true);
    const cur = tagRes.currencies.find((c) => c.code === 'USD')!;

    const t1Row = cur.rows.find((r) => r.key === t1.id)!;
    const t2Row = cur.rows.find((r) => r.key === t2.id)!;
    const untagged = cur.rows.find((r) => r.key === 'untagged')!;
    // Overlap: p2 is in both t1 and t2.
    expect(t1Row.stats.totalPositions).toBe(2);
    expect(t2Row.stats.totalPositions).toBe(1);
    expect(t1Row.tag?.id).toBe(t1.id);
    expect(untagged.tag).toBeNull();
    // Untagged covers p3.
    expect(untagged.stats.totalPositions).toBe(1);

    // R5.5: tag total equals the symbol total for the same window.
    const symbolRes = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'symbol' }),
      freshController().signal,
      Date.now(),
    );
    const symbolCur = symbolRes.currencies.find((c) => c.code === 'USD')!;
    expect(cur.total).toEqual(symbolCur.total);
    expect(cur.total.totalPositions).toBe(3);
  });

  // R4.3, DD1: weekday and hour key on the flat instant in the reporting zone, so
  // the same positions land in different rows under a different timezone.
  it('moves positions to different weekday and hour rows under a different timezone', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');
    // 2026-01-05 20:00 UTC = Monday 20:00; in Asia/Tokyo (+9) it is
    // 2026-01-06 05:00 = Tuesday 05:00.
    await insertClosedPosition(user.id, usd.id, {
      symbol: 'AAPL',
      closedAt: '2026-01-05T20:00:00.000Z',
      netPnl: '100',
    });

    const utcWeekday = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'weekday', tz: 'UTC' }),
      freshController().signal,
      Date.now(),
    );
    const tokyoWeekday = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'weekday', tz: 'Asia/Tokyo' }),
      freshController().signal,
      Date.now(),
    );
    const utcW = utcWeekday.currencies.find((c) => c.code === 'USD')!.rows;
    const tokyoW = tokyoWeekday.currencies.find((c) => c.code === 'USD')!.rows;
    expect(utcW.find((r) => r.key === '1')!.stats.totalPositions).toBe(1); // Monday
    expect(utcW.find((r) => r.key === '2')!.stats.totalPositions).toBe(0); // Tuesday
    expect(tokyoW.find((r) => r.key === '1')!.stats.totalPositions).toBe(0);
    expect(tokyoW.find((r) => r.key === '2')!.stats.totalPositions).toBe(1);

    const utcHour = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'hour', tz: 'UTC' }),
      freshController().signal,
      Date.now(),
    );
    const tokyoHour = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'hour', tz: 'Asia/Tokyo' }),
      freshController().signal,
      Date.now(),
    );
    const utcH = utcHour.currencies.find((c) => c.code === 'USD')!.rows;
    const tokyoH = tokyoHour.currencies.find((c) => c.code === 'USD')!.rows;
    expect(utcH.find((r) => r.key === '20')!.stats.totalPositions).toBe(1);
    expect(tokyoH.find((r) => r.key === '20')!.stats.totalPositions).toBe(0);
    expect(tokyoH.find((r) => r.key === '5')!.stats.totalPositions).toBe(1);
  });

  // Defence in depth: the snapshot query joins tags user-scoped, so a
  // position_tags row pointing at another user's tag never surfaces it.
  it("never surfaces another user's tag", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const usdA = await createAccount(userA.id, 'USD');
    const foreignTag = await createTag(userB.id, 'ForeignTag');

    const p = await insertClosedPosition(userA.id, usdA.id, {
      symbol: 'AAPL',
      closedAt: '2026-01-05T14:00:00.000Z',
      netPnl: '100',
    });
    // Cross-user link — allowed by the FKs, rejected by the user-scoped join.
    await db.insert(positionTags).values({ positionId: p, tagId: foreignTag.id });

    const res = await getBreakdown(
      db,
      userA.id,
      breakdownInput({ by: 'tag' }),
      freshController().signal,
      Date.now(),
    );
    const cur = res.currencies.find((c) => c.code === 'USD')!;
    expect(cur.rows.some((r) => r.key === foreignTag.id)).toBe(false);
    expect(cur.rows.some((r) => r.label === 'ForeignTag')).toBe(false);
    // The position falls through to untagged.
    expect(cur.rows.find((r) => r.key === 'untagged')!.stats.totalPositions).toBe(1);
  });

  // DD4: the currency filter returns exactly the requested code, present or not.
  it('returns a present and an absent currency under the currency filter', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');
    await insertClosedPosition(user.id, usd.id, {
      symbol: 'AAPL',
      closedAt: '2026-01-05T14:00:00.000Z',
      netPnl: '100',
    });
    await insertClosedPosition(user.id, usd.id, {
      symbol: 'MSFT',
      closedAt: '2026-01-06T14:00:00.000Z',
      netPnl: '50',
    });

    const present = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'symbol', currency: 'USD' }),
      freshController().signal,
      Date.now(),
    );
    expect(present.currencies).toHaveLength(1);
    expect(present.currencies[0]!.code).toBe('USD');
    expect(present.currencies[0]!.total.totalPositions).toBe(2);

    const absent = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'symbol', currency: 'GBP' }),
      freshController().signal,
      Date.now(),
    );
    expect(absent.currencies).toHaveLength(1);
    expect(absent.currencies[0]!.code).toBe('GBP');
    expect(absent.currencies[0]!.total.totalPositions).toBe(0);
    expect(absent.currencies[0]!.rows).toEqual([]);
  });

  // D7: a position with only a fill in the window and a flat instant outside it
  // is counted by getPerformance's stats (whole-snapshot flat population) but is
  // dropped by the breakdown's flat-in-window filter.
  it('excludes the D7 boundary position that getPerformance counts', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');
    // In-window flat trade.
    await insertClosedPosition(user.id, usd.id, {
      symbol: 'AAPL',
      closedAt: '2026-01-20T12:00:00.000Z',
      netPnl: '100',
    });
    // Boundary: flat instant AFTER the window, but with a fill inside it.
    const boundary = await insertClosedPosition(user.id, usd.id, {
      symbol: 'BND',
      closedAt: '2026-02-05T00:00:00.000Z',
      netPnl: '50',
    });
    await db.insert(fills).values([
      {
        positionId: boundary,
        type: 'entry',
        price: '10',
        quantity: '100',
        filledAt: new Date('2026-01-15T00:00:00.000Z'),
      },
    ]);

    const perf = await getPerformance(
      db,
      user.id,
      perfInput(),
      freshController().signal,
      Date.now(),
    );
    const perfUsd = perf.currencies.find((c) => c.code === 'USD')!;
    // getPerformance counts BOTH: the boundary is a flat position in the snapshot.
    expect(perfUsd.stats.totalPositions).toBe(2);

    const bd = await getBreakdown(
      db,
      user.id,
      breakdownInput({ by: 'symbol' }),
      freshController().signal,
      Date.now(),
    );
    const bdUsd = bd.currencies.find((c) => c.code === 'USD')!;
    // The breakdown drops the boundary: flat-in-window is the only population.
    expect(bdUsd.total.totalPositions).toBe(1);
    expect(bdUsd.rows.some((r) => r.key === 'BND')).toBe(false);
  });

  it('propagates a client abort as ClientAbortError', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');
    await insertClosedPosition(user.id, usd.id, {
      symbol: 'AAPL',
      closedAt: '2026-01-05T14:00:00.000Z',
      netPnl: '100',
    });

    const controller = freshController();
    controller.abort(new ClientAbortError());

    await expect(
      getBreakdown(db, user.id, breakdownInput(), controller.signal, Date.now()),
    ).rejects.toBeInstanceOf(ClientAbortError);
  });

  // Real-timer deadline: the shared walk throws when Date.now() - startTime
  // exceeds TIMEOUT_MS (10_000). A startTime 9_950ms in the past leaves ~50ms.
  it('propagates the service deadline as TimeoutError', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');
    await seedPositions(db, {
      userId: user.id,
      accountId: usd.id,
      count: 3000,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-01T00:00:00.000Z'),
        end: new Date('2026-01-31T00:00:00.000Z'),
      },
      rngSeed: 7,
    });

    const startTime = Date.now() - 9_950;

    await expect(
      getBreakdown(db, user.id, breakdownInput(), freshController().signal, startTime),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});
