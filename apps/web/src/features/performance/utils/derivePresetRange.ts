import { fromZonedTime } from 'date-fns-tz';

import type { Granularity, PerformanceCurrency } from '@tradr/shared';

/**
 * Six preset ids the timeframe selector exposes (Design §Component 6.2):
 *   - daily      → 30d ending tomorrow-local-midnight (granularity=day)
 *   - weekly     → 12w ending next-week-start-local-midnight (granularity=week)
 *   - monthly    → 12m ending start-of-next-month-local-midnight (granularity=month)
 *   - yearly     → Jan 1 of earliest-history-year through next Jan 1 (granularity=year)
 *   - ytd        → Jan 1 of current year through next Jan 1 (granularity=month)
 *   - all-time   → startOfMonth(earliest) through start-of-next-month (granularity=month)
 */
export type PerformancePreset = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'ytd' | 'all-time';

export type CurrencyHistoryRange = PerformanceCurrency['historyRange'];

export const DEFAULT_CURRENCY_HISTORY_RANGE: CurrencyHistoryRange = {
  earliestClosedAt: null,
  mostRecentClosedAt: null,
  totalClosedPositions: 0,
};

export interface PresetRange {
  granularity: Granularity;
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
}

// ---- Local wall-clock helpers ----------------------------------------------
// Using `Intl.DateTimeFormat` to extract the wall-clock components of a UTC
// instant in `tz`. We then build the local boundary as a string of the form
// "YYYY-MM-DDTHH:mm:ss" and pass it to `fromZonedTime(string, tz)` which
// interprets the *string fields* as local-in-tz and returns the true UTC
// instant. This is the path date-fns-tz documents and it does NOT rely on
// the system timezone (the `Date(y, m, d)` constructor would).

interface LocalParts {
  year: number;
  month: number; // 1-indexed (Jan=1)
  day: number;
  weekday: number; // 0=Sun..6=Sat
}

const PARTS_DTF_CACHE = new Map<string, Intl.DateTimeFormat>();
function getPartsDtf(tz: string): Intl.DateTimeFormat {
  let dtf = PARTS_DTF_CACHE.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    PARTS_DTF_CACHE.set(tz, dtf);
  }
  return dtf;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localPartsInTz(utc: Date, tz: string): LocalParts {
  const parts = getPartsDtf(tz).formatToParts(utc);
  let year = 0;
  let month = 0;
  let day = 0;
  let weekday = 0;
  for (const p of parts) {
    if (p.type === 'year') year = Number(p.value);
    else if (p.type === 'month') month = Number(p.value);
    else if (p.type === 'day') day = Number(p.value);
    else if (p.type === 'weekday') weekday = WEEKDAY_INDEX[p.value] ?? 0;
  }
  return { year, month, day, weekday };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * UTC instant at local midnight of (year, month1Indexed, day) in `tz`.
 * `month1Indexed` is 1..12 to match the `Intl.DateTimeFormat` output and
 * keep the call sites obvious. Out-of-range month/day overflow correctly
 * because we let `Date.UTC` normalize first.
 */
function localMidnight(year: number, month1Indexed: number, day: number, tz: string): Date {
  // Normalize via Date.UTC so e.g. month=13 → next year, day=32 → next month.
  // The resulting epoch is then re-interpreted as a *local* string for tz.
  const normalizedMs = Date.UTC(year, month1Indexed - 1, day, 0, 0, 0, 0);
  const norm = new Date(normalizedMs);
  const isoLocal =
    `${norm.getUTCFullYear()}-` +
    `${pad2(norm.getUTCMonth() + 1)}-` +
    `${pad2(norm.getUTCDate())}T00:00:00`;
  return fromZonedTime(isoLocal, tz);
}

/** UTC instant at local 00:00 of the day-after `now` in `tz`. */
function localStartOfTomorrow(now: Date, tz: string): Date {
  const { year, month, day } = localPartsInTz(now, tz);
  return localMidnight(year, month, day + 1, tz);
}

/** UTC instant at local Jan 1 of `year` in `tz`. */
function localStartOfYear(year: number, tz: string): Date {
  return localMidnight(year, 1, 1, tz);
}

/** UTC instant at local first-of-month for (year, month1) in `tz`. */
function localStartOfMonth(year: number, month1: number, tz: string): Date {
  return localMidnight(year, month1, 1, tz);
}

/**
 * UTC instant at the *next* local week-start strictly after `now` in `tz`.
 * weekStartDay: 0 = Sunday, 1 = Monday.
 */
function nextLocalWeekStart(now: Date, tz: string, weekStartDay: 0 | 1): Date {
  const { year, month, day, weekday } = localPartsInTz(now, tz);
  // Days until the next occurrence of `weekStartDay` (strictly in the future):
  //   if today IS the week-start day, advance a full 7 days.
  let delta = (weekStartDay - weekday + 7) % 7;
  if (delta === 0) delta = 7;
  return localMidnight(year, month, day + delta, tz);
}

/** UTC instant at local first-of-month for the month *after* the one containing `now`. */
function localStartOfNextMonth(now: Date, tz: string): Date {
  const { year, month } = localPartsInTz(now, tz);
  return localStartOfMonth(year, month + 1, tz);
}

/**
 * The instant the history-anchored presets (`yearly`, `all-time`) start their
 * window from, CLAMPED TO `now`.
 *
 * `earliestClosedAt` is whatever the user typed into an exit fill, and nothing
 * stops that being a future date — a mistyped year on a close is the ordinary
 * way to get one. Anchoring on it directly puts `start` after the window's
 * `end`, which `buildRange` holds at local start-of-tomorrow, and the backend
 * rejects `start >= end` outright (`START_NOT_BEFORE_END`, a 400). Every widget
 * on the window then shows its error state, which is a worse answer than the
 * one the typo deserves.
 *
 * So: history that runs past today does not drag the start with it. An all-time
 * window means "from the earliest close the window can actually reach, through
 * the end of today" — the `end` bound already means future closes fall outside
 * any window the backend will accept, so a start beyond it could only ever
 * describe an empty range. History dated entirely in the future therefore
 * anchors exactly where no history anchors: the current month (or year), which
 * is a window the widgets render normally.
 */
function historyAnchor(earliestClosedAt: string | null, nowInstant: Date): Date {
  if (!earliestClosedAt) return nowInstant;
  const earliest = new Date(earliestClosedAt);
  // A malformed timestamp is not something to guess at either.
  if (Number.isNaN(earliest.getTime())) return nowInstant;
  return earliest.getTime() > nowInstant.getTime() ? nowInstant : earliest;
}

/**
 * Serialize a range, clamping `end` so it never exceeds `maxEnd`.
 *
 * The backend `PerformanceQuerySchema` rejects any `end` past local
 * midnight-of-tomorrow (today + 1 day) with a 400 VALIDATION_ERROR. Presets
 * like monthly / yearly / ytd / all-time compute `end` at a future month or
 * year boundary, so without this clamp the request 400s on almost every
 * calendar day. `end` is an *exclusive* upper bound, so clamping to local
 * start-of-tomorrow still includes all of today's data. `start` is untouched.
 */
function buildRange(granularity: Granularity, start: Date, end: Date, maxEnd: Date): PresetRange {
  const clampedEnd = end.getTime() > maxEnd.getTime() ? maxEnd : end;
  return {
    granularity,
    start: start.toISOString(),
    end: clampedEnd.toISOString(),
  };
}

/**
 * Pure preset → {granularity, start, end} resolver.
 *
 * No `Date.now()`. No side effects. All boundary math via date-fns-tz so DST
 * transitions and timezone offsets are honored.
 */
export function derivePresetRange(
  preset: PerformancePreset,
  currencyHistoryRange: CurrencyHistoryRange,
  nowInstant: Date,
  resolvedTz: string,
  resolvedWeekStartDay: 0 | 1,
): PresetRange {
  // Latest `end` the backend accepts: local start-of-tomorrow (today + 1 day).
  // This equals the `daily` preset's own end, so clamping to it is a no-op for
  // `daily` and a safety bound for every other preset (see `buildRange`).
  const maxEnd = localStartOfTomorrow(nowInstant, resolvedTz);
  switch (preset) {
    case 'daily': {
      const end = localStartOfTomorrow(nowInstant, resolvedTz);
      const { year, month, day } = localPartsInTz(end, resolvedTz);
      const start = localMidnight(year, month, day - 30, resolvedTz);
      return buildRange('day', start, end, maxEnd);
    }
    case 'weekly': {
      const end = nextLocalWeekStart(nowInstant, resolvedTz, resolvedWeekStartDay);
      const { year, month, day } = localPartsInTz(end, resolvedTz);
      const start = localMidnight(year, month, day - 12 * 7, resolvedTz);
      return buildRange('week', start, end, maxEnd);
    }
    case 'monthly': {
      const end = localStartOfNextMonth(nowInstant, resolvedTz);
      const { year, month } = localPartsInTz(end, resolvedTz);
      const start = localStartOfMonth(year, month - 12, resolvedTz);
      return buildRange('month', start, end, maxEnd);
    }
    case 'yearly': {
      const { year: currentYear } = localPartsInTz(nowInstant, resolvedTz);
      // If we have history, anchor the start year on the earliest closed
      // position; otherwise show the current year alone (Jan 1 → next Jan 1).
      // `historyAnchor` collapses the two when that close is in the future.
      const anchor = historyAnchor(currencyHistoryRange.earliestClosedAt, nowInstant);
      const startYear = localPartsInTz(anchor, resolvedTz).year;
      const start = localStartOfYear(startYear, resolvedTz);
      const end = localStartOfYear(currentYear + 1, resolvedTz);
      return buildRange('year', start, end, maxEnd);
    }
    case 'ytd': {
      const { year } = localPartsInTz(nowInstant, resolvedTz);
      const start = localStartOfYear(year, resolvedTz);
      const end = localStartOfYear(year + 1, resolvedTz);
      return buildRange('month', start, end, maxEnd);
    }
    case 'all-time': {
      const end = localStartOfNextMonth(nowInstant, resolvedTz);
      // No history — or history that is entirely in the future — → start =
      // current-month start (a one-month window). The empty-state UI takes over
      // either way; we just need a valid range.
      const anchor = historyAnchor(currencyHistoryRange.earliestClosedAt, nowInstant);
      const parts = localPartsInTz(anchor, resolvedTz);
      const start = localStartOfMonth(parts.year, parts.month, resolvedTz);
      return buildRange('month', start, end, maxEnd);
    }
  }
}
