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
import {
  aggregateFills,
  computePnlFromTotals,
  computeRealizationEvents,
  type FillTotals,
  type RealizationEvent,
} from '@/features/positions/pnl';
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
  for (const p of classified.flat) {
    const list = positionsByCurrency.get(p.currency);
    if (list) list.push(p);
    else positionsByCurrency.set(p.currency, [p]);
  }

  const realizationsByCurrency = new Map<string, RealizationEvent[]>();
  for (const r of classified.realizations) {
    const list = realizationsByCurrency.get(r.currency);
    if (list) list.push(r.event);
    else realizationsByCurrency.set(r.currency, [r.event]);
  }

  const currencies: PerformanceCurrency[] = selectedCurrencies.map((cur) =>
    buildCurrencyEntry(
      cur,
      positionsByCurrency.get(cur.code) ?? [],
      realizationsByCurrency.get(cur.code) ?? [],
      buckets,
    ),
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

/**
 * Walk the snapshot once, producing BOTH populations the two metric buckets
 * need (design: the bucket A/B split):
 *
 *  - `flat` — positions that are currently closed, for the per-trade statistics
 *    that only mean anything for a completed trade (win rate, profit factor,
 *    avg/largest win/loss, breakeven rate, counts). Unchanged behaviour.
 *  - `realizations` — every realization event across ALL relevant positions,
 *    open or closed, dated at the fill that produced it. This is what lets a
 *    partial exit move total P&L and the equity curve immediately instead of
 *    staying invisible until the position goes flat.
 */
async function classifyTimeframePositions(
  positions: readonly SnapshotPosition[],
  abortSignal: AbortSignal,
  startTime: number,
): Promise<{ flat: ClassifiedPosition[]; realizations: CurrencyRealization[] }> {
  const flat: ClassifiedPosition[] = [];
  const realizations: CurrencyRealization[] = [];

  for (let i = 0; i < positions.length; i++) {
    if (abortSignal.reason instanceof ClientAbortError) throw abortSignal.reason;
    if (Date.now() - startTime > TIMEOUT_MS) throw new TimeoutError();
    if (abortSignal.reason instanceof TimeoutError) throw abortSignal.reason;

    const position = positions[i]!;

    const classified = classifyOne(position);
    if (classified !== null) flat.push(classified);

    for (const event of computeRealizationEvents(
      position.fills.map((f) => ({ ...f, filledAt: new Date(f.filledAt) })),
      position.side as 'long' | 'short',
      position.assetType as 'stock' | 'option',
      getCurrencyMinorUnits(position.currency),
    )) {
      realizations.push({ currency: position.currency, event });
    }

    if ((i + 1) % CHUNK_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { flat, realizations };
}

interface CurrencyRealization {
  currency: string;
  event: RealizationEvent;
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
function classifyOne(position: SnapshotPosition): ClassifiedPosition | null {
  // Bucket A (design: "requires flat"). Keyed on the LATCHED flat snapshot, not
  // on live `closedAt`:
  //
  //  - Never flat  ⇒ no completed-trade outcome, contributes to none of the
  //    per-trade statistics. Its realized P&L still reaches bucket B via
  //    `computeRealizationEvents`.
  //  - Flat now    ⇒ the latch was written at its close; same value as
  //    recomputing, so the two agree.
  //  - Reopened    ⇒ the latch survives, so the position keeps reporting the
  //    result it had when it was last flat, until it goes flat again. Live
  //    `closedAt` is null here, and recomputing from the current fills would
  //    give a DIFFERENT number, which is exactly what must not happen.
  // The latch is an ENHANCEMENT, not a hard dependency: fall back to live
  // `closedAt` for any currently-flat position whose latch was never written
  // (rows predating the migration, seeds, or any future path that bypasses
  // closePositionTx). Only a position that is neither latched nor currently
  // flat is excluded.
  const flatAt =
    position.lastFlatAt ??
    (position.status === 'closed' && position.closedAt !== null ? position.closedAt : null);
  if (flatAt === null) return null;

  const minorUnits = getCurrencyMinorUnits(position.currency);
  const side = position.side as 'long' | 'short';
  const assetType = position.assetType as 'stock' | 'option';

  const totals = aggregateFills(position.fills);
  const grossPnl = computeGrossPnl(totals, side, assetType, minorUnits);

  // The frozen value when present. Null only for positions closed before the
  // latch migration, which backfilled `last_flat_at` but not the P&L — for a
  // position that is still flat those two agree, so recomputing is exact.
  const netPnl =
    position.lastFlatNetPnl !== null
      ? new Decimal(position.lastFlatNetPnl).toDecimalPlaces(minorUnits, Decimal.ROUND_HALF_UP)
      : new Decimal(computePnlFromTotals(totals, side, assetType, minorUnits).realizedPnl ?? 0);

  const fees = grossPnl.minus(netPnl);

  const classification = classifyPosition(netPnl, position.currency);

  return {
    id: position.id,
    currency: position.currency,
    netPnl,
    grossPnl,
    fees,
    closedAt: new Date(flatAt),
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

/**
 * Assemble one currency's series from the TWO populations (the bucket A/B
 * split):
 *
 *  - **Bucket B — P&L** (`netPnl`/`grossPnl`/`fees` per bucket, and therefore
 *    the equity curve and `stats.totalNetPnl`): driven by `realizations`, each
 *    bucketed at the fill that produced it. A partial exit lands in the bucket
 *    where it actually happened.
 *  - **Bucket A — counts and per-trade stats** (`totalPositions`/`wins`/
 *    `losses`/`breakevens`, win rate, profit factor, avg/largest win/loss):
 *    driven by `positions`, which contains only currently-flat positions,
 *    bucketed at `closedAt`. Unchanged.
 *
 * A bucket can therefore legitimately carry P&L with a zero position count —
 * that is a partial exit on a position that has not gone flat yet, and it is the
 * intended behaviour, not an inconsistency.
 */
function buildCurrencyEntry(
  history: HistoryCurrency,
  positions: readonly ClassifiedPosition[],
  realizations: readonly RealizationEvent[],
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

  /** Index of the bucket containing `t`, or -1 when outside the window. */
  const bucketIndexFor = (t: number): number => {
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      if (t >= b.startInstant.getTime() && t < b.endInstant.getTime()) return i;
    }
    return -1;
  };

  // Bucket B — P&L, from realization events at their own timestamps.
  for (const event of realizations) {
    const idx = bucketIndexFor(event.occurredAt.getTime());
    if (idx < 0) continue;
    const a = acc[idx]!;
    a.net = a.net.plus(event.netPnl);
    a.gross = a.gross.plus(event.grossPnl);
    a.fees = a.fees.plus(event.fees);
  }

  // Bucket A — counts and classification, from flat positions at closedAt.
  for (const p of positions) {
    const idx = bucketIndexFor(p.closedAt.getTime());
    if (idx < 0) continue;
    const s = series[idx]!;
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
    stats: {
      // Bucket A — every per-trade statistic, over flat positions only.
      ...computePositionSetStatistics(positions),
      // Bucket B — total P&L follows the realizations, so a partial exit counts
      // immediately. Summed from the series so it is identically the last point
      // of the equity curve; taking it from `computePositionSetStatistics`
      // would silently reinstate the flat-only population.
      totalNetPnl: series.reduce((sum, b) => sum.plus(b.netPnl), new Decimal(0)).toString(),
    },
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
