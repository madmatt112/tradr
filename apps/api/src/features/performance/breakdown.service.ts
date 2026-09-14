import {
  type BreakdownCurrency,
  type BreakdownQueryInput,
  type BreakdownResponse,
  type BreakdownRow,
  BreakdownResponseSchema,
} from '@tradr/shared';
import { groupPositions, orderGroups } from '@tradr/shared/lib/breakdown';
import { computePositionSetStatistics } from '@tradr/shared/lib/performance';

import type { Database } from '@/db';
import { config } from '@/lib/config';

import { fetchTimeframeSnapshot } from './performance.query';
import { classifyTimeframePositions, resolveRequestTimezone } from './performance.service';

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
