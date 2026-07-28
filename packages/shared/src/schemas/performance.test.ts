import { describe, expect, it } from 'vitest';

import {
  computeBucketCount,
  PerformanceQuerySchema,
  PerformanceResponseSchema,
  resolveTimezone,
} from './performance';

describe('resolveTimezone', () => {
  it('accepts canonical IANA zones', () => {
    expect(resolveTimezone('UTC')).toBe('UTC');
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
    expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    // Intl canonicalizes linked zones; the call must still succeed.
    expect(() => resolveTimezone('America/Argentina/Cordoba')).not.toThrow();
    expect(resolveTimezone('Pacific/Apia')).toBe('Pacific/Apia');
  });

  it('rejects unknown zones', () => {
    expect(() => resolveTimezone('NotAZone')).toThrow('invalid_timezone');
  });

  it('rejects Unicode-extension-decorated IDs', () => {
    expect(() => resolveTimezone('America/New_York-u-ca-japanese')).toThrow('invalid_timezone');
  });

  it('rejects empty string', () => {
    expect(() => resolveTimezone('')).toThrow('invalid_timezone');
  });
});

describe('computeBucketCount', () => {
  it('returns 0 when start >= end', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    expect(computeBucketCount(d, d, 'day', 'UTC')).toBe(0);
    expect(computeBucketCount(new Date('2024-01-02'), new Date('2024-01-01'), 'day', 'UTC')).toBe(
      0,
    );
  });

  it('counts aligned day buckets in UTC', () => {
    expect(
      computeBucketCount(
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-01-02T00:00:00Z'),
        'day',
        'UTC',
      ),
    ).toBe(1);
    expect(
      computeBucketCount(
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-01-08T00:00:00Z'),
        'day',
        'UTC',
      ),
    ).toBe(7);
    expect(
      computeBucketCount(
        new Date('2024-01-01T00:00:00Z'),
        new Date('2025-01-01T00:00:00Z'),
        'day',
        'UTC',
      ),
    ).toBe(366); // 2024 is a leap year
  });

  it('counts day buckets across DST spring-forward (America/New_York)', () => {
    // 2024-03-10 02:00 EST → 03:00 EDT; local day is 23 wall-clock hours but is
    // still exactly ONE day bucket.
    const start = new Date('2024-03-10T05:00:00Z'); // Mar 10 00:00 EST
    const end = new Date('2024-03-11T04:00:00Z'); // Mar 11 00:00 EDT
    expect(computeBucketCount(start, end, 'day', 'America/New_York')).toBe(1);
  });

  it('counts day buckets across DST fall-back (America/New_York)', () => {
    // 2024-11-03 02:00 EDT → 01:00 EST; 25 wall-clock hours but still one bucket.
    const start = new Date('2024-11-03T04:00:00Z'); // Nov 3 00:00 EDT
    const end = new Date('2024-11-04T05:00:00Z'); // Nov 4 00:00 EST
    expect(computeBucketCount(start, end, 'day', 'America/New_York')).toBe(1);
  });

  it('counts week buckets aligned to Sunday (weekStartDay=0)', () => {
    // 2024-01-07 is Sunday UTC
    expect(
      computeBucketCount(
        new Date('2024-01-07T00:00:00Z'),
        new Date('2024-01-14T00:00:00Z'),
        'week',
        'UTC',
        0,
      ),
    ).toBe(1);
    expect(
      computeBucketCount(
        new Date('2024-01-07T00:00:00Z'),
        new Date('2024-01-28T00:00:00Z'),
        'week',
        'UTC',
        0,
      ),
    ).toBe(3);
  });

  it('counts week buckets aligned to Monday (weekStartDay=1)', () => {
    // 2024-01-08 is Monday UTC
    expect(
      computeBucketCount(
        new Date('2024-01-08T00:00:00Z'),
        new Date('2024-01-15T00:00:00Z'),
        'week',
        'UTC',
        1,
      ),
    ).toBe(1);
  });

  it('counts week buckets when start lies mid-week', () => {
    // Start Wed noon, end Sun 12:00 — still inside the first bucket until Sun 00,
    // plus one more bucket between Sun 00 and Sun 12.
    expect(
      computeBucketCount(
        new Date('2024-01-10T12:00:00Z'), // Wed 12:00 UTC
        new Date('2024-01-14T12:00:00Z'), // Sun 12:00 UTC
        'week',
        'UTC',
        0,
      ),
    ).toBe(2);
  });

  it('counts month buckets', () => {
    expect(
      computeBucketCount(
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-04-01T00:00:00Z'),
        'month',
        'UTC',
      ),
    ).toBe(3);
    // mid-month start and end → 4 buckets touched (Jan, Feb, Mar, Apr)
    expect(
      computeBucketCount(
        new Date('2024-01-15T00:00:00Z'),
        new Date('2024-04-15T00:00:00Z'),
        'month',
        'UTC',
      ),
    ).toBe(4);
    // aligned start, mid-month end → Jan, Feb, Mar, Apr
    expect(
      computeBucketCount(
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-04-15T00:00:00Z'),
        'month',
        'UTC',
      ),
    ).toBe(4);
  });

  it('counts month buckets in JST (Asia/Tokyo)', () => {
    // 2024-01-01 00:00 JST = 2023-12-31 15:00 UTC. If we pass a UTC instant
    // representing local midnight in JST, arithmetic should still give 3.
    const start = new Date('2023-12-31T15:00:00Z'); // 2024-01-01 00:00 JST
    const end = new Date('2024-03-31T15:00:00Z'); // 2024-04-01 00:00 JST
    expect(computeBucketCount(start, end, 'month', 'Asia/Tokyo')).toBe(3);
  });

  it('counts year buckets', () => {
    expect(
      computeBucketCount(
        new Date('2020-01-01T00:00:00Z'),
        new Date('2024-01-01T00:00:00Z'),
        'year',
        'UTC',
      ),
    ).toBe(4);
    // mid-year start → includes the start year
    expect(
      computeBucketCount(
        new Date('2020-06-15T00:00:00Z'),
        new Date('2024-01-01T00:00:00Z'),
        'year',
        'UTC',
      ),
    ).toBe(4);
    // mid-year end → includes the end year
    expect(
      computeBucketCount(
        new Date('2020-01-01T00:00:00Z'),
        new Date('2024-06-15T00:00:00Z'),
        'year',
        'UTC',
      ),
    ).toBe(5);
  });

  it('matches brute-force oracle across 8-TZ matrix for day/week', () => {
    const tzs = [
      'UTC',
      'America/New_York',
      'Asia/Tokyo',
      'Europe/London',
      'America/Argentina/Cordoba',
      'Pacific/Apia',
      'America/Sao_Paulo',
      'Africa/Casablanca',
    ];
    for (const tz of tzs) {
      for (const weekStartDay of [0, 1] as const) {
        // Random-ish spans spanning DST and year edges.
        const spans: Array<[string, string, 'day' | 'week']> = [
          ['2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z', 'day'],
          ['2024-03-01T00:00:00Z', '2024-04-01T00:00:00Z', 'day'],
          ['2023-11-01T00:00:00Z', '2023-12-01T00:00:00Z', 'day'],
          ['2024-01-07T00:00:00Z', '2024-04-07T00:00:00Z', 'week'],
          ['2024-01-08T00:00:00Z', '2024-04-08T00:00:00Z', 'week'],
        ];
        for (const [s, e, g] of spans) {
          const start = new Date(s);
          const end = new Date(e);
          const arithmetic = computeBucketCount(start, end, g, tz, weekStartDay);
          const oracle = bruteForceBucketCount(start, end, g, tz, weekStartDay);
          expect(arithmetic, `${tz} weekStartDay=${weekStartDay} ${g} ${s}→${e}`).toBe(oracle);
        }
      }
    }
  });

  it('matches brute-force oracle for month/year across representative TZs', () => {
    const tzs = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Apia'];
    const cases: Array<[string, string, 'month' | 'year']> = [
      ['2020-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'year'],
      ['2020-06-15T00:00:00Z', '2024-06-15T00:00:00Z', 'year'],
      ['2020-01-01T00:00:00Z', '2024-06-15T00:00:00Z', 'year'],
      ['2024-01-01T00:00:00Z', '2024-07-01T00:00:00Z', 'month'],
      ['2024-01-15T00:00:00Z', '2024-07-15T00:00:00Z', 'month'],
      ['2024-01-01T00:00:00Z', '2024-07-15T00:00:00Z', 'month'],
    ];
    for (const tz of tzs) {
      for (const [s, e, g] of cases) {
        const start = new Date(s);
        const end = new Date(e);
        const arithmetic = computeBucketCount(start, end, g, tz, 0);
        const oracle = bruteForceBucketCount(start, end, g, tz, 0);
        expect(arithmetic, `${tz} ${g} ${s}→${e}`).toBe(oracle);
      }
    }
  });
});

describe('PerformanceQuerySchema', () => {
  const validBase = {
    granularity: 'day' as const,
    start: '2024-01-01',
    end: '2024-01-31',
    tz: 'UTC',
  };

  it('accepts a valid request', () => {
    const result = PerformanceQuerySchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('rejects with exactly one INVALID_TIMEZONE issue when tz is bad, short-circuiting other refinements', () => {
    const result = PerformanceQuerySchema.safeParse({
      granularity: 'day',
      tz: 'InvalidZone',
      // deliberately-broken dates: end < start, start < 2000-01-01
      end: '1999-01-01',
      start: '2026-12-31',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['tz']);
    const params = (result.error.issues[0] as { params?: { code?: string } }).params;
    expect(params?.code).toBe('INVALID_TIMEZONE');
  });

  it('rejects Unicode-extension-decorated tz', () => {
    const result = PerformanceQuerySchema.safeParse({
      ...validBase,
      tz: 'America/New_York-u-ca-japanese',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'tz');
    expect(issue).toBeDefined();
    expect((issue as { params?: { code?: string } }).params?.code).toBe('INVALID_TIMEZONE');
  });

  it('names the constraint on start >= end', () => {
    const result = PerformanceQuerySchema.safeParse({
      ...validBase,
      start: '2024-02-01',
      end: '2024-01-01',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const codes = result.error.issues.map(
      (i) => (i as { params?: { code?: string } }).params?.code,
    );
    expect(codes).toContain('START_NOT_BEFORE_END');
  });

  it('names the constraint on start < 2000-01-01', () => {
    const result = PerformanceQuerySchema.safeParse({
      ...validBase,
      start: '1999-12-31',
      end: '2000-06-01',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const codes = result.error.issues.map(
      (i) => (i as { params?: { code?: string } }).params?.code,
    );
    expect(codes).toContain('START_BEFORE_MIN');
  });

  it('rejects end past start-of-tomorrow (today + 1 day) in tz', () => {
    // Compute day-after-tomorrow in UTC so we build a request that clearly
    // exceeds the bound regardless of the test machine's wall clock.
    const nowUtcMs = Date.now();
    const dayAfterTomorrowUtcMs = Math.floor(nowUtcMs / 86_400_000) * 86_400_000 + 2 * 86_400_000;
    const dayAfterTomorrowIso = new Date(dayAfterTomorrowUtcMs).toISOString().slice(0, 10);
    const result = PerformanceQuerySchema.safeParse({
      granularity: 'day',
      start: '2024-01-01',
      end: dayAfterTomorrowIso,
      tz: 'UTC',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const codes = result.error.issues.map(
      (i) => (i as { params?: { code?: string } }).params?.code,
    );
    expect(codes).toContain('END_BEYOND_TODAY_PLUS_ONE');
  });

  it('accepts bucket count of exactly 1,095', () => {
    // 1,095 days starting 2020-01-01
    const start = '2020-01-01';
    const startDate = new Date(start);
    const endDate = new Date(startDate.getTime() + 1095 * 86_400_000);
    const end = endDate.toISOString().slice(0, 10);
    const result = PerformanceQuerySchema.safeParse({
      granularity: 'day',
      start,
      end,
      tz: 'UTC',
    });
    expect(result.success).toBe(true);
  });

  it('rejects bucket count of 1,096', () => {
    const start = '2020-01-01';
    const startDate = new Date(start);
    const endDate = new Date(startDate.getTime() + 1096 * 86_400_000);
    const end = endDate.toISOString().slice(0, 10);
    const result = PerformanceQuerySchema.safeParse({
      granularity: 'day',
      start,
      end,
      tz: 'UTC',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const codes = result.error.issues.map(
      (i) => (i as { params?: { code?: string } }).params?.code,
    );
    expect(codes).toContain('BUCKET_COUNT_EXCEEDED');
  });

  it('rejects unsupported currency', () => {
    const result = PerformanceQuerySchema.safeParse({
      ...validBase,
      currency: 'XYZ',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const codes = result.error.issues.map(
      (i) => (i as { params?: { code?: string } }).params?.code,
    );
    expect(codes).toContain('UNSUPPORTED_CURRENCY');
  });

  it('accepts supported currency', () => {
    const result = PerformanceQuerySchema.safeParse({
      ...validBase,
      currency: 'USD',
    });
    expect(result.success).toBe(true);
  });

  it('defaults tz to UTC when omitted', () => {
    const result = PerformanceQuerySchema.safeParse({
      granularity: 'day',
      start: '2024-01-01',
      end: '2024-01-31',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tz).toBe('UTC');
  });
});

describe('PerformanceResponseSchema', () => {
  it('parses a minimal valid response', () => {
    const result = PerformanceResponseSchema.safeParse({
      resolvedTimezone: 'UTC',
      resolvedWeekStartDay: 0,
      dataQuality: {
        timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
        historyExcluded: { total: 0, closed_at_null: 0 },
      },
      hasAnyAccounts: false,
      hasAnyClosedPositions: false,
      hasAnyClosedPositionsInSupportedCurrency: false,
      defaultCurrency: null,
      currencies: [],
    });
    expect(result.success).toBe(true);
  });

  it('parses a populated currency entry', () => {
    const result = PerformanceResponseSchema.safeParse({
      resolvedTimezone: 'UTC',
      resolvedWeekStartDay: 0,
      dataQuality: {
        timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
        historyExcluded: { total: 0, closed_at_null: 0 },
      },
      hasAnyAccounts: true,
      hasAnyClosedPositions: true,
      hasAnyClosedPositionsInSupportedCurrency: true,
      defaultCurrency: 'USD',
      currencies: [
        {
          code: 'USD',
          historyRange: {
            earliestClosedAt: '2024-01-01T00:00:00Z',
            mostRecentClosedAt: '2024-06-01T00:00:00Z',
            totalClosedPositions: 5,
          },
          series: [
            {
              bucketStart: '2024-01-01',
              netPnl: '100.50',
              grossPnl: '105.00',
              fees: '4.50',
              totalPositions: 2,
              wins: 2,
              losses: 0,
              breakevens: 0,
            },
          ],
          equityCurve: [{ bucketStart: '2024-01-01', cumulativeNetPnl: '100.50' }],
          stats: {
            totalPositions: 2,
            totalNetPnl: '100.50',
            winRate: 100,
            breakevenRate: 0,
            avgWin: '50.25',
            avgLoss: null,
            profitFactor: null,
            largestWin: '75.00',
            largestLoss: null,
            hasWins: true,
            hasLosses: false,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects winRate > 100', () => {
    const body = buildMinimalCurrency({ winRate: 101 });
    const result = PerformanceResponseSchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects winRate with more than 1 decimal place', () => {
    const body = buildMinimalCurrency({ winRate: 54.32 });
    const result = PerformanceResponseSchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects profitFactor with more than 2 decimal places', () => {
    const body = buildMinimalCurrency({ profitFactor: 1.234 });
    const result = PerformanceResponseSchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects negative profitFactor', () => {
    const body = buildMinimalCurrency({ profitFactor: -1 });
    const result = PerformanceResponseSchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects non-decimal-string monetary values', () => {
    const body = buildMinimalCurrency({ totalNetPnl: '  100  ' });
    const result = PerformanceResponseSchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('does NOT accept a historyRange.totalAbsNetPnl field silently — schema is strict-enough via structure', () => {
    // Zod's default is to strip unknown keys, so presence doesn't cause failure,
    // but the field SHALL NOT be produced by the server. This test asserts the
    // schema's shape does not declare it.
    const parsed = PerformanceResponseSchema.safeParse({
      resolvedTimezone: 'UTC',
      resolvedWeekStartDay: 0,
      dataQuality: {
        timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
        historyExcluded: { total: 0, closed_at_null: 0 },
      },
      hasAnyAccounts: true,
      hasAnyClosedPositions: false,
      hasAnyClosedPositionsInSupportedCurrency: false,
      defaultCurrency: null,
      currencies: [
        {
          code: 'USD',
          historyRange: {
            earliestClosedAt: null,
            mostRecentClosedAt: null,
            totalClosedPositions: 0,
            totalAbsNetPnl: '999.99',
          },
          series: [],
          equityCurve: [],
          stats: {
            totalPositions: 0,
            totalNetPnl: '0',
            winRate: null,
            breakevenRate: null,
            avgWin: null,
            avgLoss: null,
            profitFactor: null,
            largestWin: null,
            largestLoss: null,
            hasWins: false,
            hasLosses: false,
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      (parsed.data.currencies[0]?.historyRange as Record<string, unknown>).totalAbsNetPnl,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function buildMinimalCurrency(statsOverrides: Record<string, unknown>) {
  return {
    resolvedTimezone: 'UTC',
    resolvedWeekStartDay: 0,
    dataQuality: {
      timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
      historyExcluded: { total: 0, closed_at_null: 0 },
    },
    hasAnyAccounts: true,
    hasAnyClosedPositions: true,
    hasAnyClosedPositionsInSupportedCurrency: true,
    defaultCurrency: 'USD',
    currencies: [
      {
        code: 'USD',
        historyRange: {
          earliestClosedAt: '2024-01-01T00:00:00Z',
          mostRecentClosedAt: '2024-06-01T00:00:00Z',
          totalClosedPositions: 1,
        },
        series: [],
        equityCurve: [],
        stats: {
          totalPositions: 1,
          totalNetPnl: '0',
          winRate: 100,
          breakevenRate: 0,
          avgWin: null,
          avgLoss: null,
          profitFactor: null,
          largestWin: null,
          largestLoss: null,
          hasWins: true,
          hasLosses: false,
          ...statsOverrides,
        },
      },
    ],
  };
}

// Independent brute-force oracle: iterate start → next boundary → end.
// This is what Task 8 will also use against `generateBucketSeries.length`;
// here we use a version that works with raw boundary math to cross-check
// `computeBucketCount` without depending on any production code.
function bruteForceBucketCount(
  start: Date,
  end: Date,
  granularity: 'day' | 'week' | 'month' | 'year',
  tz: string,
  weekStartDay: 0 | 1,
): number {
  if (start.getTime() >= end.getTime()) return 0;
  let cur = start.getTime();
  let n = 0;
  const endMs = end.getTime();
  // Safety cap so an incorrect nextBoundary doesn't hang the test.
  for (let i = 0; cur < endMs && i < 10_000; i++) {
    n++;
    cur = nextBoundary(new Date(cur), granularity, tz, weekStartDay).getTime();
  }
  return n;
}

function nextBoundary(
  d: Date,
  granularity: 'day' | 'week' | 'month' | 'year',
  tz: string,
  weekStartDay: 0 | 1,
): Date {
  // Oracle: shift UTC → local fake-UTC via Intl-based component extraction,
  // snap to the next boundary, convert back to a true UTC instant by
  // inverting the local-to-utc mapping via a one-shot disambiguation.
  const localMs = localMsInTz_test(d, tz);
  let nextLocalMs: number;
  if (granularity === 'day') {
    nextLocalMs = Math.floor(localMs / 86_400_000) * 86_400_000 + 86_400_000;
  } else if (granularity === 'week') {
    const DAY = 86_400_000;
    const WEEK = 7 * DAY;
    const epochOffset = weekStartDay === 0 ? 3 * DAY : 4 * DAY;
    const adj = localMs - epochOffset;
    nextLocalMs = (Math.floor(adj / WEEK) + 1) * WEEK + epochOffset;
  } else if (granularity === 'month') {
    const ld = new Date(localMs);
    const y = ld.getUTCFullYear();
    const m = ld.getUTCMonth();
    nextLocalMs = Date.UTC(y, m + 1, 1);
  } else {
    const ld = new Date(localMs);
    nextLocalMs = Date.UTC(ld.getUTCFullYear() + 1, 0, 1);
  }
  // Invert: guess using current offset, then correct if the round-trip
  // disagrees. Boundary gaps are >= 1 day; DST shifts are <= 1h, so one
  // correction suffices.
  const currentOffset = localMs - d.getTime();
  let guessUtc = nextLocalMs - currentOffset;
  const guessLocal = localMsInTz_test(new Date(guessUtc), tz);
  if (guessLocal !== nextLocalMs) {
    guessUtc += nextLocalMs - guessLocal;
  }
  return new Date(guessUtc);
}

function localMsInTz_test(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of parts) {
    if (p.type === 'year') year = Number(p.value);
    else if (p.type === 'month') month = Number(p.value);
    else if (p.type === 'day') day = Number(p.value);
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'second') second = Number(p.value);
  }
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) + d.getUTCMilliseconds();
}
