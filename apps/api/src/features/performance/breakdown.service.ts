import {
  type BreakdownCurrency,
  type BreakdownQueryInput,
  type BreakdownResponse,
  type BreakdownRow,
  BreakdownResponseSchema,
} from '@tradr/shared';
import { type BreakdownPosition, groupPositions, orderGroups } from '@tradr/shared/lib/breakdown';
import { computeComplianceRate, computePositionSetStatistics } from '@tradr/shared/lib/performance';

import type { Database } from '@/db';
import { buildScoringContext, scorePosition } from '@/features/trading-rules/rule-evaluator';
import { loadScoringData } from '@/features/trading-rules/trading-rules.query';
import { config } from '@/lib/config';
import { ClientAbortError, TimeoutError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { fetchTimeframeSnapshot } from './performance.query';
import { classifyTimeframePositions, resolveRequestTimezone } from './performance.service';

// The scoring loop mirrors `classifyTimeframePositions`: it checks the abort and
// timeout signals every position and yields to the event loop once a chunk (the
// same 1000) and the same ten-second deadline the timeout middleware enforces.
const SCORING_CHUNK_SIZE = 1000;
const SCORING_TIMEOUT_MS = 10_000;

/**
 * Per-dimension performance breakdown for one window.
 *
 * The whole read path up to classification is `getPerformance`'s: one snapshot
 * read inside a `repeatable read`, `read only` transaction (NFR-Performance),
 * then the shared flat/realization walk. From there this service diverges in one
 * deliberate place (D7): the breakdown population is the flat-in-window set only,
 * whereas `getPerformance` counts every flat position the snapshot carries.
 * Nothing here computes a P&L or a statistic itself — every number is one
 * `computePositionSetStatistics` call over a grouped sub-population.
 */
export async function getBreakdown(
  db: Database,
  userId: string,
  input: BreakdownQueryInput,
  abortSignal: AbortSignal,
  startTime: number,
): Promise<BreakdownResponse> {
  const resolvedTimezone = resolveRequestTimezone(input.tz);
  const start = new Date(input.start);
  const end = new Date(input.end);

  // One snapshot read — the getPerformance transaction options without the
  // history-metadata query (DD4: the breakdown carries the currencies present in
  // its own population, not fetchHistoryMetadata's list).
  const snapshot = await db.transaction(
    async (tx) => fetchTimeframeSnapshot(tx, userId, start, end),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  const { flat } = await classifyTimeframePositions(snapshot.positions, abortSignal, startTime);

  // R3.3: the breakdown population is flat-in-`[start, end)` only. The `closed`
  // CTE also admits a position with only a fill in the window
  // (performance.query.ts:104-109) — getPerformance's stats count that position
  // and this filter drops it. That is the D7 divergence, and it lives only here.
  const population = flat.filter(
    (p) => p.closedAt.getTime() >= start.getTime() && p.closedAt.getTime() < end.getTime(),
  );

  // C7: `by=compliance` scores the flat-in-window population once, across every
  // currency, and stamps each position's live compliance status before it is
  // grouped. Every other dimension leaves the field absent, so `groupPositions`
  // files them all as `unscored`.
  if (input.by === 'compliance') {
    await scoreComplianceStatuses(db, userId, population, abortSignal, startTime);
  }

  // DD4: the currencies present in the population sorted by code, or exactly the
  // requested code — present or not.
  const currencyCodes = input.currency
    ? [input.currency]
    : [...new Set(population.map((p) => p.currency))].sort();

  const currencies: BreakdownCurrency[] = currencyCodes.map((code) => {
    const positionsOfCurrency = population.filter((p) => p.currency === code);
    const groups = orderGroups(
      input.by,
      groupPositions(input.by, positionsOfCurrency, resolvedTimezone, config.WEEK_START_DAY),
    );
    const rows: BreakdownRow[] = groups.map((g) => ({
      key: g.key,
      label: g.label,
      tag: g.tag,
      stats: computePositionSetStatistics(g.positions),
    }));
    return {
      code,
      total: computePositionSetStatistics(positionsOfCurrency),
      rows,
      // C7/D11: the compliance rate lives only on `by=compliance` — compliant
      // over compliant plus non-compliant, from the two scored rows' counts,
      // null on a zero sum. Other dimensions leave it absent.
      ...(input.by === 'compliance' ? { complianceRate: complianceRateFor(rows) } : {}),
    };
  });

  // DD11: the breakdown's dataQuality carries timeframeExcluded only. Parse on
  // the way out, the way getPerformance does.
  return BreakdownResponseSchema.parse({
    by: input.by,
    multiValued: input.by === 'tag',
    resolvedTimezone,
    resolvedWeekStartDay: config.WEEK_START_DAY,
    dataQuality: { timeframeExcluded: snapshot.timeframeExcluded },
    currencies,
  });
}

/**
 * Stamp each flat-in-window position with its live trading-rule compliance
 * status, in place (design C7). The scoring read is a SECOND `repeatable read`,
 * `read only` transaction, deliberately separate from the snapshot's (D10): a
 * scoring error must not be able to abort the snapshot read, and a position
 * changed between the two reads simply scores from the later one.
 *
 * The population is scored in chunks of 1000, checking the abort and timeout
 * signals every position and yielding to the event loop once a chunk — the same
 * shape `classifyTimeframePositions` uses. `TimeoutError` and `ClientAbortError`
 * propagate. Any other error is logged once with the user id and the population
 * size, and every position is left `unscored` (Requirement 7.4, 10.3).
 */
async function scoreComplianceStatuses(
  db: Database,
  userId: string,
  population: BreakdownPosition[],
  abortSignal: AbortSignal,
  startTime: number,
): Promise<void> {
  if (population.length === 0) return;

  try {
    const data = await db.transaction(
      async (tx) =>
        loadScoringData(
          tx,
          userId,
          population.map((p) => p.id),
        ),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    // No enabled rule: `loadScoringData` returns an empty population, nothing is
    // scored, and every position keeps the default `unscored` grouping.
    if (data.positions.length === 0) return;

    const ctx = buildScoringContext(data, config.WEEK_START_DAY);

    for (let i = 0; i < population.length; i++) {
      if (abortSignal.reason instanceof ClientAbortError) throw abortSignal.reason;
      if (Date.now() - startTime > SCORING_TIMEOUT_MS) throw new TimeoutError();
      if (abortSignal.reason instanceof TimeoutError) throw abortSignal.reason;

      population[i]!.compliance = scorePosition(ctx, population[i]!.id).status;

      if ((i + 1) % SCORING_CHUNK_SIZE === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } catch (error) {
    if (error instanceof TimeoutError || error instanceof ClientAbortError) throw error;
    logger.error('trading_rules_breakdown_scoring_failed', {
      userId,
      populationSize: population.length,
      error,
    });
    for (const p of population) p.compliance = 'unscored';
  }
}

/**
 * The compliance rate for one currency's rows: compliant over compliant plus
 * non-compliant (the two scored rows' counts), null on a zero sum (D11). The
 * `unscored` row never enters the ratio.
 */
function complianceRateFor(rows: readonly BreakdownRow[]): number | null {
  const countOf = (key: string) => rows.find((r) => r.key === key)?.stats.totalPositions ?? 0;
  return computeComplianceRate(countOf('compliant'), countOf('non_compliant'));
}
