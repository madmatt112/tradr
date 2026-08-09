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
import { act, useEffect, useState } from 'react';
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

interface Close {
  closedAt: string;
  netPnl: string;
  win: boolean;
}

/** Two closed positions, the most recent of them LAST month. */
const CLOSES: readonly Close[] = [
  { closedAt: '2026-02-19T18:20:00.000Z', netPnl: '440.00', win: true },
  { closedAt: '2026-07-08T19:00:00.000Z', netPnl: '-120.00', win: false },
];

/** The account the stub serves. A test may swap it before mounting. */
let closes: readonly Close[] = CLOSES;

/**
 * `historyRange` as the server reports it: over EVERY closed position, not over
 * the requested window (`fetchHistoryMetadata` takes no start/end). That is
 * what makes the re-derive possible from the very first response — and what
 * makes it terminate, since the second response repeats it.
 */
function historyRange(): PerformanceCurrency['historyRange'] {
  const dates = closes.map((c) => c.closedAt).sort();
  return {
    earliestClosedAt: dates[0] ?? null,
    mostRecentClosedAt: dates.at(-1) ?? null,
    totalClosedPositions: closes.length,
  };
}

/**
 * A stand-in for `GET /performance` faithful in the one respect this file turns
 * on: the currency entry and its `historyRange` are window-independent, while
 * the series, the equity curve and the statistics only ever contain what the
 * requested window covers.
 */
function serverResponse(params: PerformanceQueryInput): PerformanceResponse {
  const covered = closes.filter((c) => c.closedAt >= params.start && c.closedAt < params.end);
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
        historyRange: historyRange(),
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

/**
 * `usePerformance`, modelled on the one behaviour the design's termination
 * argument turns on: A KEY CHANGE YIELDS `undefined` FIRST.
 *
 * A synchronous stub — hand back the data for whatever window was asked for, in
 * the same render — cannot exercise that at all, and so cannot reach the state
 * the hook's latch exists to survive: the moment after the window widens, when
 * the new key has no data and the un-latched reading of `historyRange` would
 * fall back to the bootstrap window whose key IS still cached. That is the
 * oscillation. So this stub does what the real client does — reports
 * `isLoading` for a window it has not served before, and resolves it a
 * macrotask later — and `settle()` below drives those resolutions.
 *
 * It is written as a hook (it may call `useState`/`useEffect`) because it
 * stands in for one: `usePresetPerformance` calls it unconditionally on every
 * render, so the hook order is stable.
 */
function useStubPerformance(params: PerformanceQueryInput | null): PerformanceResult {
  const key = params === null ? null : JSON.stringify(params);
  const [, bump] = useState(0);

  useEffect(() => {
    if (key === null || responses.has(key)) return;
    let live = true;
    const timer = setTimeout(() => {
      if (!live) return;
      responses.set(key, serverResponse(JSON.parse(key) as PerformanceQueryInput));
      bump((n) => n + 1);
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);

  const data = key === null ? undefined : responses.get(key);
  return {
    data,
    isLoading: key !== null && data === undefined,
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

/**
 * The sequence of windows asked for, with CONSECUTIVE REPEATS COLLAPSED — one
 * entry per time the requested window actually changed, in order.
 *
 * This is the shape of the sequence, not its set of values, and the difference
 * is the whole point. De-duplicating instead (`new Set`) throws away the order
 * and the repeats together, so a bootstrap → widened → bootstrap oscillation
 * de-duplicates to two entries and reads exactly like a derive that settled
 * after one step. Collapsing runs keeps the transitions: that same oscillation
 * comes back as three, and `[bootstrap, widened]` is the only sequence that
 * means "widened once and stayed there". The render count is still ignored, so
 * the assertion does not turn on how many times React happened to re-render.
 */
function windowStartRuns(): string[] {
  const runs: string[] = [];
  for (const { start } of requestedWindows()) {
    if (runs.at(-1) !== start) runs.push(start);
  }
  return runs;
}

/**
 * Every window asked for was one the backend would accept. `start >= end` is a
 * 400 (`START_NOT_BEFORE_END`) and the widget renders its error state on it, so
 * a derive that produces one has broken the surface it was meant to fix.
 */
function expectEveryWindowValid(): void {
  for (const asked of requestedWindows()) {
    expect(
      asked.start < asked.end,
      `requested window ${asked.start} → ${asked.end} is not start-before-end`,
    ).toBe(true);
  }
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

/**
 * Let the stub's pending responses land, repeatedly, until a whole round passes
 * without the widget asking for anything new. Returns whether it got there.
 *
 * It deliberately does NOT throw at the bound. A derive that never quiesces has
 * to be reported by the request-sequence assertions — those are what name the
 * fault as an oscillation and show the windows it is bouncing between; a
 * timeout thrown from here would only say that something took too long.
 */
async function settle(maxRounds = 8): Promise<boolean> {
  for (let round = 0; round < maxRounds; round++) {
    const before = requestedWindows().length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (requestedWindows().length === before) return true;
  }
  return false;
}

async function mountAndSettle(
  ui: React.ReactElement,
): Promise<{ container: HTMLElement; root: Root; quiesced: boolean }> {
  const { container, root } = mountWith(ui);
  const quiesced = await settle();
  return { container, root, quiesced };
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
  closes = CLOSES;
  timezoneState.value = 'UTC';
  vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
    data: { currency: 'USD' },
    isLoading: false,
  } as unknown as DisplayCurrencyResult);
  vi.mocked(usePerformance).mockReset();
  vi.mocked(usePerformance).mockImplementation(useStubPerformance);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('all-time dashboard widgets — a last close in a previous month', () => {
  it('StatsSummaryWidget shows the tiles rather than "Close a position to see stats."', async () => {
    const { container, root } = await mountAndSettle(<StatsSummaryWidget />);

    expect(container.textContent).not.toContain('Close a position to see stats.');
    expect(container.querySelector('dl')).not.toBeNull();
    expect(container.textContent).toContain('Total Net P&L');
    expect(container.textContent).toContain('Win Rate');

    unmount(container, root);
  });

  it('EquityCurveWidget hands the chart a non-empty curve rather than bare axes', async () => {
    const { container, root } = await mountAndSettle(<EquityCurveWidget />);

    const chart = container.querySelector('[data-testid="equity-curve-chart"]');
    expect(chart).not.toBeNull();
    expect(Number(chart?.getAttribute('data-points'))).toBe(CLOSES.length);

    unmount(container, root);
  });

  it('PerformanceChartWidget on the all-time preset plots every bucket', async () => {
    const { container, root } = await mountAndSettle(
      <PerformanceChartWidget placement={chartPlacement('all-time')} onUpdateConfig={vi.fn()} />,
    );

    const chart = container.querySelector('[data-testid="performance-bar-chart"]');
    expect(chart).not.toBeNull();
    expect(Number(chart?.getAttribute('data-points'))).toBe(CLOSES.length);

    unmount(container, root);
  });
});

describe('all-time dashboard widgets — the window widens once historyRange arrives', () => {
  const BOOTSTRAP = '2026-08-01T00:00:00.000Z';
  const WIDENED = '2026-02-01T00:00:00.000Z';

  it('StatsSummaryWidget bootstraps at the current month, then re-derives back to the earliest close', async () => {
    const { container, root, quiesced } = await mountAndSettle(<StatsSummaryWidget />);

    // THE ORDERED SEQUENCE OF WINDOWS, repeats collapsed — the bootstrap, then
    // the widened one, and then nothing. Any oscillation is a third entry here:
    // widened → bootstrap → widened reads back as three transitions and fails,
    // where a de-duplicated list of the same run would still be two values and
    // pass. Termination is the main risk of a design that re-derives its own
    // query key from the response to that key, so it is asserted, not argued.
    expect(windowStartRuns()).toEqual([BOOTSTRAP, WIDENED]);
    expect(quiesced, 'the widget stopped asking for new windows').toBe(true);

    const last = requestedWindows().at(-1)!;
    expect(last.start <= historyRange().earliestClosedAt!).toBe(true);
    // The widened window is still the STORED zone's month boundary and still
    // carries the stored reporting zone — re-deriving must not reach for
    // `Intl.DateTimeFormat().resolvedOptions()` or for the response's own
    // `resolvedTimezone`.
    expect(last.tz).toBe('UTC');
    expect(last.granularity).toBe('year');

    unmount(container, root);
  });

  it('EquityCurveWidget re-derives the same widened window at month granularity', async () => {
    const { container, root, quiesced } = await mountAndSettle(<EquityCurveWidget />);

    expect(windowStartRuns()).toEqual([BOOTSTRAP, WIDENED]);
    expect(quiesced, 'the widget stopped asking for new windows').toBe(true);

    const last = requestedWindows().at(-1)!;
    expect(last.tz).toBe('UTC');
    expect(last.granularity).toBe('month');

    unmount(container, root);
  });

  it('PerformanceChartWidget on the all-time preset widens once and stops', async () => {
    const { container, root, quiesced } = await mountAndSettle(
      <PerformanceChartWidget placement={chartPlacement('all-time')} onUpdateConfig={vi.fn()} />,
    );

    expect(windowStartRuns()).toEqual([BOOTSTRAP, WIDENED]);
    expect(quiesced, 'the widget stopped asking for new windows').toBe(true);

    unmount(container, root);
  });

  it('re-derives in the stored zone, not the browser zone', async () => {
    // A zone far enough east that its month boundary is a different UTC instant
    // from the one a UTC browser would compute.
    timezoneState.value = 'Pacific/Kiritimati';

    const { container, root } = await mountAndSettle(<EquityCurveWidget />);

    const last = requestedWindows().at(-1)!;
    expect(last.tz).toBe('Pacific/Kiritimati');
    // 2026-02-01 00:00 at +14 is 2026-01-31 10:00Z.
    expect(last.start).toBe('2026-01-31T10:00:00.000Z');

    unmount(container, root);
  });

  it('leaves a preset that does not read historyRange on one window', async () => {
    // `monthly` is a rolling twelve months — nothing in the response can move
    // it, so the widget must not fire a second, identical request.
    const { container, root, quiesced } = await mountAndSettle(
      <PerformanceChartWidget placement={chartPlacement('monthly')} onUpdateConfig={vi.fn()} />,
    );

    expect(windowStartRuns()).toEqual(['2025-09-01T00:00:00.000Z']);
    expect(quiesced, 'the widget stopped asking for new windows').toBe(true);

    unmount(container, root);
  });
});

describe('all-time dashboard widgets — a close dated in the future', () => {
  // Exit fills carry no future-date guard, so a mistyped year on a close is an
  // ordinary way to reach this. Once the response's real `historyRange` drives
  // the window, anchoring `start` on a close that has not happened yet puts it
  // after `end` — which is held at the end of today — and the backend rejects
  // `start >= end` with a 400 START_NOT_BEFORE_END. All three widgets would
  // then show their error state on a surface that used to render.
  const FUTURE_CLOSE: Close = { closedAt: '2027-03-04T15:00:00.000Z', netPnl: '75.00', win: true };

  it('a sole future-dated close leaves the widgets on a valid current-month window', async () => {
    closes = [FUTURE_CLOSE];

    const { container, root, quiesced } = await mountAndSettle(<StatsSummaryWidget />);

    expectEveryWindowValid();
    // No widening to chase: the anchor is clamped to now, which is the window
    // the bootstrap already asked for. One window, and it settles there.
    expect(windowStartRuns()).toEqual(['2026-08-01T00:00:00.000Z']);
    expect(quiesced, 'the widget stopped asking for new windows').toBe(true);
    // It degrades to the ordinary "nothing closed yet" copy, NOT to the error
    // state — a typo in one date is not a reason to take the panel down.
    expect(container.textContent).toContain('Close a position to see stats.');
    expect(container.textContent).not.toContain("Couldn't load stats");

    unmount(container, root);
  });

  it('a future-dated close alongside real history still widens to the real earliest close', async () => {
    closes = [...CLOSES, FUTURE_CLOSE];

    const { container, root, quiesced } = await mountAndSettle(<EquityCurveWidget />);

    expectEveryWindowValid();
    // Clamping the ANCHOR, not the history: February is still reached.
    expect(windowStartRuns()).toEqual(['2026-08-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
    expect(quiesced, 'the widget stopped asking for new windows').toBe(true);
    expect(container.textContent).not.toContain("Couldn't load equity curve");
    const chart = container.querySelector('[data-testid="equity-curve-chart"]');
    // The two real closes are plotted; the future one is outside any window the
    // backend would accept, so it is simply not on the chart yet.
    expect(Number(chart?.getAttribute('data-points'))).toBe(CLOSES.length);

    unmount(container, root);
  });
});
