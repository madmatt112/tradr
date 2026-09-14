// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceQueryInput, PerformanceResponse, SeriesBucket } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `useNavigate` is exercised by the month buttons; a spy keeps the component
// mountable without a router context and lets us assert the navigation patch.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// Mock the hook so each test dictates the `usePerformance` return shape, while
// keeping the real `isInvalidTimezoneError`. `usePerformanceArgs` records the
// request params so we can prove the net/gross toggle does not change them.
const useQueryMock = vi.fn();
const usePerformanceArgs = vi.fn();
vi.mock('../hooks/usePerformance', async () => {
  const actual =
    await vi.importActual<typeof import('../hooks/usePerformance')>('../hooks/usePerformance');
  return {
    ...actual,
    usePerformance: (...args: unknown[]) => {
      usePerformanceArgs(...args);
      return useQueryMock();
    },
  };
});

import { PnlCalendar } from './PnlCalendar';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARAMS: PerformanceQueryInput = {
  granularity: 'month',
  start: '2026-01-01T00:00:00.000Z',
  end: '2027-01-01T00:00:00.000Z',
  tz: 'UTC',
  currency: 'USD',
};

const STATS = {
  totalPositions: 0,
  totalNetPnl: '0',
  winRate: null,
  breakevenRate: null,
  avgWin: null,
  avgLoss: null,
  profitFactor: null,
  largestWin: null,
  largestLoss: null,
  hasWins: false,
  hasLosses: false,
};

function bucket(
  bucketStart: string,
  netPnl: string,
  grossPnl: string,
  fees: string,
  totalPositions: number,
): SeriesBucket {
  return { bucketStart, netPnl, grossPnl, fees, totalPositions, wins: 0, losses: 0, breakevens: 0 };
}

function buildDayResponse(series: SeriesBucket[]): PerformanceResponse {
  return {
    resolvedTimezone: 'UTC',
    resolvedWeekStartDay: 0,
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
        historyRange: { earliestClosedAt: null, mostRecentClosedAt: null, totalClosedPositions: 0 },
        series,
        equityCurve: [],
        stats: STATS,
      },
    ],
  };
}

// March 2026 with weekStartDay=0: Mar 1 is a Sunday, so days 1–7 fill row 0,
// days 8–14 row 1, etc. These three buckets place two trading days in week 0
// (Mar 2, Mar 5) and one in week 1 (Mar 9).
const SERIES = [
  bucket('2026-03-02', '100.00', '120.00', '20.00', 2),
  bucket('2026-03-05', '-30.00', '-25.00', '5.00', 1),
  bucket('2026-03-09', '200.00', '210.00', '10.00', 3),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function loaded(data: PerformanceResponse) {
  useQueryMock.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  navigateMock.mockReset();
  useQueryMock.mockReset();
  usePerformanceArgs.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PnlCalendar — figures and sums', () => {
  it('renders day figures and week/month totals from a hand-summed series', () => {
    loaded(buildDayResponse(SERIES));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );

    // Day cells carry the signed figure + count in their accessible name.
    expect(
      container.querySelector('[aria-label="March 2, 2026: +100.00 USD, 2 positions"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="March 5, 2026: -30.00 USD, 1 position"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="March 9, 2026: +200.00 USD, 3 positions"]'),
    ).not.toBeNull();

    // Month total = 100 - 30 + 200 = 270.00 over 6 positions.
    const monthTotal = container.querySelector('[data-testid="calendar-month-total"]')!;
    expect(monthTotal.textContent).toContain('$270.00');
    expect(monthTotal.textContent).toContain('6 positions');
    expect(monthTotal.querySelector('[data-testid="numeric"]')!.getAttribute('data-state')).toBe(
      'gain',
    );

    // Week totals: row 0 (Mar 2 + Mar 5) = 70.00 over 3; row 1 (Mar 9) = 200.00 over 3.
    const weekTotals = container.querySelectorAll('[data-testid="calendar-week-total"]');
    expect(weekTotals[0]!.textContent).toContain('$70.00');
    expect(weekTotals[0]!.textContent).toContain('3');
    expect(weekTotals[1]!.textContent).toContain('$200.00');

    unmount(container, root);
  });

  it('accent border follows the money direction of the displayed figure', () => {
    loaded(buildDayResponse(SERIES));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    const gainCell = container.querySelector(
      '[aria-label="March 2, 2026: +100.00 USD, 2 positions"]',
    )!;
    const lossCell = container.querySelector(
      '[aria-label="March 5, 2026: -30.00 USD, 1 position"]',
    )!;
    expect(gainCell.className).toContain('border-l-4');
    expect(gainCell.className).toContain('border-gain');
    expect(lossCell.className).toContain('border-loss');
    unmount(container, root);
  });

  it('a no-activity day shows the day number only with a "no activity" name', () => {
    loaded(buildDayResponse(SERIES));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    const idle = container.querySelector('[aria-label="March 1, 2026: no activity"]')!;
    expect(idle).not.toBeNull();
    // No accent on an idle day (R1.3).
    expect(idle.className).not.toContain('border-gain');
    expect(idle.className).not.toContain('border-loss');
    unmount(container, root);
  });
});

describe('PnlCalendar — net/gross toggle', () => {
  it('re-projects the same response without changing the request', () => {
    loaded(buildDayResponse(SERIES));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );

    // Net is the default.
    expect(
      container.querySelector('[aria-label="March 2, 2026: +100.00 USD, 2 positions"]'),
    ).not.toBeNull();
    const requestBefore = usePerformanceArgs.mock.calls[0]![0];

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-figure-gross"]')!.click();
    });

    // Now shows gross figures — a pure re-projection.
    expect(
      container.querySelector('[aria-label="March 2, 2026: +120.00 USD, 2 positions"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="calendar-month-total"]')!.textContent).toContain(
      '$305.00',
    );

    // The request params never changed — same key, so no refetch.
    const requestAfter = usePerformanceArgs.mock.calls.at(-1)![0];
    expect(requestAfter).toEqual(requestBefore);

    unmount(container, root);
  });
});

describe('PnlCalendar — navigation', () => {
  it('Next is disabled at the current-month boundary', () => {
    loaded(buildDayResponse([]));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-06" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-next"]')!.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-prev"]')!.disabled,
    ).toBe(false);
    unmount(container, root);
  });

  it('Previous is disabled at 2000-01', () => {
    loaded(buildDayResponse([]));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2000-01" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-prev"]')!.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-next"]')!.disabled,
    ).toBe(false);
    unmount(container, root);
  });

  it('pushes a month patch on Previous and Next (not replace)', () => {
    loaded(buildDayResponse([]));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-prev"]')!.click();
    });
    let arg = navigateMock.mock.calls[0]![0] as {
      search: (prev: unknown) => Record<string, unknown>;
      replace?: boolean;
    };
    expect(typeof arg.search).toBe('function');
    expect(arg.replace).toBeUndefined();
    expect(arg.search({ granularity: 'month', month: '2026-03' }).month).toBe('2026-02');

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-next"]')!.click();
    });
    arg = navigateMock.mock.calls[1]![0] as {
      search: (prev: unknown) => Record<string, unknown>;
      replace?: boolean;
    };
    expect(arg.search({ granularity: 'month', month: '2026-03' }).month).toBe('2026-04');
    // The patch preserves the rest of the search (…prev).
    expect(arg.search({ granularity: 'month', month: '2026-03' }).granularity).toBe('month');

    unmount(container, root);
  });
});

describe('PnlCalendar — states preserve eight-column geometry', () => {
  it('skeleton renders the header block and a 6×8 grid', () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    const skeleton = container.querySelector('[data-testid="pnl-calendar-skeleton"]')!;
    expect(skeleton).not.toBeNull();
    expect(skeleton.querySelector('[data-testid="calendar-month-title"]')!.textContent).toBe(
      'March 2026',
    );
    const rows = skeleton.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(6);
    expect(rows[0]!.children).toHaveLength(8);
    expect(skeleton.querySelectorAll('thead th')).toHaveLength(8);
    unmount(container, root);
  });

  it('empty month is the normal grid with a flat-zero total and eight columns', () => {
    loaded(buildDayResponse([]));
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    const grid = container.querySelector('[data-testid="pnl-calendar"]')!;
    expect(grid.querySelectorAll('thead th')).toHaveLength(8);
    expect(grid.querySelectorAll('tbody tr')[0]!.children).toHaveLength(8);
    const monthTotal = container.querySelector('[data-testid="calendar-month-total"]')!;
    expect(monthTotal.textContent).toContain('0 positions');
    expect(monthTotal.querySelector('[data-testid="numeric"]')!.getAttribute('data-state')).toBe(
      'flat',
    );
    unmount(container, root);
  });

  it('error state shows an eight-column message row with a working Retry', () => {
    const refetch = vi.fn();
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 503 },
      refetch,
    });
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    expect(container.querySelector('[data-testid="pnl-calendar-error"]')).not.toBeNull();
    const cell = container.querySelector<HTMLTableCellElement>(
      '[data-testid="table-empty-state"] td',
    )!;
    expect(cell.colSpan).toBe(8);
    expect(cell.textContent).toContain("Couldn't load this month.");

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="calendar-retry"]')!.click();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    unmount(container, root);
  });

  it('an INVALID_TIMEZONE failure is not this error state (page banner covers it)', () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { error: { code: 'INVALID_TIMEZONE' } },
      refetch: vi.fn(),
    });
    const { container, root } = mountWith(
      <PnlCalendar params={PARAMS} month="2026-03" resolvedWeekStartDay={0} timezone="UTC" />,
    );
    expect(container.querySelector('[data-testid="pnl-calendar-error"]')).toBeNull();
    unmount(container, root);
  });
});
