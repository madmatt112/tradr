import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { PerformanceResponseSchema, type PerformanceQueryInput, type Tag } from '@tradr/shared';
import { symbolKey } from '@tradr/shared/lib/breakdown';

import { db } from '@/db';
import { accounts, fills, positions, users } from '@/db/schema';
import { seedFills, seedPositions } from '@/db/seed';
import { InvalidTimezoneError, TimeoutError } from '@/lib/errors';

import type { SnapshotPosition } from './performance.query';
import { classifyGroup, getPerformance } from './performance.service';

let counter = 0;
function uniqueEmail() {
  return `perf-svc-${Date.now()}-${++counter}@example.com`;
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
    .values({ userId, name: name ?? `Acc-${currency}-${counter}`, currency })
    .returning();
  return account!;
}

function defaultInput(overrides: Partial<PerformanceQueryInput> = {}): PerformanceQueryInput {
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

describe('getPerformance', () => {
  // (a) Six presets produce correct shape
  describe('six presets produce a valid PerformanceResponse shape', () => {
    const presets: Array<{ name: string; input: PerformanceQueryInput }> = [
      {
        name: 'Daily 30d',
        input: defaultInput({
          granularity: 'day',
          start: '2026-03-01T00:00:00.000Z',
          end: '2026-03-31T00:00:00.000Z',
        }),
      },
      {
        name: 'Weekly 12w',
        input: defaultInput({
          granularity: 'week',
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-03-26T00:00:00.000Z',
        }),
      },
      {
        name: 'Monthly 12m',
        input: defaultInput({
          granularity: 'month',
          start: '2025-04-01T00:00:00.000Z',
          end: '2026-04-01T00:00:00.000Z',
        }),
      },
      {
        name: 'Yearly',
        input: defaultInput({
          granularity: 'year',
          start: '2024-01-01T00:00:00.000Z',
          end: '2027-01-01T00:00:00.000Z',
        }),
      },
      {
        name: 'YTD',
        input: defaultInput({
          granularity: 'month',
          start: '2026-01-01T00:00:00.000Z',
          end: '2026-04-01T00:00:00.000Z',
        }),
      },
      {
        name: 'All-Time',
        input: defaultInput({
          granularity: 'month',
          start: '2024-01-01T00:00:00.000Z',
          end: '2026-04-01T00:00:00.000Z',
        }),
      },
    ];

    for (const preset of presets) {
      it(`${preset.name}`, async () => {
        const user = await createUser();
        const account = await createAccount(user.id, 'USD');
        await seedPositions(db, {
          userId: user.id,
          accountId: account.id,
          count: 10,
          status: 'closed',
          closedAtRange: {
            start: new Date(preset.input.start),
            end: new Date(preset.input.end),
          },
          rngSeed: 1,
        });

        const result = await getPerformance(
          db,
          user.id,
          preset.input,
          freshController().signal,
          Date.now(),
        );
        const parsed = PerformanceResponseSchema.safeParse(result);
        expect(parsed.success).toBe(true);
        expect(result.currencies).toHaveLength(1);
        expect(result.currencies[0]!.code).toBe('USD');
      });
    }
  });

  // (b) Multi-currency isolation
  it('isolates stats per currency when a user has positions in multiple currencies', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');
    const eur = await createAccount(user.id, 'EUR');

    await seedPositions(db, {
      userId: user.id,
      accountId: usd.id,
      count: 5,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-01-31T00:00:00Z'),
      },
      rngSeed: 11,
    });
    await seedPositions(db, {
      userId: user.id,
      accountId: eur.id,
      count: 3,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-01-31T00:00:00Z'),
      },
      rngSeed: 22,
    });

    const result = await getPerformance(
      db,
      user.id,
      defaultInput(),
      freshController().signal,
      Date.now(),
    );

    expect(result.currencies.map((c) => c.code).sort()).toEqual(['EUR', 'USD']);
    const usdEntry = result.currencies.find((c) => c.code === 'USD')!;
    const eurEntry = result.currencies.find((c) => c.code === 'EUR')!;
    expect(usdEntry.historyRange.totalClosedPositions).toBe(5);
    expect(eurEntry.historyRange.totalClosedPositions).toBe(3);
    expect(usdEntry.stats.totalPositions).toBe(5);
    expect(eurEntry.stats.totalPositions).toBe(3);
    // Expectancy is present on every currency entry (R7.1 / R7.2).
    for (const c of result.currencies) {
      expect(c.stats.expectancy).not.toBeNull();
    }
  });

  // (b2) Expectancy is the flat-population mean, NOT totalNetPnl ÷ totalPositions.
  // A still-open position with a partial exit realizes P&L into bucket B — moving
  // the series-summed totalNetPnl buildCurrencyEntry overrides — but never enters
  // the flat population expectancy is computed over. That is the D1 distinction.
  it('serves expectancy as the flat mean, distinct from totalNetPnl ÷ totalPositions on a partial exit (D1)', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');

    // Positions go in via raw SQL: db.insert(positions) is lint-forbidden outside
    // the positions feature (its audit/invariant layer). Map returned ids by
    // symbol — RETURNING order is not guaranteed to match the VALUES list.
    const inserted = await db.execute<{ id: string; symbol: string }>(sql`
      INSERT INTO positions (user_id, account_id, symbol, side, asset_type, status, opened_at, closed_at)
      VALUES
        (${user.id}, ${usd.id}, 'AAPL', 'long', 'stock', 'closed', '2026-01-05T00:00:00Z'::timestamptz, '2026-01-10T00:00:00Z'::timestamptz),
        (${user.id}, ${usd.id}, 'MSFT', 'long', 'stock', 'closed', '2026-01-06T00:00:00Z'::timestamptz, '2026-01-11T00:00:00Z'::timestamptz),
        (${user.id}, ${usd.id}, 'NVDA', 'long', 'stock', 'open',   '2026-01-07T00:00:00Z'::timestamptz, NULL)
      RETURNING id, symbol
    `);
    const idOf = (symbol: string) => inserted.find((r) => r.symbol === symbol)!.id;
    const win200Id = idOf('AAPL');
    const win100Id = idOf('MSFT');
    const openPartialId = idOf('NVDA');

    await db.insert(fills).values([
      // Closed +200: entry 100 @ 10, exit 100 @ 12.
      {
        positionId: win200Id,
        type: 'entry',
        price: '10',
        quantity: '100',
        filledAt: new Date('2026-01-09T00:00:00Z'),
      },
      {
        positionId: win200Id,
        type: 'exit',
        price: '12',
        quantity: '100',
        filledAt: new Date('2026-01-10T00:00:00Z'),
      },
      // Closed +100: entry 100 @ 10, exit 100 @ 11.
      {
        positionId: win100Id,
        type: 'entry',
        price: '10',
        quantity: '100',
        filledAt: new Date('2026-01-09T00:00:00Z'),
      },
      {
        positionId: win100Id,
        type: 'exit',
        price: '11',
        quantity: '100',
        filledAt: new Date('2026-01-11T00:00:00Z'),
      },
      // Still-open partial exit +200: entry 100 @ 10, exit 50 @ 14.
      {
        positionId: openPartialId,
        type: 'entry',
        price: '10',
        quantity: '100',
        filledAt: new Date('2026-01-08T00:00:00Z'),
      },
      {
        positionId: openPartialId,
        type: 'exit',
        price: '14',
        quantity: '50',
        filledAt: new Date('2026-01-12T00:00:00Z'),
      },
    ]);

    const result = await getPerformance(
      db,
      user.id,
      defaultInput(),
      freshController().signal,
      Date.now(),
    );

    const usdEntry = result.currencies.find((c) => c.code === 'USD')!;
    for (const c of result.currencies) {
      expect(c.stats.expectancy).not.toBeNull();
    }
    // Flat population is the two closed trades: (200 + 100) / 2 = 150.
    expect(usdEntry.stats.totalPositions).toBe(2);
    expect(usdEntry.stats.expectancy).toBe('150');
    // Bucket B carries the partial exit too: totalNetPnl = 200 + 100 + 200 = 500,
    // so totalNetPnl ÷ totalPositions = 250, which expectancy must NOT be.
    expect(usdEntry.stats.totalNetPnl).toBe('500');
    const naive = new Decimal(usdEntry.stats.totalNetPnl)
      .div(usdEntry.stats.totalPositions)
      .toString();
    expect(usdEntry.stats.expectancy).not.toBe(naive);
  });

  // (c) Zero closed positions
  it('returns empty currencies and null defaultCurrency for a user with no closed positions', async () => {
    const user = await createUser();

    const result = await getPerformance(
      db,
      user.id,
      defaultInput(),
      freshController().signal,
      Date.now(),
    );

    expect(result.hasAnyAccounts).toBe(false);
    expect(result.hasAnyClosedPositions).toBe(false);
    expect(result.hasAnyClosedPositionsInSupportedCurrency).toBe(false);
    expect(result.currencies).toEqual([]);
    expect(result.defaultCurrency).toBeNull();
  });

  // (d) Unsupported-currency-only user
  it('flags hasAnyClosedPositionsInSupportedCurrency=false when all closed positions are in an unsupported currency', async () => {
    const user = await createUser();
    const xyz = await createAccount(user.id, 'XYZ', 'XYZ Account');

    await seedPositions(db, {
      userId: user.id,
      accountId: xyz.id,
      count: 2,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-05T00:00:00Z'),
        end: new Date('2026-01-15T00:00:00Z'),
      },
      rngSeed: 5,
    });

    const result = await getPerformance(
      db,
      user.id,
      defaultInput(),
      freshController().signal,
      Date.now(),
    );

    expect(result.hasAnyAccounts).toBe(true);
    expect(result.hasAnyClosedPositions).toBe(true);
    expect(result.hasAnyClosedPositionsInSupportedCurrency).toBe(false);
    expect(result.currencies).toEqual([]);
    expect(result.defaultCurrency).toBeNull();
  });

  // (e) dataQuality invariants — unsupported + mismatch overlap row
  it('counts an overlap row in BOTH per-reason buckets but as ONE distinct total', async () => {
    const userA = await createUser();
    const userB = await createUser();
    // userB owns an unsupported-currency account; we attach a position whose
    // user_id is userA → unsupported AND mismatched simultaneously.
    const otherUsersUnsupportedAccount = await createAccount(userB.id, 'XYZ', 'B-XYZ');

    const closedAt = new Date('2026-01-10T12:00:00Z');
    // Direct insert is intentional: this test seeds a cross-user mismatch row that
    // the positions service would reject by design. Negative-path coverage only.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId: userA.id,
      accountId: otherUsersUnsupportedAccount.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      openedAt: new Date('2026-01-09T12:00:00Z'),
      closedAt,
    });

    const result = await getPerformance(
      db,
      userA.id,
      defaultInput(),
      freshController().signal,
      Date.now(),
    );

    expect(result.dataQuality.timeframeExcluded.total).toBe(1);
    expect(result.dataQuality.timeframeExcluded.unsupported).toBe(1);
    expect(result.dataQuality.timeframeExcluded.mismatch).toBe(1);
  });

  // (f) defaultCurrency tie-break at each level
  describe('defaultCurrency tie-break ordering', () => {
    it('picks the currency with the most recent closed_at', async () => {
      const user = await createUser();
      const usd = await createAccount(user.id, 'USD');
      const eur = await createAccount(user.id, 'EUR');

      // Direct insert is intentional: tie-break test needs identical-microsecond
      // closed_at values across two currencies, which the positions service does not expose.
      // eslint-disable-next-line no-restricted-syntax
      await db.insert(positions).values([
        {
          userId: user.id,
          accountId: usd.id,
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          status: 'closed',
          openedAt: new Date('2026-01-01T00:00:00Z'),
          closedAt: new Date('2026-01-02T00:00:00Z'),
        },
        {
          userId: user.id,
          accountId: eur.id,
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          status: 'closed',
          openedAt: new Date('2026-01-01T00:00:00Z'),
          closedAt: new Date('2026-01-20T00:00:00Z'),
        },
      ]);

      const result = await getPerformance(
        db,
        user.id,
        defaultInput(),
        freshController().signal,
        Date.now(),
      );
      expect(result.defaultCurrency).toBe('EUR');
    });

    it('breaks ties by total count when most-recent timestamps match', async () => {
      const user = await createUser();
      const usd = await createAccount(user.id, 'USD');
      const eur = await createAccount(user.id, 'EUR');
      const sharedClose = new Date('2026-01-10T12:00:00.000Z');
      const earlier = new Date('2026-01-05T12:00:00.000Z');

      // Direct insert is intentional: tie-break across two currencies at identical
      // closed_at; the positions service does not expose closed_at directly.
      // eslint-disable-next-line no-restricted-syntax
      await db.insert(positions).values([
        {
          userId: user.id,
          accountId: usd.id,
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          status: 'closed',
          openedAt: earlier,
          closedAt: sharedClose,
        },
        {
          userId: user.id,
          accountId: eur.id,
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          status: 'closed',
          openedAt: earlier,
          closedAt: sharedClose,
        },
        {
          userId: user.id,
          accountId: eur.id,
          symbol: 'MSFT',
          side: 'long',
          assetType: 'stock',
          status: 'closed',
          openedAt: earlier,
          closedAt: earlier,
        },
      ]);

      const result = await getPerformance(
        db,
        user.id,
        defaultInput(),
        freshController().signal,
        Date.now(),
      );
      expect(result.defaultCurrency).toBe('EUR');
    });

    it('breaks ties lexicographically when most-recent and counts both match (identical-microsecond closed_at via raw SQL)', async () => {
      const user = await createUser();
      const eur = await createAccount(user.id, 'EUR');
      const usd = await createAccount(user.id, 'USD');

      // Use raw SQL to set identical microsecond-precision closed_at across
      // both currencies. Postgres's timestamptz preserves microseconds even
      // when literals share a millisecond — equality requires byte-for-byte
      // identical text. Build the timestamps in one statement.
      await db.execute(sql`
        INSERT INTO positions (user_id, account_id, symbol, side, asset_type, status, opened_at, closed_at)
        VALUES
          (${user.id}, ${usd.id}, 'AAPL', 'long', 'stock', 'closed', '2026-01-09T12:00:00.123456Z'::timestamptz, '2026-01-10T12:00:00.123456Z'::timestamptz),
          (${user.id}, ${eur.id}, 'AAPL', 'long', 'stock', 'closed', '2026-01-09T12:00:00.123456Z'::timestamptz, '2026-01-10T12:00:00.123456Z'::timestamptz)
      `);

      const result = await getPerformance(
        db,
        user.id,
        defaultInput(),
        freshController().signal,
        Date.now(),
      );
      // localeCompare('EUR', 'USD') < 0 → EUR wins on lex tie-break
      expect(result.defaultCurrency).toBe('EUR');
    });
  });

  // (g) REQ-3.7 — series.length === equityCurve.length, index-matched bucketStart, decimal re-sum
  it('preserves REQ-3.7 invariants between series and equityCurve', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');

    const seeded = await seedPositions(db, {
      userId: user.id,
      accountId: usd.id,
      count: 6,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-02T00:00:00Z'),
        end: new Date('2026-01-20T00:00:00Z'),
      },
      rngSeed: 33,
    });
    for (let i = 0; i < seeded.length; i++) {
      await seedFills(db, {
        positionId: seeded[i]!.id,
        count: 4,
        rngSeed: 100 + i,
      });
    }

    const result = await getPerformance(
      db,
      user.id,
      defaultInput({
        granularity: 'day',
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-31T00:00:00.000Z',
      }),
      freshController().signal,
      Date.now(),
    );

    const cur = result.currencies.find((c) => c.code === 'USD')!;
    expect(cur.series.length).toBe(cur.equityCurve.length);

    let cumulative = new Decimal(0);
    for (let i = 0; i < cur.series.length; i++) {
      expect(cur.equityCurve[i]!.bucketStart).toBe(cur.series[i]!.bucketStart);
      cumulative = cumulative.plus(new Decimal(cur.series[i]!.netPnl));
      expect(new Decimal(cur.equityCurve[i]!.cumulativeNetPnl).equals(cumulative)).toBe(true);
    }
  });

  // (h) InvalidTimezoneError for a Unicode-extension ID and a non-zone string
  describe('rejects invalid timezones with InvalidTimezoneError', () => {
    it.each(['America/New_York-u-ca-japanese', 'NotAZone'])('%s', async (tz) => {
      const user = await createUser();
      const promise = getPerformance(
        db,
        user.id,
        defaultInput({ tz }),
        freshController().signal,
        Date.now(),
      );
      await expect(promise).rejects.toBeInstanceOf(InvalidTimezoneError);
    });
  });

  // (i) Local wall-clock deadline with REAL timers — TimeoutError thrown when
  // the service's own `Date.now() - startTime > TIMEOUT_MS` check fires.
  it('throws TimeoutError when the service deadline is exceeded mid-loop (real timers)', async () => {
    const user = await createUser();
    const usd = await createAccount(user.id, 'USD');

    // Seed enough positions that the chunked loop performs real work past the
    // effective deadline. No fills are needed — `classifyOne` against an empty
    // fills array still does Decimal arithmetic per position, which is what
    // we want to time. Lighter setup keeps the whole `it()` under 500ms.
    await seedPositions(db, {
      userId: user.id,
      accountId: usd.id,
      count: 3000,
      status: 'closed',
      closedAtRange: {
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-01-31T00:00:00Z'),
      },
      rngSeed: 7,
    });

    // Service deadline is `Date.now() - startTime > TIMEOUT_MS` where
    // TIMEOUT_MS = 10_000. Pass a startTime 9_950ms in the past so the
    // effective remaining deadline is ~50ms — analogous to the spec's
    // "mount the timeout middleware with ms: 100" guidance for a route
    // test, but tuned for the unit-test path where the loop runs as soon
    // as the snapshot fetch returns.
    const startTime = Date.now() - 9_950;

    await expect(
      getPerformance(db, user.id, defaultInput(), freshController().signal, startTime),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

/**
 * classifyGroup (design C8 — multi-leg-positions task 8). Pure function: one
 * `BreakdownPosition` per group, derived fresh from each leg's own latch via
 * `classifyOne`, never from stored group state.
 *
 * Contract block — one entry per success criterion this suite covers.
 *
 * AC 5.1 (a closed two-leg group gives one combined entry)
 *   Pre: two flat legs sharing a groupId, their own flat latches at distinct
 *     instants.
 *   Call: classifyGroup([legA, legB]).
 *   Result: one BreakdownPosition; closedAt the LATER leg's flat instant;
 *     netPnl the sum of both legs' own last-flat figures; fees equal
 *     grossPnl minus netPnl; classification derived from that netPnl.
 *   Source: requirements.md AC 5.1; design.md C8 post-conditions.
 *
 * design C8's null guard, the mechanism behind AC 5.2
 *   Pre: one flat leg, one leg with no flat latch and a live 'open' status.
 *   Call: classifyGroup([legFlat, legNeverFlat]).
 *   Result: null — `classifyOne` is null for the never-flat leg, so the pair
 *     is not yet a completed trade. (This is the mechanism the integration
 *     suite's AC 5.2 test in performance.test.ts relies on to keep a lone
 *     flat leg from counting alone.)
 *   Source: design.md C8 ("classifyGroup returns null unless classifyOne is
 *     non-null for every leg").
 *
 * AC 5.8 (symbol/assetType from the first leg; tags the distinct union; legIds the legs)
 *   Pre: two flat legs with different symbols/assetTypes and overlapping tag sets.
 *   Call: classifyGroup([legA, legB]).
 *   Result: symbol/assetType equal the FIRST leg's own fields (so symbolKey
 *     keys the underlying from legA's symbol, never legB's); tags the
 *     distinct union by id; legIds the two leg ids.
 *   Source: requirements.md AC 5.8; design.md C8 post-conditions.
 */
describe('classifyGroup', () => {
  function tag(id: string, name: string): Tag {
    return { id, name, category: 'general', color: null };
  }

  // Loosely typed on purpose: `groupId` is not yet a field of
  // `SnapshotPosition` before this task's implementation lands it, and this
  // helper must compile and build a usable fixture either way.
  function buildLeg(overrides: Record<string, unknown> & { id: string }): SnapshotPosition {
    return {
      side: 'long',
      assetType: 'option',
      symbol: 'AAPL250320C150',
      currency: 'USD',
      closedAt: null,
      status: 'open',
      lastFlatAt: null,
      lastFlatNetPnl: null,
      fills: [],
      tags: [],
      ...overrides,
    } as unknown as SnapshotPosition;
  }

  it('sums figures and dates at the latest leg flat for a closed two-leg group (AC 5.1)', () => {
    const legA = buildLeg({
      id: 'leg-a',
      groupId: 'group-1',
      symbol: 'AAPL250320C150',
      side: 'long',
      status: 'closed',
      closedAt: '2026-01-10T00:00:00.000Z',
      lastFlatAt: '2026-01-10T00:00:00.000Z',
      lastFlatNetPnl: '200',
    });
    const legB = buildLeg({
      id: 'leg-b',
      groupId: 'group-1',
      symbol: 'AAPL250320C155',
      side: 'short',
      status: 'closed',
      closedAt: '2026-01-12T00:00:00.000Z',
      lastFlatAt: '2026-01-12T00:00:00.000Z',
      lastFlatNetPnl: '100',
    });

    const group = classifyGroup([legA, legB]);

    expect(group).not.toBeNull();
    expect(group!.id).toBe('group-1');
    expect(group!.closedAt.toISOString()).toBe('2026-01-12T00:00:00.000Z');
    expect(group!.netPnl.toString()).toBe('300');
    expect(group!.classification).toBe('winning');
    expect(group!.fees.equals(group!.grossPnl.minus(group!.netPnl))).toBe(true);
  });

  it('returns null unless every leg is currently flat', () => {
    const legFlat = buildLeg({
      id: 'leg-a',
      groupId: 'group-2',
      status: 'closed',
      closedAt: '2026-01-10T00:00:00.000Z',
      lastFlatAt: '2026-01-10T00:00:00.000Z',
      lastFlatNetPnl: '200',
    });
    const legNeverFlat = buildLeg({
      id: 'leg-b',
      groupId: 'group-2',
      status: 'open',
      closedAt: null,
      lastFlatAt: null,
      lastFlatNetPnl: null,
      fills: [
        {
          type: 'entry',
          price: '5',
          quantity: '1',
          fees: '0',
          filledAt: '2026-01-05T00:00:00.000Z',
        },
      ],
    });

    expect(classifyGroup([legFlat, legNeverFlat])).toBeNull();
  });

  it('takes symbol and assetType from the first leg and unions tags and legIds (AC 5.8)', () => {
    const tagX = tag('11111111-1111-1111-1111-111111111111', 'Tag X');
    const tagY = tag('22222222-2222-2222-2222-222222222222', 'Tag Y');
    const legA = buildLeg({
      id: 'leg-a',
      groupId: 'group-3',
      symbol: 'AAPL250320C150',
      assetType: 'option',
      status: 'closed',
      closedAt: '2026-01-10T00:00:00.000Z',
      lastFlatAt: '2026-01-10T00:00:00.000Z',
      lastFlatNetPnl: '200',
      tags: [tagX],
    });
    const legB = buildLeg({
      id: 'leg-b',
      groupId: 'group-3',
      symbol: 'MSFT',
      assetType: 'stock',
      status: 'closed',
      closedAt: '2026-01-12T00:00:00.000Z',
      lastFlatAt: '2026-01-12T00:00:00.000Z',
      lastFlatNetPnl: '100',
      tags: [tagX, tagY],
    });

    const group = classifyGroup([legA, legB]);

    expect(group).not.toBeNull();
    expect(group!.symbol).toBe(legA.symbol);
    expect(group!.assetType).toBe(legA.assetType);
    expect(symbolKey(group!)).toBe('AAPL');
    expect(group!.tags.map((t) => t.id).sort()).toEqual([tagX.id, tagY.id].sort());
    expect(group!.legIds?.slice().sort()).toEqual(['leg-a', 'leg-b']);
  });
});
