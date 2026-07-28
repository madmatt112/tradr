import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import Decimal from 'decimal.js';

import { getCurrencyMinorUnits } from '../constants/currencies';
import {
  computeBucketCount,
  type EquityCurvePoint,
  type Granularity,
  type PerformanceStats,
  type SeriesBucket,
} from '../schemas/performance';

// Re-export so backend consumers can pick up both primitives from one import.
// The `lib → schemas` direction is allowed; dependency-cruiser blocks the reverse.
export { computeBucketCount };

export type Classification = 'winning' | 'losing' | 'breakeven';

export interface ClassifiedPosition {
  id: string;
  currency: string;
  netPnl: Decimal;
  grossPnl: Decimal;
  fees: Decimal;
  closedAt: Date;
  classification: Classification;
}

export interface BucketBoundary {
  startInstant: Date;
  endInstant: Date;
  label: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Local fields of `zoned` (from `toZonedTime`) are the wall clock in the target
// zone. Always format from those, never from UTC fields.
function formatLocalIsoDate(zoned: Date): string {
  return `${zoned.getFullYear()}-${pad2(zoned.getMonth() + 1)}-${pad2(zoned.getDate())}`;
}

function snapBackwardLocal(zonedStart: Date, granularity: Granularity, weekStartDay: 0 | 1): Date {
  const y = zonedStart.getFullYear();
  const m = zonedStart.getMonth();
  const d = zonedStart.getDate();
  if (granularity === 'day') return new Date(y, m, d);
  if (granularity === 'week') {
    const dow = zonedStart.getDay();
    const daysBack = (dow - weekStartDay + 7) % 7;
    return new Date(y, m, d - daysBack);
  }
  if (granularity === 'month') return new Date(y, m, 1);
  return new Date(y, 0, 1);
}

function nextBoundaryLocal(localBoundary: Date, granularity: Granularity): Date {
  const y = localBoundary.getFullYear();
  const m = localBoundary.getMonth();
  const d = localBoundary.getDate();
  if (granularity === 'day') return new Date(y, m, d + 1);
  if (granularity === 'week') return new Date(y, m, d + 7);
  if (granularity === 'month') return new Date(y, m + 1, 1);
  return new Date(y + 1, 0, 1);
}

export function generateBucketSeries(
  start: Date,
  end: Date,
  granularity: Granularity,
  tz: string,
  weekStartDay: 0 | 1 = 0,
): BucketBoundary[] {
  if (start.getTime() >= end.getTime()) return [];

  const boundaries: BucketBoundary[] = [];
  let localBoundary = snapBackwardLocal(toZonedTime(start, tz), granularity, weekStartDay);
  let utcBoundary = fromZonedTime(localBoundary, tz);

  while (utcBoundary.getTime() < end.getTime()) {
    const nextLocal = nextBoundaryLocal(localBoundary, granularity);
    const nextUtc = fromZonedTime(nextLocal, tz);
    boundaries.push({
      startInstant: utcBoundary,
      endInstant: nextUtc,
      label: formatLocalIsoDate(localBoundary),
    });
    localBoundary = nextLocal;
    utcBoundary = nextUtc;
  }
  return boundaries;
}

// Classifies a position via REQ-4.2: round net P&L to currency minor units,
// then compare to zero. HALF_UP matches the rounding the user sees in the
// positions list. Throws on unsupported currency (callers MUST pre-filter
// per REQ-1.9).
export function classifyPosition(netPnl: Decimal, currency: string): Classification {
  const minorUnits = getCurrencyMinorUnits(currency);
  const rounded = netPnl.toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP);
  if (rounded.isZero()) return 'breakeven';
  return rounded.isPositive() ? 'winning' : 'losing';
}

function decimalSum(values: readonly Decimal[]): Decimal {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(v);
  return acc;
}

function decimalMax(values: readonly Decimal[]): Decimal {
  // Caller guarantees `values.length > 0`. Avoid Decimal.max(...) spread to
  // dodge call-stack issues on very large position sets.
  let m = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    if (v.greaterThan(m)) m = v;
  }
  return m;
}

function decimalMin(values: readonly Decimal[]): Decimal {
  let m = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    if (v.lessThan(m)) m = v;
  }
  return m;
}

function percent(numerator: number, denominator: number): number {
  return Number(
    new Decimal(numerator).div(denominator).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP),
  );
}

// REQ-4.* aggregation. All monetary outputs are decimal strings; rate/factor
// outputs are JS numbers rounded to the precision the schema validates. Null
// semantics follow REQ-4.3..4.9 exactly so the frontend can distinguish the
// two "no data" cases for profit factor via `hasWins`/`hasLosses`.
export function computePositionSetStatistics(
  positions: readonly ClassifiedPosition[],
): PerformanceStats {
  const total = positions.length;
  const winsPnl: Decimal[] = [];
  const lossesPnl: Decimal[] = [];
  let breakevens = 0;
  for (const p of positions) {
    if (p.classification === 'winning') winsPnl.push(p.netPnl);
    else if (p.classification === 'losing') lossesPnl.push(p.netPnl);
    else breakevens++;
  }
  const winsCount = winsPnl.length;
  const lossesCount = lossesPnl.length;
  const decided = winsCount + lossesCount;

  const totalNetPnl = decimalSum(positions.map((p) => p.netPnl));
  const sumWins = decimalSum(winsPnl);
  const sumLosses = decimalSum(lossesPnl);

  const winRate = decided === 0 ? null : percent(winsCount, decided);
  const breakevenRate = total === 0 ? null : percent(breakevens, total);

  const avgWin = winsCount === 0 ? null : sumWins.div(winsCount).toString();
  const avgLoss = lossesCount === 0 ? null : sumLosses.div(lossesCount).toString();

  const profitFactor =
    winsCount === 0 || lossesCount === 0
      ? null
      : Number(sumWins.div(sumLosses.abs()).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));

  const largestWin = winsCount === 0 ? null : decimalMax(winsPnl).toString();
  const largestLoss = lossesCount === 0 ? null : decimalMin(lossesPnl).toString();

  return {
    totalPositions: total,
    totalNetPnl: totalNetPnl.toString(),
    winRate,
    breakevenRate,
    avgWin,
    avgLoss,
    profitFactor,
    largestWin,
    largestLoss,
    hasWins: winsCount > 0,
    hasLosses: lossesCount > 0,
  };
}

// REQ-3.7 invariant: equityCurve[n].cumulativeNetPnl == sum(series[0..n].netPnl)
// when summed as decimal strings (no float intermediate). Output preserves the
// input bucketStart values index-zipped.
export function buildCumulativeSeries(series: readonly SeriesBucket[]): EquityCurvePoint[] {
  const out: EquityCurvePoint[] = [];
  let cumulative = new Decimal(0);
  for (const bucket of series) {
    cumulative = cumulative.plus(new Decimal(bucket.netPnl));
    out.push({
      bucketStart: bucket.bucketStart,
      cumulativeNetPnl: cumulative.toString(),
    });
  }
  return out;
}
