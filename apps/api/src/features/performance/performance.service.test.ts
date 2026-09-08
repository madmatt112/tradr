import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { PerformanceResponseSchema, type PerformanceQueryInput } from '@tradr/shared';

import { db } from '@/db';
import { accounts, positions, users } from '@/db/schema';
import { seedFills, seedPositions } from '@/db/seed';
import { InvalidTimezoneError, TimeoutError } from '@/lib/errors';

import { getPerformance } from './performance.service';

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
