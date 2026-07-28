import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Granularity, type SeriesBucket } from '../schemas/performance';

import {
  buildCumulativeSeries,
  classifyPosition,
  computeBucketCount,
  computePositionSetStatistics,
  generateBucketSeries,
  type ClassifiedPosition,
} from './performance';

const TZ_MATRIX = [
  'UTC',
  'America/New_York',
  'Asia/Tokyo',
  'Europe/London',
  'America/Argentina/Cordoba',
  'Pacific/Apia',
  'America/Sao_Paulo',
  'Africa/Casablanca',
] as const;

describe('generateBucketSeries', () => {
  it('returns [] when start >= end', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    expect(generateBucketSeries(d, d, 'day', 'UTC')).toEqual([]);
    expect(
      generateBucketSeries(new Date('2024-01-02'), new Date('2024-01-01'), 'day', 'UTC'),
    ).toEqual([]);
  });

  it('emits one boundary for a one-day span aligned to UTC midnight', () => {
    const start = new Date('2024-01-01T00:00:00Z');
    const end = new Date('2024-01-02T00:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'UTC');
    expect(result).toHaveLength(1);
    expect(result[0]?.startInstant.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(result[0]?.endInstant.toISOString()).toBe('2024-01-02T00:00:00.000Z');
    expect(result[0]?.label).toBe('2024-01-01');
  });

  it('snaps start backward to the containing bucket for mid-day start', () => {
    const start = new Date('2024-01-01T08:00:00Z');
    const end = new Date('2024-01-03T00:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'UTC');
    expect(result).toHaveLength(2);
    expect(result[0]?.label).toBe('2024-01-01');
    expect(result[0]?.startInstant.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(result[1]?.label).toBe('2024-01-02');
  });

  it('produces day buckets across DST spring-forward (America/New_York)', () => {
    // Mar 10 2024 00:00 EST = 05:00 UTC; Mar 11 2024 00:00 EDT = 04:00 UTC.
    const start = new Date('2024-03-10T05:00:00Z');
    const end = new Date('2024-03-12T04:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'America/New_York');
    expect(result).toHaveLength(2);
    expect(result[0]?.label).toBe('2024-03-10');
    expect(result[1]?.label).toBe('2024-03-11');
    // Spring-forward day is 23 wall-clock hours but still one bucket.
    expect(result[0]?.endInstant.getTime() - result[0]?.startInstant.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
    // Following day is a standard 24-hour day.
    expect(result[1]?.endInstant.getTime() - result[1]?.startInstant.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it('produces day buckets across DST fall-back (America/New_York)', () => {
    // Nov 3 2024 00:00 EDT = 04:00 UTC; Nov 4 2024 00:00 EST = 05:00 UTC.
    const start = new Date('2024-11-03T04:00:00Z');
    const end = new Date('2024-11-04T05:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'America/New_York');
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe('2024-11-03');
    // 25 wall-clock hours.
    expect(result[0]?.endInstant.getTime() - result[0]?.startInstant.getTime()).toBe(
      25 * 60 * 60 * 1000,
    );
  });

  it('aligns week buckets to Sunday (weekStartDay=0) in UTC', () => {
    // 2024-01-07 is Sunday UTC.
    const start = new Date('2024-01-07T00:00:00Z');
    const end = new Date('2024-01-28T00:00:00Z');
    const result = generateBucketSeries(start, end, 'week', 'UTC', 0);
    expect(result).toHaveLength(3);
    expect(result.map((b) => b.label)).toEqual(['2024-01-07', '2024-01-14', '2024-01-21']);
  });

  it('aligns week buckets to Monday (weekStartDay=1) in UTC', () => {
    // 2024-01-08 is Monday UTC.
    const start = new Date('2024-01-08T00:00:00Z');
    const end = new Date('2024-01-22T00:00:00Z');
    const result = generateBucketSeries(start, end, 'week', 'UTC', 1);
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.label)).toEqual(['2024-01-08', '2024-01-15']);
  });

  it('snaps a mid-week start back to its Sunday', () => {
    const start = new Date('2024-01-10T12:00:00Z'); // Wed
    const end = new Date('2024-01-21T00:00:00Z');
    const result = generateBucketSeries(start, end, 'week', 'UTC', 0);
    expect(result).toHaveLength(2);
    expect(result[0]?.label).toBe('2024-01-07');
    expect(result[1]?.label).toBe('2024-01-14');
  });

  it('produces month buckets with the first-of-month label', () => {
    const start = new Date('2024-01-15T00:00:00Z');
    const end = new Date('2024-04-15T00:00:00Z');
    const result = generateBucketSeries(start, end, 'month', 'UTC');
    expect(result.map((b) => b.label)).toEqual([
      '2024-01-01',
      '2024-02-01',
      '2024-03-01',
      '2024-04-01',
    ]);
  });

  it('produces month buckets aligned to JST local first-of-month', () => {
    // 2024-01-01 00:00 JST = 2023-12-31 15:00 UTC.
    const start = new Date('2023-12-31T15:00:00Z');
    const end = new Date('2024-03-31T15:00:00Z');
    const result = generateBucketSeries(start, end, 'month', 'Asia/Tokyo');
    expect(result).toHaveLength(3);
    expect(result.map((b) => b.label)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
    // Each boundary is local midnight in JST.
    for (const b of result) {
      expect(b.startInstant.getUTCHours()).toBe(15);
      expect(b.startInstant.getUTCMinutes()).toBe(0);
    }
  });

  it('produces year buckets', () => {
    const start = new Date('2020-01-01T00:00:00Z');
    const end = new Date('2024-01-01T00:00:00Z');
    const result = generateBucketSeries(start, end, 'year', 'UTC');
    expect(result).toHaveLength(4);
    expect(result.map((b) => b.label)).toEqual([
      '2020-01-01',
      '2021-01-01',
      '2022-01-01',
      '2023-01-01',
    ]);
  });

  it('crosses the 2024 leap-day on day granularity (UTC)', () => {
    const start = new Date('2024-02-28T00:00:00Z');
    const end = new Date('2024-03-01T00:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'UTC');
    expect(result.map((b) => b.label)).toEqual(['2024-02-28', '2024-02-29']);
  });

  it('spans the 2011 Pacific/Apia date-line shift with contiguous monotonic boundaries', () => {
    // Dec 30 2011 was skipped entirely in Samoa. We don't assert that the
    // skipped local day is absent from the series — mapping a non-existent
    // local time to a UTC instant is a matter of convention — but the series
    // MUST remain contiguous (end[i] === start[i+1]) and length-consistent
    // with `computeBucketCount`.
    const start = new Date('2011-12-28T11:00:00Z');
    const end = new Date('2012-01-01T11:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'Pacific/Apia');
    expect(result.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i + 1 < result.length; i++) {
      expect(result[i + 1]?.startInstant.getTime()).toBe(result[i]?.endInstant.getTime());
    }
    expect(result.length).toBe(computeBucketCount(start, end, 'day', 'Pacific/Apia'));
  });

  it('works across America/Sao_Paulo after DST abolition (2020+ has no DST)', () => {
    const start = new Date('2020-10-15T03:00:00Z');
    const end = new Date('2020-10-20T03:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'America/Sao_Paulo');
    expect(result).toHaveLength(5);
    for (const b of result) {
      // Every bucket in 2020+ Sao_Paulo is exactly 24h since DST abolished.
      expect(b.endInstant.getTime() - b.startInstant.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('works across Africa/Casablanca Ramadan-shifted DST boundaries', () => {
    // March 2024: DST pauses for Ramadan on 2024-03-10. We don't assert specific
    // hour counts — just that the series is contiguous and label-ordered.
    const start = new Date('2024-03-05T00:00:00Z');
    const end = new Date('2024-03-15T00:00:00Z');
    const result = generateBucketSeries(start, end, 'day', 'Africa/Casablanca');
    for (let i = 0; i + 1 < result.length; i++) {
      expect(result[i + 1]?.startInstant.getTime()).toBe(result[i]?.endInstant.getTime());
      expect(result[i + 1]?.label > (result[i]?.label ?? '')).toBe(true);
    }
  });

  it('series length matches computeBucketCount across the 8-TZ matrix (smoke)', () => {
    const cases: Array<[string, string, Granularity]> = [
      ['2024-01-01T00:00:00Z', '2024-01-15T00:00:00Z', 'day'],
      ['2024-03-01T00:00:00Z', '2024-04-01T00:00:00Z', 'day'],
      ['2024-01-07T00:00:00Z', '2024-03-07T00:00:00Z', 'week'],
      ['2024-01-08T00:00:00Z', '2024-03-08T00:00:00Z', 'week'],
      ['2024-01-01T00:00:00Z', '2024-07-01T00:00:00Z', 'month'],
      ['2020-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'year'],
    ];
    for (const tz of TZ_MATRIX) {
      for (const weekStartDay of [0, 1] as const) {
        for (const [s, e, g] of cases) {
          const start = new Date(s);
          const end = new Date(e);
          const series = generateBucketSeries(start, end, g, tz, weekStartDay);
          const count = computeBucketCount(start, end, g, tz, weekStartDay);
          expect(series.length, `${tz} weekStartDay=${weekStartDay} ${g} ${s}→${e}`).toBe(count);
        }
      }
    }
  });

  it('re-exports computeBucketCount from schemas', () => {
    // Regression guard: the lib file is the canonical single-import surface for
    // backend consumers, so computeBucketCount must round-trip through it.
    expect(typeof computeBucketCount).toBe('function');
    expect(
      computeBucketCount(
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-01-08T00:00:00Z'),
        'day',
        'UTC',
      ),
    ).toBe(7);
  });
});

describe('generateBucketSeries property: oracle matches computeBucketCount AND series length', () => {
  it('matches a brute-force oracle across random start/end/granularity/tz/weekStartDay', () => {
    const prop = fc.property(
      // Pick a UTC instant in [2020-01-01, 2025-12-31].
      fc.integer({
        min: new Date('2020-01-01T00:00:00Z').getTime(),
        max: new Date('2025-12-31T00:00:00Z').getTime(),
      }),
      // Span length in ms — cap at ~90 days so even day granularity stays under
      // 100 iterations per run; 1,000 runs finishes in seconds.
      fc.integer({ min: 3_600_000, max: 90 * 86_400_000 }),
      fc.constantFrom<Granularity>('day', 'week', 'month', 'year'),
      fc.constantFrom(...TZ_MATRIX),
      fc.constantFrom(0 as const, 1 as const),
      (startMs, spanMs, granularity, tz, weekStartDay) => {
        const start = new Date(startMs);
        const end = new Date(startMs + spanMs);
        const series = generateBucketSeries(start, end, granularity, tz, weekStartDay);
        const count = computeBucketCount(start, end, granularity, tz, weekStartDay);
        const oracle = bruteForceBucketCount(start, end, granularity, tz, weekStartDay);
        return series.length === oracle && count === oracle;
      },
    );
    fc.assert(prop, { numRuns: 1000, seed: 0x7064ff7 });
  });
});

// ---------------------------------------------------------------------------
// Independent brute-force oracle (Intl-based, not sharing production code).
// ---------------------------------------------------------------------------

function bruteForceBucketCount(
  start: Date,
  end: Date,
  granularity: Granularity,
  tz: string,
  weekStartDay: 0 | 1,
): number {
  if (start.getTime() >= end.getTime()) return 0;
  let cur = start.getTime();
  const endMs = end.getTime();
  let n = 0;
  // Safety cap: 90 days of day buckets = 90; a runaway implementation would hit
  // this before the test process hangs.
  for (let i = 0; cur < endMs && i < 5_000; i++) {
    n++;
    cur = nextBoundary(new Date(cur), granularity, tz, weekStartDay).getTime();
  }
  return n;
}

function nextBoundary(d: Date, granularity: Granularity, tz: string, weekStartDay: 0 | 1): Date {
  const localMs = localMsInTzOracle(d, tz);
  let nextLocalMs: number;
  if (granularity === 'day') {
    nextLocalMs = Math.floor(localMs / 86_400_000) * 86_400_000 + 86_400_000;
  } else if (granularity === 'week') {
    const DAY = 86_400_000;
    const WEEK = 7 * DAY;
    // Jan 1 1970 UTC was Thursday; Jan 4 (Sun) = 3d, Jan 5 (Mon) = 4d.
    const epochOffset = weekStartDay === 0 ? 3 * DAY : 4 * DAY;
    const adj = localMs - epochOffset;
    nextLocalMs = (Math.floor(adj / WEEK) + 1) * WEEK + epochOffset;
  } else if (granularity === 'month') {
    const ld = new Date(localMs);
    nextLocalMs = Date.UTC(ld.getUTCFullYear(), ld.getUTCMonth() + 1, 1);
  } else {
    const ld = new Date(localMs);
    nextLocalMs = Date.UTC(ld.getUTCFullYear() + 1, 0, 1);
  }
  // Invert local → UTC via one-correction guess. Boundary gaps are >= 1 day;
  // DST shifts are <= 1h, so one correction suffices.
  const currentOffset = localMs - d.getTime();
  let guessUtc = nextLocalMs - currentOffset;
  const guessLocal = localMsInTzOracle(new Date(guessUtc), tz);
  if (guessLocal !== nextLocalMs) {
    guessUtc += nextLocalMs - guessLocal;
  }
  return new Date(guessUtc);
}

const ORACLE_DTF_CACHE = new Map<string, Intl.DateTimeFormat>();

function localMsInTzOracle(d: Date, tz: string): number {
  let dtf = ORACLE_DTF_CACHE.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    ORACLE_DTF_CACHE.set(tz, dtf);
  }
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of dtf.formatToParts(d)) {
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

// ---------------------------------------------------------------------------
// classifyPosition
// ---------------------------------------------------------------------------

describe('classifyPosition', () => {
  // 7 currencies × boundary cases. Two-decimal currencies (USD/EUR/GBP/CAD/CHF)
  // round at 0.005; zero-decimal currencies (JPY/KRW) round at 0.5.
  const TWO_DP = ['USD', 'EUR', 'GBP', 'CAD', 'CHF'] as const;
  const ZERO_DP = ['JPY', 'KRW'] as const;

  for (const code of TWO_DP) {
    it(`${code}: rounds at 0.005 boundary (HALF_UP)`, () => {
      expect(classifyPosition(new Decimal('0.005'), code)).toBe('winning');
      expect(classifyPosition(new Decimal('0.0049'), code)).toBe('breakeven');
      expect(classifyPosition(new Decimal('-0.005'), code)).toBe('losing');
      expect(classifyPosition(new Decimal('-0.0049'), code)).toBe('breakeven');
      expect(classifyPosition(new Decimal('0'), code)).toBe('breakeven');
      expect(classifyPosition(new Decimal('0.01'), code)).toBe('winning');
      expect(classifyPosition(new Decimal('-0.01'), code)).toBe('losing');
    });
  }

  for (const code of ZERO_DP) {
    it(`${code}: rounds at 0.5 boundary (HALF_UP, no minor units)`, () => {
      expect(classifyPosition(new Decimal('0.5'), code)).toBe('winning');
      expect(classifyPosition(new Decimal('0.49'), code)).toBe('breakeven');
      expect(classifyPosition(new Decimal('-0.5'), code)).toBe('losing');
      expect(classifyPosition(new Decimal('-0.49'), code)).toBe('breakeven');
      expect(classifyPosition(new Decimal('0'), code)).toBe('breakeven');
      expect(classifyPosition(new Decimal('1'), code)).toBe('winning');
      expect(classifyPosition(new Decimal('-1'), code)).toBe('losing');
    });
  }

  it('throws on unsupported currency code', () => {
    expect(() => classifyPosition(new Decimal('1'), 'XXX')).toThrow(/Unsupported currency/);
    expect(() => classifyPosition(new Decimal('0'), 'BTC')).toThrow(/Unsupported currency/);
  });
});

// ---------------------------------------------------------------------------
// computePositionSetStatistics
// ---------------------------------------------------------------------------

function pos(
  classification: 'winning' | 'losing' | 'breakeven',
  netPnl: string,
  currency = 'USD',
): ClassifiedPosition {
  const d = new Decimal(netPnl);
  return {
    id: `${classification}-${netPnl}`,
    currency,
    netPnl: d,
    grossPnl: d,
    fees: new Decimal(0),
    closedAt: new Date('2024-01-01T00:00:00Z'),
    classification,
  };
}

describe('computePositionSetStatistics', () => {
  it('returns the empty-set null matrix', () => {
    const stats = computePositionSetStatistics([]);
    expect(stats).toEqual({
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
    });
  });

  it('handles all-wins (∞ profit-factor case via hasWins && !hasLosses)', () => {
    const stats = computePositionSetStatistics([
      pos('winning', '100'),
      pos('winning', '50'),
      pos('winning', '25'),
    ]);
    expect(stats.totalPositions).toBe(3);
    expect(stats.totalNetPnl).toBe('175');
    expect(stats.winRate).toBe(100);
    expect(stats.breakevenRate).toBe(0);
    expect(stats.avgWin).toBe(new Decimal('175').div(3).toString());
    expect(stats.avgLoss).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.largestWin).toBe('100');
    expect(stats.largestLoss).toBeNull();
    expect(stats.hasWins).toBe(true);
    expect(stats.hasLosses).toBe(false);
  });

  it('handles all-losses', () => {
    const stats = computePositionSetStatistics([pos('losing', '-40'), pos('losing', '-60')]);
    expect(stats.totalPositions).toBe(2);
    expect(stats.totalNetPnl).toBe('-100');
    expect(stats.winRate).toBe(0);
    expect(stats.breakevenRate).toBe(0);
    expect(stats.avgWin).toBeNull();
    expect(stats.avgLoss).toBe('-50');
    expect(stats.profitFactor).toBeNull();
    expect(stats.largestWin).toBeNull();
    expect(stats.largestLoss).toBe('-60');
    expect(stats.hasWins).toBe(false);
    expect(stats.hasLosses).toBe(true);
  });

  it('handles all-breakevens (winRate null because winning+losing=0)', () => {
    const stats = computePositionSetStatistics([pos('breakeven', '0'), pos('breakeven', '0.001')]);
    expect(stats.totalPositions).toBe(2);
    expect(stats.winRate).toBeNull();
    expect(stats.breakevenRate).toBe(100);
    expect(stats.profitFactor).toBeNull();
    expect(stats.hasWins).toBe(false);
    expect(stats.hasLosses).toBe(false);
  });

  it('computes the full mixed case', () => {
    // 2 wins, 1 loss, 1 breakeven; deliberate fractional avg.
    const stats = computePositionSetStatistics([
      pos('winning', '100'),
      pos('winning', '50'),
      pos('losing', '-30'),
      pos('breakeven', '0'),
    ]);
    expect(stats.totalPositions).toBe(4);
    expect(stats.totalNetPnl).toBe('120');
    // wins=2, losses=1 → 2/3 = 66.666… → 66.7 (HALF_UP)
    expect(stats.winRate).toBe(66.7);
    // breakevens=1, total=4 → 25
    expect(stats.breakevenRate).toBe(25);
    expect(stats.avgWin).toBe('75');
    expect(stats.avgLoss).toBe('-30');
    // 150 / 30 = 5
    expect(stats.profitFactor).toBe(5);
    expect(stats.largestWin).toBe('100');
    expect(stats.largestLoss).toBe('-30');
    expect(stats.hasWins).toBe(true);
    expect(stats.hasLosses).toBe(true);
  });

  it('rounds win rate at the 1dp HALF_UP boundary', () => {
    // 1 win out of 8 decided = 12.5% (exact), 1 win out of 7 = 14.2857… → 14.3
    const stats7 = computePositionSetStatistics([
      pos('winning', '1'),
      pos('losing', '-1'),
      pos('losing', '-1'),
      pos('losing', '-1'),
      pos('losing', '-1'),
      pos('losing', '-1'),
      pos('losing', '-1'),
    ]);
    expect(stats7.winRate).toBe(14.3);
  });

  it('rounds profit factor at the 2dp HALF_UP boundary', () => {
    // sumWins=10, sumLosses=-3 → 10/3 = 3.333… → 3.33
    const stats = computePositionSetStatistics([pos('winning', '10'), pos('losing', '-3')]);
    expect(stats.profitFactor).toBe(3.33);
  });

  it('uses exact decimal arithmetic for totalNetPnl (no float drift)', () => {
    const stats = computePositionSetStatistics([pos('winning', '0.1'), pos('winning', '0.2')]);
    expect(stats.totalNetPnl).toBe('0.3');
  });
});

// ---------------------------------------------------------------------------
// buildCumulativeSeries
// ---------------------------------------------------------------------------

function bucket(bucketStart: string, netPnl: string): SeriesBucket {
  return {
    bucketStart,
    netPnl,
    grossPnl: netPnl,
    fees: '0',
    totalPositions: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
  };
}

describe('buildCumulativeSeries', () => {
  it('returns [] for empty input', () => {
    expect(buildCumulativeSeries([])).toEqual([]);
  });

  it('preserves bucketStart and produces a running sum (golden file)', () => {
    const input: SeriesBucket[] = [
      bucket('2024-01-01', '10'),
      bucket('2024-01-02', '-3'),
      bucket('2024-01-03', '0'),
      bucket('2024-01-04', '5'),
      bucket('2024-01-05', '-12.5'),
    ];
    expect(buildCumulativeSeries(input)).toEqual([
      { bucketStart: '2024-01-01', cumulativeNetPnl: '10' },
      { bucketStart: '2024-01-02', cumulativeNetPnl: '7' },
      { bucketStart: '2024-01-03', cumulativeNetPnl: '7' },
      { bucketStart: '2024-01-04', cumulativeNetPnl: '12' },
      { bucketStart: '2024-01-05', cumulativeNetPnl: '-0.5' },
    ]);
  });

  it('uses exact decimal arithmetic (0.1 + 0.2 = 0.3, not 0.30000000000000004)', () => {
    const input: SeriesBucket[] = [bucket('2024-01-01', '0.1'), bucket('2024-01-02', '0.2')];
    expect(buildCumulativeSeries(input)).toEqual([
      { bucketStart: '2024-01-01', cumulativeNetPnl: '0.1' },
      { bucketStart: '2024-01-02', cumulativeNetPnl: '0.3' },
    ]);
  });

  it('matches an inline Array.reduce oracle (property test, fixed seed)', () => {
    const decimalCentString = fc
      .integer({ min: -100_000, max: 100_000 })
      .map((n) => new Decimal(n).div(100).toString());

    const prop = fc.property(
      fc.array(decimalCentString, { minLength: 0, maxLength: 50 }),
      (netPnls) => {
        const series = netPnls.map((p, i) =>
          bucket(`2024-01-${String(i + 1).padStart(2, '0')}`, p),
        );
        const result = buildCumulativeSeries(series);

        // Oracle: independent Array.reduce over Decimal values, asserting both
        // length-equality and per-index value-equality with the production output.
        const oracleValues = netPnls.reduce<string[]>((acc, p) => {
          const prev = acc.length === 0 ? new Decimal(0) : new Decimal(acc[acc.length - 1]!);
          acc.push(prev.plus(new Decimal(p)).toString());
          return acc;
        }, []);

        if (result.length !== oracleValues.length) return false;
        for (let i = 0; i < result.length; i++) {
          if (result[i]!.cumulativeNetPnl !== oracleValues[i]) return false;
          if (result[i]!.bucketStart !== series[i]!.bucketStart) return false;
        }
        return true;
      },
    );
    fc.assert(prop, { numRuns: 1000, seed: 0x4e91b8 });
  });
});
