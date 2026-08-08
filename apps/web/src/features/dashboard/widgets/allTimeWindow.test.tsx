// @vitest-environment jsdom
//
// The dashboard's "all-time" widgets must actually cover all time.
//
// The first request has to be built before any response exists, so it is built
// with `DEFAULT_CURRENCY_HISTORY_RANGE` — `earliestClosedAt: null`, which sends
// `derivePresetRange('all-time')` down its no-history branch and yields the
// CURRENT MONTH. Every widget here then requested one month and never asked
// again, so a user whose most recent close predates this month saw bare axes
// and a collapsed stats panel under a label that said "all-time". On the 1st of
// any month that is every user, and it is what stopped the docs screenshot
// capture from reaching a painted dashboard.
//
// The fixture below is the shape that breaks it: the account's closes are in
// February and July, "today" is the 8th of August.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PerformanceCurrency,
  PerformanceQueryInput,
  PerformanceResponse,
  WidgetPlacement,
} from '@tradr/shared';

import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { usePerformance } from '@/features/performance/hooks/usePerformance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/features/accounting/hooks/useDisplayCurrency', () => ({
  useDisplayCurrencyQuery: vi.fn(),
}));
vi.mock('@/features/performance/hooks/usePerformance', () => ({
  usePerformance: vi.fn(),
}));

// Both charts are stubbed to report what they were HANDED rather than what
// Recharts manages to lay out in jsdom. "Draws axes only" is precisely an empty
// series reaching a live chart, so the series length is the assertion that
// matches the defect.
vi.mock('@/features/performance/components/EquityCurveChart', () => ({
  default: ({ series }: { series: readonly unknown[] }) => (
    <div data-testid="equity-curve-chart" data-points={series.length} />
  ),
}));
vi.mock('@/features/performance/components/PerformanceBarChart', () => ({
  default: ({ series }: { series: readonly unknown[] }) => (
    <div data-testid="performance-bar-chart" data-points={series.length} />
  ),
}));

const timezoneState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => timezoneState.value,
}));

import EquityCurveWidget from './EquityCurveWidget';
import PerformanceChartWidget from './PerformanceChartWidget';
import StatsSummaryWidget from './StatsSummaryWidget';

type PerformanceResult = ReturnType<typeof usePerformance>;
type DisplayCurrencyResult = ReturnType<typeof useDisplayCurrencyQuery>;

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

const NOW = '2026-08-08T12:00:00.000Z';

/** Two closed positions, the most recent of them LAST month. */
const CLOSES = [
  { closedAt: '2026-02-19T18:20:00.000Z', netPnl: '440.00', win: true },
  { closedAt: '2026-07-08T19:00:00.000Z', netPnl: '-120.00', win: false },
] as const;

/**
 * `historyRange` as the server reports it: over EVERY closed position, not over
 * the requested window (`fetchHistoryMetadata` takes no start/end). That is
 * what makes the re-derive possible from the very first response — and what
 * makes it terminate, since the second response repeats it.
 */
const HISTORY_RANGE: PerformanceCurrency['historyRange'] = {
  earliestClosedAt: CLOSES[0].closedAt,
  mostRecentClosedAt: CLOSES[1].closedAt,
  totalClosedPositions: CLOSES.length,
};

/**
 * A stand-in for `GET /performance` faithful in the one respect this file turns
 * on: the currency entry and its `historyRange` are window-independent, while
 * the series, the equity curve and the statistics only ever contain what the
 * requested window covers.
 */
function serverResponse(params: PerformanceQueryInput): PerformanceResponse {
  const covered = CLOSES.filter((c) => c.closedAt >= params.start && c.closedAt < params.end);
  let cumulative = 0;
  const equityCurve = covered.map((c) => {
    cumulative += Number(c.netPnl);
    return { bucketStart: c.closedAt, cumulativeNetPnl: cumulative.toFixed(2) };
  });
  const wins = covered.filter((c) => c.win);
  const losses = covered.filter((c) => !c.win);

  return {
    resolvedTimezone: params.tz,
    resolvedWeekStartDay: 1,
    dataQuality: {
      timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
      historyExcluded: { total: 0, closed_at_null: 0 },
    },
    hasAnyAccounts: true,
    hasAnyClosedPositions: true,
    hasAnyClosedPositionsInSupportedCurrency: true,
    defaultCurrency: 'USD',
    currencies: [
      {
        code: 'USD',
        historyRange: HISTORY_RANGE,
        series: covered.map((c) => ({
          bucketStart: c.closedAt,
          netPnl: c.netPnl,
          grossPnl: c.netPnl,
          fees: '0.00',
          totalPositions: 1,
          wins: c.win ? 1 : 0,
          losses: c.win ? 0 : 1,
          breakevens: 0,
        })),
        equityCurve,
        stats: {
          totalPositions: covered.length,
          totalNetPnl: cumulative.toFixed(2),
          winRate: covered.length ? Math.round((wins.length / covered.length) * 1000) / 10 : null,
          breakevenRate: covered.length ? 0 : null,
          avgWin: wins.length ? '440.00' : null,
          avgLoss: losses.length ? '-120.00' : null,
          profitFactor: losses.length ? 3.67 : null,
          largestWin: wins.length ? '440.00' : null,
          largestLoss: losses.length ? '-120.00' : null,
          hasWins: wins.length > 0,
          hasLosses: losses.length > 0,
        },
      },
    ],
  };
}

/**
 * One response object per distinct window, so `data` keeps its identity across
 * re-renders exactly as TanStack Query's cache would. Without that this stub
 * would hand back a fresh object every render and mask a re-derive that only
 * settles because the reference happened to be stable.
 */
const responses = new Map<string, PerformanceResponse>();

function disabled(): PerformanceResult {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as PerformanceResult;
}

/** Every window the widget under test asked for, in order. */
function requestedWindows(): PerformanceQueryInput[] {
  return vi
    .mocked(usePerformance)
    .mock.calls.map((call) => call[0])
    .filter((params): params is PerformanceQueryInput => params !== null);
}

function distinctStarts(): string[] {
  return [...new Set(requestedWindows().map((p) => p.start))];
}

function mountWith(ui: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function unmount(container: HTMLElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

const chartPlacement = (timeframe: string) =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    type: 'performance-chart',
    x: 0,
    y: 0,
    w: 6,
    h: 4,
    config: { timeframe },
  }) as unknown as WidgetPlacement;

beforeEach(() => {
  // Only `Date` is faked: React's scheduler needs its timers left alone.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  responses.clear();
  timezoneState.value = 'UTC';
  vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
    data: { currency: 'USD' },
    isLoading: false,
  } as unknown as DisplayCurrencyResult);
  vi.mocked(usePerformance).mockReset();
  vi.mocked(usePerformance).mockImplementation((params) => {
    if (params === null) return disabled();
    const key = JSON.stringify(params);
    let data = responses.get(key);
    if (!data) {
      data = serverResponse(params);
      responses.set(key, data);
    }
    return {
      data,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as PerformanceResult;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('all-time dashboard widgets — a last close in a previous month', () => {
  it('StatsSummaryWidget shows the tiles rather than "Close a position to see stats."', () => {
    const { container, root } = mountWith(<StatsSummaryWidget />);

    expect(container.textContent).not.toContain('Close a position to see stats.');
    expect(container.querySelector('dl')).not.toBeNull();
    expect(container.textContent).toContain('Total Net P&L');
    expect(container.textContent).toContain('Win Rate');

    unmount(container, root);
  });

  it('EquityCurveWidget hands the chart a non-empty curve rather than bare axes', () => {
    const { container, root } = mountWith(<EquityCurveWidget />);

    const chart = container.querySelector('[data-testid="equity-curve-chart"]');
    expect(chart).not.toBeNull();
    expect(Number(chart?.getAttribute('data-points'))).toBe(CLOSES.length);

    unmount(container, root);
  });

  it('PerformanceChartWidget on the all-time preset plots every bucket', () => {
    const { container, root } = mountWith(
      <PerformanceChartWidget placement={chartPlacement('all-time')} onUpdateConfig={vi.fn()} />,
    );

    const chart = container.querySelector('[data-testid="performance-bar-chart"]');
    expect(chart).not.toBeNull();
    expect(Number(chart?.getAttribute('data-points'))).toBe(CLOSES.length);

    unmount(container, root);
  });
});

describe('all-time dashboard widgets — the window widens once historyRange arrives', () => {
  it('StatsSummaryWidget bootstraps at the current month, then re-derives back to the earliest close', () => {
    const { container, root } = mountWith(<StatsSummaryWidget />);

    const starts = distinctStarts();
    // Exactly two windows: the bootstrap and the re-derived one. A third would
    // mean the derive is oscillating between them rather than settling.
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe('2026-08-01T00:00:00.000Z');
    expect(starts[1]).toBe('2026-02-01T00:00:00.000Z');

    const last = requestedWindows().at(-1)!;
    expect(last.start <= HISTORY_RANGE.earliestClosedAt!).toBe(true);
    // The widened window is still the STORED zone's month boundary and still
    // carries the stored zone (user-onboarding R2.4) — re-deriving must not
    // reach for `Intl.DateTimeFormat().resolvedOptions()` or for the response's
    // own `resolvedTimezone`.
    expect(last.tz).toBe('UTC');
    expect(last.granularity).toBe('year');

    unmount(container, root);
  });

  it('EquityCurveWidget re-derives the same widened window at month granularity', () => {
    const { container, root } = mountWith(<EquityCurveWidget />);

    const starts = distinctStarts();
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBe('2026-02-01T00:00:00.000Z');

    const last = requestedWindows().at(-1)!;
    expect(last.tz).toBe('UTC');
    expect(last.granularity).toBe('month');

    unmount(container, root);
  });

  it('re-derives in the stored zone, not the browser zone', () => {
    // A zone far enough east that its month boundary is a different UTC instant
    // from the one a UTC browser would compute.
    timezoneState.value = 'Pacific/Kiritimati';

    const { container, root } = mountWith(<EquityCurveWidget />);

    const last = requestedWindows().at(-1)!;
    expect(last.tz).toBe('Pacific/Kiritimati');
    // 2026-02-01 00:00 at +14 is 2026-01-31 10:00Z.
    expect(last.start).toBe('2026-01-31T10:00:00.000Z');

    unmount(container, root);
  });

  it('leaves a preset that does not read historyRange on one window', () => {
    // `monthly` is a rolling twelve months — nothing in the response can move
    // it, so the widget must not fire a second, identical request.
    const { container, root } = mountWith(
      <PerformanceChartWidget placement={chartPlacement('monthly')} onUpdateConfig={vi.fn()} />,
    );

    expect(distinctStarts()).toEqual(['2025-09-01T00:00:00.000Z']);

    unmount(container, root);
  });
});
