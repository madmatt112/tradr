import type { SeriesBucket } from '@tradr/shared';

import { sumDecimalStrings } from './decimalSum';

// Calendar grid model (Design Component 12). A pure projection of a
// `granularity=day` series into a month grid, keyed on the local `YYYY-MM-DD`
// label `generateBucketSeries` writes (lib/performance.ts:88), so there is no
// date math on instants.

export type CalendarFigure = 'net' | 'gross';

export interface CalendarDay {
  date: string; // YYYY-MM-DD
  dayNumber: number;
  netPnl: string;
  grossPnl: string;
  totalPositions: number;
  noActivity: boolean;
}

export interface CalendarWeek {
  cells: (CalendarDay | null)[]; // out-of-month slots are null
  total: { figure: string; positions: number };
}

export interface CalendarModel {
  weeks: CalendarWeek[];
  monthTotal: { figure: string; positions: number };
  weekdayHeaders: string[];
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// A `decimalString` is zero when it carries no non-zero digit (`'0'`, `'0.00'`,
// `'-0.0'`). Exact and cheap; avoids re-scaling for the D10 check.
function isZeroDecimal(v: string): boolean {
  for (const ch of v) {
    if (ch >= '1' && ch <= '9') return false;
  }
  return true;
}

function figureOf(day: CalendarDay, figure: CalendarFigure): string {
  return figure === 'net' ? day.netPnl : day.grossPnl;
}

/**
 * Project `series` (a `granularity=day` response for the same month) into the
 * grid for `ym` (`YYYY-MM`). Rows start on `weekStartDay` (D6); leading and
 * trailing out-of-month slots are `null` and count for nothing (R1.4). A day
 * absent from the series is a `noActivity` cell (D10, future days after the
 * window clamp). Week and month totals sum the in-month cells' chosen figure
 * with the exact `sumDecimalStrings` (no float, R1.5).
 */
export function buildCalendarModel(
  series: readonly SeriesBucket[],
  ym: string,
  weekStartDay: 0 | 1,
  figure: CalendarFigure,
): CalendarModel {
  const [yearStr, monthStr] = ym.split('-');
  const year = Number(yearStr);
  const month1 = Number(monthStr);

  const byDate = new Map<string, SeriesBucket>();
  for (const bucket of series) byDate.set(bucket.bucketStart, bucket);

  // Both are pure calendar facts, independent of any timezone.
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
  const leading = (firstWeekday - weekStartDay + 7) % 7;

  const cells: (CalendarDay | null)[] = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${pad2(month1)}-${pad2(d)}`;
    const bucket = byDate.get(date);
    if (bucket) {
      cells.push({
        date,
        dayNumber: d,
        netPnl: bucket.netPnl,
        grossPnl: bucket.grossPnl,
        totalPositions: bucket.totalPositions,
        noActivity:
          bucket.totalPositions === 0 &&
          isZeroDecimal(bucket.netPnl) &&
          isZeroDecimal(bucket.grossPnl) &&
          isZeroDecimal(bucket.fees),
      });
    } else {
      cells.push({
        date,
        dayNumber: d,
        netPnl: '0',
        grossPnl: '0',
        totalPositions: 0,
        noActivity: true,
      });
    }
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const inMonthTotal = (group: (CalendarDay | null)[]): { figure: string; positions: number } => {
    const days = group.filter((c): c is CalendarDay => c !== null);
    return {
      figure: sumDecimalStrings(days.map((c) => figureOf(c, figure))),
      positions: days.reduce((sum, c) => sum + c.totalPositions, 0),
    };
  };

  const weeks: CalendarWeek[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    const rowCells = cells.slice(i, i + 7);
    weeks.push({ cells: rowCells, total: inMonthTotal(rowCells) });
  }

  return {
    weeks,
    monthTotal: inMonthTotal(cells),
    weekdayHeaders: Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(weekStartDay + i) % 7]),
  };
}
