import { resolveTimezone } from '@tradr/shared';

import { localPartsInTz, localStartOfMonth, localStartOfTomorrow } from './derivePresetRange';

// Calendar window and month-param utilities (Design Component 11). The three
// wall-clock helpers come from `derivePresetRange`; nothing here duplicates them.

export interface CalendarWindow {
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC, clamped to local start-of-tomorrow
  nextDisabled: boolean;
  prevDisabled: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Parse a `YYYY-MM` month param. Returns `null` on anything else — a missing
 * value, the wrong shape, or a month outside 1–12.
 */
export function parseMonthParam(raw: string | undefined): { year: number; month1: number } | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month1 = Number(match[2]);
  if (month1 < 1 || month1 > 12) return null;
  return { year, month1 };
}

/**
 * The current month (`YYYY-MM`) in `tz`. Guards the zone the way
 * `resolveTimezone` does (schemas/performance.ts:10-17): an invalid IANA string
 * falls back to `UTC` before `localPartsInTz` reaches `new Intl.DateTimeFormat`
 * (derivePresetRange.ts:49-52), which throws `RangeError` on a bad zone.
 */
export function currentMonthInTz(now: Date, tz: string): string {
  let safeTz: string;
  try {
    safeTz = resolveTimezone(tz);
  } catch {
    safeTz = 'UTC';
  }
  const { year, month } = localPartsInTz(now, safeTz);
  return `${year}-${pad2(month)}`;
}

/**
 * The `granularity=day` request window for the calendar month `ym` (`YYYY-MM`)
 * in `tz`, plus the navigation-disabled flags.
 *
 * `end` is clamped to local start-of-tomorrow the way `derivePresetRange` clamps
 * (derivePresetRange.ts:182-189): the backend rejects a later `end` with
 * `END_BEYOND_TODAY_PLUS_ONE`. Next is disabled when the next month's local start
 * is on or after that clamp (DD13, `>=`: at equality the window would be
 * `[start, start)`, which `PerformanceQuerySchema` rejects with
 * `START_NOT_BEFORE_END`). Previous is disabled at the month containing
 * 2000-01-01 (`MIN_START`, schemas/performance.ts:242).
 */
export function deriveCalendarWindow(ym: string, now: Date, tz: string): CalendarWindow {
  const { year, month1 } = parseMonthParam(ym) ?? parseMonthParam(currentMonthInTz(now, tz))!;
  const start = localStartOfMonth(year, month1, tz);
  // `month1 + 1` overflows correctly (Date.UTC rolls the year, derivePresetRange.ts:100).
  const nextStart = localStartOfMonth(year, month1 + 1, tz);
  const maxEnd = localStartOfTomorrow(now, tz);
  const end = nextStart.getTime() > maxEnd.getTime() ? maxEnd : nextStart;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    nextDisabled: nextStart.getTime() >= maxEnd.getTime(),
    prevDisabled: ym <= '2000-01',
  };
}
