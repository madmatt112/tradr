// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { SeriesBucket } from '@tradr/shared';

import { buildCalendarModel, type CalendarDay, type CalendarModel } from './buildCalendarModel';
import { sumDecimalStrings } from './decimalSum';

function bucket(
  bucketStart: string,
  netPnl: string,
  grossPnl: string,
  fees: string,
  totalPositions: number,
): SeriesBucket {
  return { bucketStart, netPnl, grossPnl, fees, totalPositions, wins: 0, losses: 0, breakevens: 0 };
}

function dayCell(model: CalendarModel, dayNumber: number): CalendarDay | null {
  for (const week of model.weeks) {
    for (const cell of week.cells) {
      if (cell && cell.dayNumber === dayNumber) return cell;
    }
  }
  return null;
}

describe('buildCalendarModel — row alignment', () => {
  it('starts rows on Sunday and pads with null out-of-month slots (weekStartDay=0)', () => {
    // Jan 1 2026 is a Thursday → 4 leading nulls, 4 + 31 = 35 cells = 5 weeks.
    const model = buildCalendarModel([], '2026-01', 0, 'net');
    expect(model.weekdayHeaders).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(model.weeks).toHaveLength(5);
    expect(model.weeks[0]!.cells.slice(0, 4)).toEqual([null, null, null, null]);
    expect(model.weeks[0]!.cells[4]!.dayNumber).toBe(1);
    expect(model.weeks[4]!.cells[6]!.dayNumber).toBe(31);
  });

  it('rotates headers and leading slots for a Monday week start (weekStartDay=1)', () => {
    // Feb 1 2026 is a Sunday → weekStartDay=1 gives 6 leading nulls, 6 + 28 = 34
    // → padded to 35, so the last cell is a trailing null.
    const model = buildCalendarModel([], '2026-02', 1, 'net');
    expect(model.weekdayHeaders).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(model.weeks).toHaveLength(5);
    expect(model.weeks[0]!.cells.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(model.weeks[0]!.cells[6]!.dayNumber).toBe(1);
    expect(model.weeks[4]!.cells[5]!.dayNumber).toBe(28);
    expect(model.weeks[4]!.cells[6]).toBeNull();
  });

  it('renders an empty month as all no-activity cells and a flat-zero total (R1.10)', () => {
    const model = buildCalendarModel([], '2026-02', 0, 'net');
    expect(model.weeks[0]!.cells[0]!.dayNumber).toBe(1); // Feb 1 is Sunday → no leading null
    expect(model.monthTotal).toEqual({ figure: '0', positions: 0 });
    for (const week of model.weeks) {
      for (const cell of week.cells) {
        if (cell) expect(cell.noActivity).toBe(true);
      }
    }
  });
});

describe('buildCalendarModel — D10 no-activity', () => {
  const series = [
    bucket('2026-01-01', '100.00', '110.00', '10.00', 2), // trading day
    bucket('2026-01-02', '0.00', '0.00', '0.00', 0), // all zero → no activity
    bucket('2026-01-03', '0.00', '0.00', '5.00', 0), // fees only → trading day
    bucket('2026-01-04', '0.00', '0.00', '0.00', 1), // positions only → trading day
  ];

  it('flags D10 days and treats zero-figure trading days as activity', () => {
    const model = buildCalendarModel(series, '2026-01', 0, 'net');
    expect(dayCell(model, 1)!.noActivity).toBe(false);
    expect(dayCell(model, 2)!.noActivity).toBe(true);
    expect(dayCell(model, 3)!.noActivity).toBe(false); // fees keep it a trading day
    expect(dayCell(model, 4)!.noActivity).toBe(false); // positions keep it a trading day
  });

  it('treats a day absent from the series as no activity with a zero figure', () => {
    const model = buildCalendarModel(series, '2026-01', 0, 'net');
    const absent = dayCell(model, 15)!;
    expect(absent.noActivity).toBe(true);
    expect(absent.netPnl).toBe('0');
    expect(absent.totalPositions).toBe(0);
  });
});

describe('buildCalendarModel — totals', () => {
  const series = [
    bucket('2026-01-01', '100.00', '110.00', '10.00', 2),
    bucket('2026-01-02', '0.00', '0.00', '0.00', 0),
    bucket('2026-01-03', '0.00', '0.00', '0.00', 0),
    bucket('2026-01-04', '0.00', '0.00', '0.00', 1),
  ];

  it('sums week and month totals over in-month cells for the chosen figure', () => {
    const model = buildCalendarModel(series, '2026-01', 0, 'net');
    // Week 0 (leading 4): day1, day2, day3.
    expect(model.weeks[0]!.total).toEqual({ figure: '100.00', positions: 2 });
    // Week 1: day4 (+ absent days).
    expect(model.weeks[1]!.total).toEqual({ figure: '0.00', positions: 1 });
    expect(model.monthTotal).toEqual({ figure: '100.00', positions: 3 });
  });

  it('projects the gross figure when asked', () => {
    const model = buildCalendarModel(series, '2026-01', 0, 'gross');
    expect(model.monthTotal.figure).toBe('110.00');
  });
});

describe('buildCalendarModel — R1.5 month-total invariant', () => {
  const series = [
    bucket('2026-01-05', '12.34', '15.00', '2.66', 1),
    bucket('2026-01-06', '-7.5', '-5.25', '2.25', 1),
    bucket('2026-01-20', '100', '100', '0', 1),
  ];

  it('monthTotal.figure equals the exact summer over the series figure (net)', () => {
    const model = buildCalendarModel(series, '2026-01', 0, 'net');
    expect(model.monthTotal.figure).toBe(sumDecimalStrings(series.map((b) => b.netPnl)));
  });

  it('monthTotal.figure equals the exact summer over the series figure (gross)', () => {
    // Week start does not affect the month total.
    const model = buildCalendarModel(series, '2026-01', 1, 'gross');
    expect(model.monthTotal.figure).toBe(sumDecimalStrings(series.map((b) => b.grossPnl)));
  });
});
