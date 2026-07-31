import Decimal from 'decimal.js';

import {
  getCurrencyMinorUnits,
  type PerformanceCurrency,
  type PerformanceQueryInput,
  type PerformanceResponse,
  type SeriesBucket,
  PerformanceResponseSchema,
} from '@tradr/shared';
import {
  buildCumulativeSeries,
  classifyPosition,
  computePositionSetStatistics,
  generateBucketSeries,
  type ClassifiedPosition,
} from '@tradr/shared/lib/performance';
import { resolveTimezone } from '@tradr/shared/schemas/performance';

import type { Database } from '@/db';
import { aggregateFills, computePnlFromTotals, type FillTotals } from '@/features/positions/pnl';
import { config } from '@/lib/config';
import { ClientAbortError, InvalidTimezoneError, TimeoutError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';

import {
  fetchHistoryMetadata,
  fetchTimeframeSnapshot,
  type HistoryCurrency,
  type SnapshotPosition,
} from './performance.query';

const CHUNK_SIZE = 1000;
const TIMEOUT_MS = 10_000;

/**
 * The free-tier lookback boundary (plan-tiers D13): `now (UTC) −
 * lookbackMonths` CALENDAR months via `Date.UTC` month arithmetic, clamping
 * day overflow to the last day of the target month (Aug 31 − 6mo ⇒ Feb 28,
 * or Feb 29 in a leap year). Time-of-day is preserved. Pure and exported so
 * the month-length edges are unit-testable.
 */
export function computeLookbackFloor(now: Date, lookbackMonths: number): Date {
  const targetMonth = now.getUTCMonth() - lookbackMonths;
  // Day 0 of the month AFTER the target month = the target month's last day.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(now.getUTCFullYear(), targetMonth + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      targetMonth,
      Math.min(now.getUTCDate(), lastDayOfTargetMonth),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/** L3 lookback floor injected by the route when the user is enforced-free. */
export interface TierLookbackFloor {
  floor: Date;
  lookbackMonths: number;
}

export async function getPerformance(
  db: Database,
  userId: string,
  input: PerformanceQueryInput,
  abortSignal: AbortSignal,
  startTime: number,
  // Optional by design (D13): absent means today's behaviour exactly. The
  // route resolves the tier — this service stays pure of Hono context.
  tierFloor?: TierLookbackFloor,
): Promise<PerformanceResponse> {
  let resolvedTimezone: string;
  try {
    resolvedTimezone = resolveTimezone(input.tz);
  } catch {
    throw new InvalidTimezoneError(`Invalid timezone: ${input.tz}`);
  }

  const requestedStart = new Date(input.start);
  const endInstant = new Date(input.end);

  // L3 clamp-and-mark (plan-tiers D13, REQ-7.1/7.2): effectiveStart =
  // max(requestedStart, floor) — NEVER a hard error on account of the tier
  // window. Schema validation already ran on the REQUESTED window in the
  // route (MIN_START / date order / BUCKET_COUNT_CAP unchanged on every
  // tier). The fully-pre-boundary case (effectiveStart ≥ end) flows through
  // naturally: generateBucketSeries returns [] ⇒ empty series, still marked.
  let startInstant = requestedStart;
  let tierWindow: PerformanceResponse['tierWindow'];
  if (tierFloor && tierFloor.floor.getTime() > requestedStart.getTime()) {
    startInstant = tierFloor.floor;
    tierWindow = {
      clamped: true,
      effectiveStart: tierFloor.floor.toISOString(),
      lookbackMonths: tierFloor.lookbackMonths,
    };
  }

  // fetchHistoryMetadata stays UNCLAMPED (D13/OD#9): it reveals only that
  // older data exists and powers the free-tier upgrade notice.
  const { snapshot, history } = await db.transaction(
    async (tx) => {
      const snap = await fetchTimeframeSnapshot(tx, userId, startInstant, endInstant);
      const hist = await fetchHistoryMetadata(tx, userId);
      return { snapshot: snap, history: hist };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  const classified = await classifyTimeframePositions(snapshot.positions, abortSignal, startTime);

  const buckets = generateBucketSeries(
    startInstant,
    endInstant,
    input.granularity,
    resolvedTimezone,
    config.WEEK_START_DAY,
  );

  const selectedCurrencies = input.currency
    ? history.currencies.filter((c) => c.code === input.currency)
    : history.currencies;

  const positionsByCurrency = new Map<string, ClassifiedPosition[]>();
  for (const p of classified) {
    const list = positionsByCurrency.get(p.currency);
    if (list) list.push(p);
    else positionsByCurrency.set(p.currency, [p]);
  }

  const currencies: PerformanceCurrency[] = selectedCurrencies.map((cur) =>
    buildCurrencyEntry(cur, positionsByCurrency.get(cur.code) ?? [], buckets),
  );

  const defaultCurrency = pickDefaultCurrency(history.currencies);

  const response: PerformanceResponse = {
    resolvedTimezone,
    resolvedWeekStartDay: config.WEEK_START_DAY,
    dataQuality: {
      timeframeExcluded: snapshot.timeframeExcluded,
      historyExcluded: history.historyExcluded,
    },
    hasAnyAccounts: history.hasAnyAccounts,
    hasAnyClosedPositions: history.hasAnyClosedPositions,
    hasAnyClosedPositionsInSupportedCurrency: history.hasAnyClosedPositionsInSupportedCurrency,
    defaultCurrency,
    currencies,
    ...(tierWindow ? { tierWindow } : {}),
  };

  if (tierWindow) {
    // D17: emitted on every clamped response — per-request noise accepted;
    // funnels dedupe. Fire-and-forget, no-op when PostHog is unconfigured.
    captureServerEvent('tier_limit_hit', {
      distinctId: userId,
      properties: { lever: 'lookback' },
    });
  }

  return PerformanceResponseSchema.parse(response);
}

async function classifyTimeframePositions(
  positions: readonly SnapshotPosition[],
  abortSignal: AbortSignal,
  startTime: number,
): Promise<ClassifiedPosition[]> {
  const out: ClassifiedPosition[] = [];
  for (let i = 0; i < positions.length; i++) {
    if (abortSignal.reason instanceof ClientAbortError) throw abortSignal.reason;
    if (Date.now() - startTime > TIMEOUT_MS) throw new TimeoutError();
    if (abortSignal.reason instanceof TimeoutError) throw abortSignal.reason;

    out.push(classifyOne(positions[i]!));

    if ((i + 1) % CHUNK_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return out;
}

/**
 * Net realized P&L for one closed position.
 *
 * Fees come from `fills.fees` and NOTHING is re-applied here. A brokerage fee
 * schedule is an ENTRY-TIME convenience: `FillDialog` computes the fee from the
 * account's schedule while the user types the fill, the user may override it,
 * and the result is stored on `fills.fees`. The schedule's job ends there.
 *
 * This function previously did `computeGrossPnl(...) − calculateFees(schedule)`,
 * which re-applied a modelled schedule on top of fees already recorded on the
 * fills — and, when an account had NO schedule, skipped fees entirely and
 * reported gross P&L. Either way performance disagreed with the account balance
 * (which has always been net of `fills.fees`), so the equity curve and the
 * balance did not tie out. `computePnlFromTotals` is now the single formula
 * across the ledger, position detail, and performance.
 *
 * `grossPnl` is still surfaced for the fee-attribution breakdown; it is the
 * pre-fee figure, and `fees` is the sum actually recorded on the fills.
 */
function classifyOne(position: SnapshotPosition): ClassifiedPosition {
  const minorUnits = getCurrencyMinorUnits(position.currency);
  const side = position.side as 'long' | 'short';
  const assetType = position.assetType as 'stock' | 'option';

  const totals = aggregateFills(position.fills);
  const grossPnl = computeGrossPnl(totals, side, assetType, minorUnits);

  const pnl = computePnlFromTotals(totals, side, assetType, minorUnits);
  const netPnl =
    pnl.realizedPnl === null
      ? new Decimal(0)
      : new Decimal(pnl.realizedPnl).toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP);

  // Recorded fees, derived so the breakdown still reconciles: gross − net.
  const fees = grossPnl.minus(netPnl);

  const classification = classifyPosition(netPnl, position.currency);

  return {
    id: position.id,
    currency: position.currency,
    netPnl,
    grossPnl,
    fees,
    closedAt: new Date(position.closedAt),
    classification,
  };
}

function computeGrossPnl(
  totals: FillTotals,
  side: 'long' | 'short',
  assetType: 'stock' | 'option',
  minorUnits: number,
): Decimal {
  const entryQty = new Decimal(totals.entryQty);
  const exitQty = new Decimal(totals.exitQty);
  if (entryQty.isZero() || exitQty.isZero()) return new Decimal(0);
  const avgEntryPrice = new Decimal(totals.entryCost).div(entryQty);
  const avgExitPrice = new Decimal(totals.exitCost).div(exitQty);
  const sideMultiplier = side === 'long' ? 1 : -1;
  const contractMultiplier = assetType === 'option' ? 100 : 1;
  return avgExitPrice
    .minus(avgEntryPrice)
    .times(exitQty)
    .times(sideMultiplier)
    .times(contractMultiplier)
    .toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP);
}

function buildCurrencyEntry(
  history: HistoryCurrency,
  positions: readonly ClassifiedPosition[],
  buckets: ReturnType<typeof generateBucketSeries>,
): PerformanceCurrency {
  const series: SeriesBucket[] = buckets.map((b) => ({
    bucketStart: b.label,
    netPnl: '0',
    grossPnl: '0',
    fees: '0',
    totalPositions: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
  }));

  const acc = buckets.map(() => ({
    net: new Decimal(0),
    gross: new Decimal(0),
    fees: new Decimal(0),
  }));

  const sorted = [...positions].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  let bucketIdx = 0;
  for (const p of sorted) {
    const t = p.closedAt.getTime();
    while (bucketIdx < buckets.length && buckets[bucketIdx]!.endInstant.getTime() <= t) {
      bucketIdx++;
    }
    if (bucketIdx >= buckets.length) break;
    const bucket = buckets[bucketIdx]!;
    if (t < bucket.startInstant.getTime()) continue;

    const a = acc[bucketIdx]!;
    a.net = a.net.plus(p.netPnl);
    a.gross = a.gross.plus(p.grossPnl);
    a.fees = a.fees.plus(p.fees);
    const s = series[bucketIdx]!;
    s.totalPositions++;
    if (p.classification === 'winning') s.wins++;
    else if (p.classification === 'losing') s.losses++;
    else s.breakevens++;
  }

  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    const a = acc[i]!;
    s.netPnl = a.net.toString();
    s.grossPnl = a.gross.toString();
    s.fees = a.fees.toString();
  }

  return {
    code: history.code,
    historyRange: {
      earliestClosedAt: history.earliestClosedAt,
      mostRecentClosedAt: history.mostRecentClosedAt,
      totalClosedPositions: history.totalClosedPositions,
    },
    series,
    equityCurve: buildCumulativeSeries(series),
    stats: computePositionSetStatistics(positions),
  };
}

function pickDefaultCurrency(currencies: readonly HistoryCurrency[]): string | null {
  if (currencies.length === 0) return null;
  const sorted = [...currencies].sort((a, b) => {
    const aMost = new Date(a.mostRecentClosedAt).getTime();
    const bMost = new Date(b.mostRecentClosedAt).getTime();
    if (aMost !== bMost) return bMost - aMost;
    if (a.totalClosedPositions !== b.totalClosedPositions) {
      return b.totalClosedPositions - a.totalClosedPositions;
    }
    return a.code.localeCompare(b.code);
  });
  return sorted[0]!.code;
}
