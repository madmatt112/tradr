// @vitest-environment jsdom
//
// The drawer's Quick Stats tab must actually cover all time.
//
// It is the same defect the dashboard's all-time widgets carried (see
// `features/dashboard/widgets/allTimeWindow.test.tsx`): the first request has to
// be built before any response exists, so it is built with
// `DEFAULT_CURRENCY_HISTORY_RANGE` — `earliestClosedAt: null`, which sends
// `derivePresetRange('all-time')` down its no-history branch and yields the
// CURRENT MONTH. This tab then requested one month and never asked again, so a
// user whose closes all predate this month read an em-dash for Win Rate, Avg Win
// and Avg Loss. On the 1st of any month that is every user.
//
// The assertions are on the WINDOW ASKED FOR, not merely on the tab rendering:
// the fault was in the request, and a mount-only test cannot see it.
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
} from '@tradr/shared';

import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { usePerformance } from '@/features/performance/hooks/usePerformance';
import { usePositions } from '@/features/positions/hooks/usePositions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/features/accounting/hooks/useDisplayCurrency', () => ({
  useDisplayCurrencyQuery: vi.fn(),
}));
vi.mock('@/features/performance/hooks/usePerformance', () => ({
  usePerformance: vi.fn(),
}));
vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

const timezoneState = vi.hoisted(() => ({ value: 'UTC' as string | undefined }));
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => timezoneState.value,
}));

import { QuickStatsTab } from './QuickStatsTab';

type PerformanceResult = ReturnType<typeof usePerformance>;
type PositionsResult = ReturnType<typeof usePositions>;
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
 * the requested window (`fetchHistoryMetadata` takes no start/end). That is what
 * makes the re-derive possible from the very first response — and what makes it
 * terminate, since the second response repeats it.
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
 * the statistics only ever cover the requested window.
 */
function serverResponse(params: PerformanceQueryInput): PerformanceResponse {
  const covered = closes.filter((c) => c.closedAt >= params.start && c.closedAt < params.end);
  const wins = covered.filter((c) => c.win);
  const losses = covered.filter((c) => !c.win);
  const total = covered.reduce((acc, c) => acc + Number(c.netPnl), 0);

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
        series: [],
        equityCurve: [],
        stats: {
          totalPositions: covered.length,
          totalNetPnl: total.toFixed(2),
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
 * re-renders exactly as TanStack Query's cache would.
 */
const responses = new Map<string, PerformanceResponse>();

/**
 * `usePerformance`, modelled on the one behaviour the re-derive's termination
 * argument turns on: A KEY CHANGE YIELDS `undefined` FIRST. A synchronous stub
 * cannot reach the moment after the window widens, when the new key has no data
 * and an un-latched read of `historyRange` would bounce back to the bootstrap
 * window whose key IS still cached — the oscillation the latch exists to
 * prevent. So this reports `isLoading` for a window it has not served and
 * resolves it a macrotask later; `settle()` drives those resolutions.
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

/** Every window the tab asked for, in order. */
function requestedWindows(): PerformanceQueryInput[] {
  return vi
    .mocked(usePerformance)
    .mock.calls.map((call) => call[0])
    .filter((params): params is PerformanceQueryInput => params !== null);
}

/**
 * The sequence of windows asked for, with CONSECUTIVE REPEATS COLLAPSED — one
 * entry per time the requested window actually changed, in order. De-duplicating
 * instead would throw away the order and the repeats together, so a bootstrap →
 * widened → bootstrap oscillation would read exactly like a derive that settled.
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
 * 400 (`START_NOT_BEFORE_END`) and the tab renders its Alert on it, so a derive
 * that produces one has broken the surface it was meant to fix.
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
 * without the tab asking for anything new. Returns whether it got there; a
 * derive that never quiesces is named by the request-sequence assertions rather
 * than by a timeout thrown from here.
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

async function mountAndSettle(): Promise<{
  container: HTMLElement;
  root: Root;
  quiesced: boolean;
}> {
  const { container, root } = mountWith(<QuickStatsTab />);
  const quiesced = await settle();
  return { container, root, quiesced };
}

function unmount(container: HTMLElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function valueOf(container: HTMLElement, slug: string): string {
  return container.querySelector(`[data-testid="quick-stats-${slug}-value"]`)?.textContent ?? '';
}

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
    error: null,
  } as unknown as DisplayCurrencyResult);
  vi.mocked(usePositions).mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  } as unknown as PositionsResult);
  vi.mocked(usePerformance).mockReset();
  vi.mocked(usePerformance).mockImplementation(useStubPerformance);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('QuickStatsTab — the all-time window reaches the reported history', () => {
  const BOOTSTRAP = '2026-08-01T00:00:00.000Z';
  const WIDENED = '2026-02-01T00:00:00.000Z';

  it('bootstraps at the current month, then re-derives back to the earliest close', async () => {
    const { container, root, quiesced } = await mountAndSettle();

    // The ordered sequence of windows, repeats collapsed — the bootstrap, then
    // the widened one, and then nothing. Any oscillation is a third entry.
    expect(windowStartRuns()).toEqual([BOOTSTRAP, WIDENED]);
    expect(quiesced, 'the tab stopped asking for new windows').toBe(true);

    // The window the tab settled on COVERS the history the response reported.
    // This is the assertion the defect fails: the bootstrap month starts five
    // months after the earliest close.
    const last = requestedWindows().at(-1)!;
    expect(last.start <= historyRange().earliestClosedAt!).toBe(true);
    expect(last.end > historyRange().mostRecentClosedAt!).toBe(true);
    // Still the STORED zone's month boundary, at the tab's own granularity.
    expect(last.tz).toBe('UTC');
    expect(last.granularity).toBe('month');

    unmount(container, root);
  });

  it('shows real figures rather than an em-dash for closes that predate this month', async () => {
    const { container, root } = await mountAndSettle();

    // The em-dash is what all three of these read before the fix.
    expect(valueOf(container, 'win-rate')).toBe('50.0%');
    expect(valueOf(container, 'avg-win')).toContain('$440.00');
    expect(valueOf(container, 'avg-loss')).toContain('$120.00');
    expect(container.textContent).not.toContain('No closed positions yet in USD.');

    unmount(container, root);
  });
});

describe('QuickStatsTab — a close dated in the future', () => {
  // Exit fills carry no future-date guard, so a mistyped year on a close is an
  // ordinary way to reach this. Anchoring `start` on a close that has not
  // happened yet puts it after `end` — held at the end of today — and the
  // backend rejects `start >= end` with a 400, which would take the whole tab
  // down to its Alert.
  const FUTURE_CLOSE: Close = { closedAt: '2027-03-04T15:00:00.000Z', netPnl: '75.00', win: true };

  it('a sole future-dated close leaves the tab on a valid current-month window', async () => {
    closes = [FUTURE_CLOSE];

    const { container, root, quiesced } = await mountAndSettle();

    expectEveryWindowValid();
    // The anchor is clamped to now, which is the window the bootstrap already
    // asked for: one window, and it settles there.
    expect(windowStartRuns()).toEqual(['2026-08-01T00:00:00.000Z']);
    expect(quiesced, 'the tab stopped asking for new windows').toBe(true);
    // It degrades to the ordinary em-dash, NOT to the error Alert.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(valueOf(container, 'win-rate')).toBe('—');

    unmount(container, root);
  });

  it('a future-dated close alongside real history still widens to the real earliest close', async () => {
    closes = [...CLOSES, FUTURE_CLOSE];

    const { container, root, quiesced } = await mountAndSettle();

    expectEveryWindowValid();
    // Clamping the ANCHOR, not the history: February is still reached.
    expect(windowStartRuns()).toEqual(['2026-08-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
    expect(quiesced, 'the tab stopped asking for new windows').toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(valueOf(container, 'win-rate')).toBe('50.0%');

    unmount(container, root);
  });
});
