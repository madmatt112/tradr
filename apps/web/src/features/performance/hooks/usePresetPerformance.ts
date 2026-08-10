import { useEffect, useState } from 'react';

import type { Granularity, PerformanceCurrency } from '@tradr/shared';

import {
  type CurrencyHistoryRange,
  DEFAULT_CURRENCY_HISTORY_RANGE,
  derivePresetRange,
  type PerformancePreset,
  type PresetRange,
} from '../utils/derivePresetRange';

import { usePerformance } from './usePerformance';

/**
 * The week-start the FIRST request is built with, before the server has said
 * which one it resolved. Only the `weekly` preset reads it.
 */
const BOOTSTRAP_WEEK_START = 1 as const;

/**
 * What the last response told us about the account, and therefore what the
 * window has to be re-derived from. Both fields are properties of the USER, not
 * of the window that was asked for: `/performance` computes `historyRange` over
 * every closed position regardless of `start`/`end` (see
 * `fetchHistoryMetadata`), and `resolvedWeekStartDay` is a stored preference.
 * That is what makes the re-derive terminate — see below.
 */
interface LearnedHistory {
  historyRange: CurrencyHistoryRange;
  weekStartDay: 0 | 1;
}

function sameHistory(a: LearnedHistory | null, b: LearnedHistory): boolean {
  return (
    a !== null &&
    a.weekStartDay === b.weekStartDay &&
    a.historyRange.earliestClosedAt === b.historyRange.earliestClosedAt &&
    a.historyRange.mostRecentClosedAt === b.historyRange.mostRecentClosedAt &&
    a.historyRange.totalClosedPositions === b.historyRange.totalClosedPositions
  );
}

export interface PresetPerformanceInput {
  /** Which window to ask for. `all-time` is the one that needs the re-derive. */
  preset: PerformancePreset;
  /** The user's STORED reporting timezone; `undefined` while it is in flight. */
  timezone: string | undefined;
  /** The display currency; `null` until it resolves. */
  currency: string | null;
  /**
   * Pins the bucket size independently of the preset. The stats and equity
   * widgets each want one fixed granularity out of an `all-time` window; the
   * chart widget takes whatever the preset implies.
   */
  granularity?: Granularity;
}

export interface PresetPerformanceResult {
  query: ReturnType<typeof usePerformance>;
  /** The currency's entry in the response, or `null` before one lands. */
  currencyData: PerformanceCurrency | null;
  /** The window currently being asked for; `null` while the zone is in flight. */
  range: PresetRange | null;
}

/**
 * `usePerformance`, with the window re-derived from the history the response
 * reports.
 *
 * THE BOOTSTRAP WINDOW IS NOT THE ANSWER. The first request has to be built
 * before any response exists, so it is built with
 * `DEFAULT_CURRENCY_HISTORY_RANGE` — whose `earliestClosedAt` is `null`, which
 * sends `derivePresetRange('all-time')` down its no-history branch and yields
 * the CURRENT MONTH. For anyone whose most recent close predates this month —
 * on the 1st of any month, everyone — that window is empty, and a widget
 * labelled "all-time" then draws bare axes and a collapsed stats panel. So the
 * response's real `historyRange` is latched here and the window re-derived from
 * it. That costs a second fetch, and latching is what stops it becoming an
 * endless series of them — see below.
 *
 * WHY IT TERMINATES, and why the learned value is held in state rather than
 * read straight off `query.data`. Reading it off the response would flip-flop:
 * changing the window changes the query key, TanStack Query reports `data:
 * undefined` for the new key, the widget would fall back to the bootstrap
 * window, that key is still cached, its data comes back, and the window widens
 * again — forever. Latching breaks that: the learned value only ever moves when
 * the server reports something DIFFERENT, and since it describes the account
 * rather than the window, the second response repeats what the first said and
 * the state update is skipped. Two fetches, then quiescence.
 *
 * WHAT THE LEARNED VALUE CANNOT DO IS PUSH THE WINDOW PAST TODAY. `historyRange`
 * is built from dates the user typed into exit fills, which carry no future-date
 * guard, so `earliestClosedAt` can be ahead of the clock — and a window whose
 * `start` lands after its `end` is a 400 (`START_NOT_BEFORE_END`) that would put
 * all three widgets into their error state. `derivePresetRange` clamps the
 * anchor it takes from history to `now` for exactly that reason; see
 * `historyAnchor` there for what an all-time window means in that case.
 *
 * The zone is NOT re-derived from the response (`resolvedTimezone`). Bucketing
 * follows the user's stored reporting timezone and nothing else; a `null`
 * params disables the query until it lands so nothing is ever bucketed by a
 * guess.
 */
export function usePresetPerformance({
  preset,
  timezone,
  currency,
  granularity,
}: PresetPerformanceInput): PresetPerformanceResult {
  const [learned, setLearned] = useState<LearnedHistory | null>(null);

  // `derivePresetRange` resolves calendar boundaries through `Intl`, so it
  // cannot run before the stored zone is known.
  const range = timezone
    ? derivePresetRange(
        preset,
        learned?.historyRange ?? DEFAULT_CURRENCY_HISTORY_RANGE,
        new Date(),
        timezone,
        learned?.weekStartDay ?? BOOTSTRAP_WEEK_START,
      )
    : null;

  const query = usePerformance(
    timezone && range
      ? {
          granularity: granularity ?? range.granularity,
          start: range.start,
          end: range.end,
          tz: timezone,
          ...(currency ? { currency } : {}),
        }
      : null,
  );

  const response = query.data;
  // `currencies` is an ARRAY, not a record keyed by currency code, so the entry
  // has to be matched with find() rather than indexed by `currency`.
  const currencyData =
    currency != null ? (response?.currencies.find((c) => c.code === currency) ?? null) : null;

  const reported = currencyData?.historyRange;
  const resolvedWeekStartDay = response?.resolvedWeekStartDay;

  useEffect(() => {
    if (!reported || resolvedWeekStartDay === undefined) return;
    const next: LearnedHistory = { historyRange: reported, weekStartDay: resolvedWeekStartDay };
    // The comparison is by VALUE, so a response that merely re-states what we
    // already know costs no render — which is what keeps the widened window
    // from being re-derived on every settle.
    setLearned((prev) => (sameHistory(prev, next) ? prev : next));
  }, [reported, resolvedWeekStartDay]);

  return { query, currencyData, range };
}
