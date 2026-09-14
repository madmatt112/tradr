import { useNavigate } from '@tanstack/react-router';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';


import type { PerformanceQueryInput } from '@tradr/shared';

import { EmptyState } from '@/components/EmptyState';
import { Numeric } from '@/components/Numeric';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { moneyDirection } from '@/lib/format';
import { cn } from '@/lib/utils';

import { isInvalidTimezoneError, usePerformance } from '../hooks/usePerformance';
import {
  buildCalendarModel,
  type CalendarDay,
  type CalendarFigure,
} from '../utils/buildCalendarModel';
import { deriveCalendarWindow } from '../utils/deriveCalendarWindow';

import { pickActiveCurrency } from './PerformancePage';

// ---------------------------------------------------------------------------
// PnlCalendar (Design Component 13). R1, R2 on screen: a DOM grid, not a
// Recharts chart (R2.6). It issues its OWN day-granularity request for the
// displayed month (DD5) through the page's `usePerformance` hook — same tz,
// same currency, same rejected-timezone policy (R1.2, R1.9) — and projects the
// response with the pure `buildCalendarModel` (Component 12).
// ---------------------------------------------------------------------------

export interface PnlCalendarProps {
  /** The page's window: only `tz` and `currency` are read here. */
  params: PerformanceQueryInput;
  /** The displayed month, `YYYY-MM`, resolved from the route by the page. */
  month: string;
  /** Resolved week-start day from the page response (D6). */
  resolvedWeekStartDay: 0 | 1;
  /** `resolvedTimezone` from the page response. */
  timezone: string;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// Static per-direction accent classes. Tailwind cannot build class names
// dynamically, so each role token maps to a literal string it can see at build
// time (the `TagChip` colour-token-as-border precedent, TagChip.tsx:11-18).
const ACCENT_CLASS: Record<'gain' | 'loss' | 'flat', string> = {
  gain: 'border-gain',
  loss: 'border-loss',
  flat: 'border-flat',
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The `YYYY-MM` month shifted by `delta` months, year rollover handled. */
function shiftMonth(ym: string, delta: number): string {
  const [year, month1] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(year, month1 - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** "March 2026" for the header title. Formatted in UTC so no zone drift. */
function monthTitleOf(ym: string): string {
  const [year, month1] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month1 - 1, 1)));
}

/** The seven weekday headers plus "Week", rotated to `weekStartDay` (D6). */
function calendarHeaders(weekStartDay: 0 | 1): string[] {
  const days = Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(weekStartDay + i) % 7]);
  return [...days, 'Week'];
}

function positionsLabel(n: number): string {
  return `${n} ${n === 1 ? 'position' : 'positions'}`;
}

function figureOf(day: CalendarDay, figure: CalendarFigure): string {
  return figure === 'net' ? day.netPnl : day.grossPnl;
}

/**
 * The R2.4 accessible name: the date, the signed figure with its currency, and
 * the position count — so a screen reader conveys direction without colour. The
 * sign comes from `Intl.NumberFormat` `signDisplay: 'exceptZero'` (the
 * `formatAccounting` precedent, format.ts:48-55), so it is in the string, not
 * only in colour.
 */
function dayAccessibleName(day: CalendarDay, figure: CalendarFigure, currency: string): string {
  const fullDate = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day.date}T00:00:00.000Z`));
  if (day.noActivity) return `${fullDate}: no activity`;
  const signed = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
  }).format(Number(figureOf(day, figure)));
  return `${fullDate}: ${signed} ${currency}, ${positionsLabel(day.totalPositions)}`;
}

/**
 * PnlCalendar — a month calendar of P&L on the performance page.
 *
 * Preserves its grid geometry across loading, empty and error states (R1.11):
 * the skeleton mirrors the header block and a 6×8 grid; the empty month is the
 * normal grid with every cell "no activity" and a flat-zero total (R1.10); the
 * error state (503, network, 5xx or non-timezone 400) shows the header block
 * plus one eight-column message row with Retry. An `INVALID_TIMEZONE` failure
 * is the hook's retry path, not this error state — the page banner covers it.
 */
export function PnlCalendar({ params, month, resolvedWeekStartDay, timezone }: PnlCalendarProps) {
  const navigate = useNavigate({ from: '/performance' });
  const [figure, setFigure] = useState<CalendarFigure>('net');

  const calWindow = deriveCalendarWindow(month, new Date(), timezone);
  const dayParams: PerformanceQueryInput = {
    granularity: 'day',
    start: calWindow.start,
    end: calWindow.end,
    tz: params.tz,
    ...(params.currency !== undefined ? { currency: params.currency } : {}),
  };
  const { data, isLoading, isError, error, refetch } = usePerformance(dayParams);

  const monthTitle = monthTitleOf(month);
  const headers = calendarHeaders(resolvedWeekStartDay);

  const goToMonth = (delta: number) => {
    void navigate({ search: (prev) => ({ ...prev, month: shiftMonth(month, delta) }) });
  };

  const toggleButton = (value: CalendarFigure, label: string) => {
    const isActive = value === figure;
    return (
      <button
        key={value}
        type="button"
        role="tab"
        aria-selected={isActive}
        data-state={isActive ? 'active' : 'inactive'}
        data-testid={`calendar-figure-${value}`}
        onClick={() => setFigure(value)}
        className={cn(
          'cursor-pointer rounded-md px-3 py-1 text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isActive
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
      </button>
    );
  };

  const navButtonClass =
    'cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
    'disabled:cursor-not-allowed disabled:opacity-50';

  const renderHeader = (total: ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous month"
          data-testid="calendar-prev"
          disabled={calWindow.prevDisabled}
          onClick={() => goToMonth(-1)}
          className={navButtonClass}
        >
          <ChevronLeftIcon className="size-5" aria-hidden />
        </button>
        <h3 data-testid="calendar-month-title" className="text-lg font-semibold">
          {monthTitle}
        </h3>
        <button
          type="button"
          aria-label="Next month"
          data-testid="calendar-next"
          disabled={calWindow.nextDisabled}
          onClick={() => goToMonth(1)}
          className={navButtonClass}
        >
          <ChevronRightIcon className="size-5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {total}
        <div
          role="tablist"
          aria-label="Net or gross P&L"
          className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
        >
          {toggleButton('net', 'Net')}
          {toggleButton('gross', 'Gross')}
        </div>
      </div>
    </div>
  );

  const gridHeader = (
    <TableHeader>
      <TableRow>
        {headers.map((h) => (
          <TableHead key={h} className={h === 'Week' ? 'text-right' : undefined}>
            {h}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );

  // ---- Loading — same header block + a 6×8 skeleton grid (R1.11) ----------
  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="pnl-calendar-skeleton">
        {renderHeader(<Numeric.Skeleton />)}
        <Table role="grid" aria-label={`${monthTitle} (loading)`}>
          {gridHeader}
          <TableBody>
            {Array.from({ length: 6 }, (_, wi) => (
              <TableRow key={wi}>
                {Array.from({ length: 8 }, (_, ci) => (
                  <TableCell key={ci}>
                    <Skeleton className="h-10 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  // ---- Error — header block + an eight-column message row with Retry ------
  // INVALID_TIMEZONE is the hook's retry path (the page banner covers it), NOT
  // this state.
  if (isError && !isInvalidTimezoneError(error)) {
    return (
      <div className="space-y-3" data-testid="pnl-calendar-error">
        {renderHeader(<Numeric value={null} kind="money" />)}
        <Table role="grid" aria-label={monthTitle}>
          {gridHeader}
          <TableBody>
            <EmptyState.Table
              colSpan={8}
              message={
                <div className="flex flex-col items-center gap-2">
                  <span>Couldn&apos;t load this month.</span>
                  <button
                    type="button"
                    data-testid="calendar-retry"
                    onClick={() => void refetch()}
                    className={cn(
                      'cursor-pointer rounded-md border px-3 py-1 text-sm font-medium',
                      'text-foreground transition-colors hover:bg-muted',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                  >
                    Retry
                  </button>
                </div>
              }
            />
          </TableBody>
        </Table>
      </div>
    );
  }

  // The invalid-timezone error (page banner covers it) and any no-data case:
  // render nothing rather than an error card.
  if (!data) return null;

  // ---- Populated / empty-month path --------------------------------------
  const activeCurrency = pickActiveCurrency(data, params.currency);
  const series = activeCurrency?.series ?? [];
  const currency = activeCurrency?.code ?? params.currency ?? data.defaultCurrency ?? '';
  const model = buildCalendarModel(series, month, resolvedWeekStartDay, figure);

  const renderDayCell = (cell: CalendarDay | null, index: number) => {
    // Out-of-month slot — an empty, hidden cell (R1.4).
    if (cell === null) {
      return <TableCell key={`empty-${index}`} aria-hidden="true" />;
    }
    // No-activity day — the day number only, no accent (R1.3).
    if (cell.noActivity) {
      return (
        <TableCell key={cell.date} aria-label={dayAccessibleName(cell, figure, currency)}>
          <span className="text-sm text-muted-foreground">{cell.dayNumber}</span>
        </TableCell>
      );
    }
    const value = figureOf(cell, figure);
    const direction = moneyDirection(Number(value)) as 'gain' | 'loss' | 'flat';
    return (
      <TableCell
        key={cell.date}
        aria-label={dayAccessibleName(cell, figure, currency)}
        className={cn('border-l-4 align-top', ACCENT_CLASS[direction])}
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{cell.dayNumber}</span>
          <Numeric
            value={value}
            kind="money"
            currency={currency}
            direction="auto"
            className="text-sm"
          />
          <Numeric
            value={cell.totalPositions}
            kind="integer"
            direction="none"
            className="text-xs text-muted-foreground"
          />
        </div>
      </TableCell>
    );
  };

  const monthTotal = (
    <div className="flex items-center gap-2" data-testid="calendar-month-total">
      <Numeric value={model.monthTotal.figure} kind="money" currency={currency} direction="auto" />
      <span className="text-sm text-muted-foreground">
        {positionsLabel(model.monthTotal.positions)}
      </span>
    </div>
  );

  return (
    <div className="space-y-3" data-testid="pnl-calendar">
      {renderHeader(monthTotal)}
      <Table role="grid" aria-label={monthTitle}>
        {gridHeader}
        <TableBody>
          {model.weeks.map((week, wi) => (
            <TableRow key={wi}>
              {week.cells.map((cell, ci) => renderDayCell(cell, ci))}
              <TableCell
                className="text-right align-top font-medium"
                data-testid="calendar-week-total"
              >
                <div className="flex flex-col items-end gap-1">
                  <Numeric
                    value={week.total.figure}
                    kind="money"
                    currency={currency}
                    direction="auto"
                    className="text-sm"
                  />
                  <Numeric
                    value={week.total.positions}
                    kind="integer"
                    direction="none"
                    className="text-xs text-muted-foreground"
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default PnlCalendar;
