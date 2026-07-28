// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { usePerformance } from '@/features/performance/hooks/usePerformance';
import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useNow } from '@/hooks/useNow';
import { formatCurrency } from '@/lib/format';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/features/accounting/hooks/useDisplayCurrency', () => ({
  useDisplayCurrencyQuery: vi.fn(),
}));

vi.mock('@/features/performance/hooks/usePerformance', () => ({
  usePerformance: vi.fn(),
}));

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

vi.mock('@/hooks/useNow', () => ({
  useNow: vi.fn(() => new Date('2026-05-27T12:00:00.000Z')),
}));

import { QuickStatsTab } from './QuickStatsTab';

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

type PerformanceResult = ReturnType<typeof usePerformance>;
type PositionsResult = ReturnType<typeof usePositions>;
type DisplayCurrencyResult = ReturnType<typeof useDisplayCurrencyQuery>;

function makeStats(
  overrides: Partial<{
    winRate: number | null;
    avgWin: string | null;
    avgLoss: string | null;
  }> = {},
) {
  return {
    totalPositions: 0,
    totalNetPnl: '0',
    winRate: overrides.winRate ?? null,
    breakevenRate: null,
    avgWin: overrides.avgWin ?? null,
    avgLoss: overrides.avgLoss ?? null,
    profitFactor: null,
    largestWin: null,
    largestLoss: null,
    hasWins: false,
    hasLosses: false,
  };
}

function makePerformanceData(
  currencies: Array<{ code: string; stats: ReturnType<typeof makeStats> }>,
) {
  return {
    resolvedTimezone: 'UTC',
    resolvedWeekStartDay: 1 as 0 | 1,
    dataQuality: {
      timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
      historyExcluded: { total: 0, closed_at_null: 0 },
    },
    hasAnyAccounts: true,
    hasAnyClosedPositions: false,
    hasAnyClosedPositionsInSupportedCurrency: false,
    defaultCurrency: 'USD',
    currencies: currencies.map((c) => ({
      code: c.code,
      historyRange: {
        earliestClosedAt: null,
        mostRecentClosedAt: null,
        totalClosedPositions: 0,
      },
      series: [],
      equityCurve: [],
      stats: c.stats,
    })),
  };
}

function mockUSDDisplayCurrency() {
  vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
    data: { currency: 'USD' },
    isLoading: false,
    error: null,
  } as unknown as DisplayCurrencyResult);
}

beforeEach(() => {
  vi.mocked(useDisplayCurrencyQuery).mockReset();
  vi.mocked(usePerformance).mockReset();
  vi.mocked(usePositions).mockReset();
  vi.mocked(useNow).mockReset();
  vi.mocked(useNow).mockReturnValue(new Date('2026-05-27T12:00:00.000Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuickStatsTab', () => {
  it('renders all 4 skeleton placeholders while loading', () => {
    vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as DisplayCurrencyResult);
    vi.mocked(usePerformance).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    expect(container.querySelector('[data-testid="quick-stats-win-rate-skeleton"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-avg-win-skeleton"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-avg-loss-skeleton"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="quick-stats-open-notional-skeleton"]'),
    ).not.toBeNull();
    unmount(container, root);
  });

  it('renders a single destructive Alert when performanceQuery errors', () => {
    mockUSDDisplayCurrency();
    vi.mocked(usePerformance).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('perf boom'),
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBe(1);
    expect(alerts[0].textContent).toContain('perf boom');
    // No per-card value or skeleton testid in error state.
    expect(container.querySelector('[data-testid="quick-stats-win-rate-value"]')).toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-win-rate-skeleton"]')).toBeNull();
    unmount(container, root);
  });

  it('renders the empty-state copy when performance data has no entry for displayCurrency', () => {
    mockUSDDisplayCurrency();
    vi.mocked(usePerformance).mockReturnValue({
      data: makePerformanceData([]),
      isLoading: false,
      error: null,
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    expect(container.querySelector('[data-testid="quick-stats-win-rate-value"]')?.textContent).toBe(
      '—',
    );
    expect(container.querySelector('[data-testid="quick-stats-avg-win-value"]')?.textContent).toBe(
      '—',
    );
    expect(container.querySelector('[data-testid="quick-stats-avg-loss-value"]')?.textContent).toBe(
      '—',
    );
    expect(container.textContent).toContain('No closed positions yet in USD.');
    unmount(container, root);
  });

  it('renders populated closed-stats values for the USD entry', () => {
    mockUSDDisplayCurrency();
    vi.mocked(usePerformance).mockReturnValue({
      data: makePerformanceData([
        {
          code: 'USD',
          stats: makeStats({ winRate: 62.5, avgWin: '100.00', avgLoss: '-50.00' }),
        },
      ]),
      isLoading: false,
      error: null,
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    const winRateEl = container.querySelector('[data-testid="quick-stats-win-rate-value"]');
    expect(winRateEl).not.toBeNull();
    expect(winRateEl?.textContent).toBe('62.5%');
    // Avg Win/Loss now render through <Numeric>: the sign is lifted into the
    // reserved slot (`+`/`−`) and the magnitude body is suffix-less.
    const avgWin = container.querySelector('[data-testid="quick-stats-avg-win-value"]');
    expect(avgWin?.querySelector('[data-state="gain"]')).not.toBeNull();
    expect(avgWin?.textContent).toContain('+');
    expect(avgWin?.textContent).toContain('$100.00');
    const avgLoss = container.querySelector('[data-testid="quick-stats-avg-loss-value"]');
    expect(avgLoss?.querySelector('[data-state="loss"]')).not.toBeNull();
    expect(avgLoss?.textContent).toContain('−'); // U+2212
    expect(avgLoss?.textContent).toContain('$50.00');
    unmount(container, root);
  });

  it('computes Open Notional for a single stock position', () => {
    mockUSDDisplayCurrency();
    vi.mocked(usePerformance).mockReturnValue({
      data: makePerformanceData([{ code: 'USD', stats: makeStats() }]),
      isLoading: false,
      error: null,
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          assetType: 'stock',
          totalEntryQuantity: 100,
          totalExitQuantity: 0,
          avgEntryPrice: 10,
          accountCurrency: 'USD',
        }),
      ],
      isLoading: false,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    expect(
      container.querySelector('[data-testid="quick-stats-open-notional-value"]')?.textContent,
    ).toBe(formatCurrency(1000, 'USD'));
    unmount(container, root);
  });

  it('computes Open Notional for an option position with 100x multiplier', () => {
    mockUSDDisplayCurrency();
    vi.mocked(usePerformance).mockReturnValue({
      data: makePerformanceData([{ code: 'USD', stats: makeStats() }]),
      isLoading: false,
      error: null,
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: '00000000-0000-0000-0000-0000000000a1',
          assetType: 'option',
          totalEntryQuantity: 5,
          totalExitQuantity: 0,
          avgEntryPrice: 2,
          accountCurrency: 'USD',
        }),
      ],
      isLoading: false,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    expect(
      container.querySelector('[data-testid="quick-stats-open-notional-value"]')?.textContent,
    ).toBe(formatCurrency(1000, 'USD'));
    unmount(container, root);
  });

  it('renders the excluded-currency footnote when other-currency open positions exist', () => {
    mockUSDDisplayCurrency();
    vi.mocked(usePerformance).mockReturnValue({
      data: makePerformanceData([{ code: 'USD', stats: makeStats() }]),
      isLoading: false,
      error: null,
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: '00000000-0000-0000-0000-0000000000d1',
          accountCurrency: 'USD',
        }),
        makePosition({
          id: '00000000-0000-0000-0000-0000000000d2',
          accountCurrency: 'EUR',
        }),
        makePosition({
          id: '00000000-0000-0000-0000-0000000000d3',
          accountCurrency: 'EUR',
        }),
      ],
      isLoading: false,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    expect(container.textContent).toContain('2 position(s) in other currencies excluded.');
    unmount(container, root);
  });

  it('renders all 4 skeletons when displayCurrency resolves to null', () => {
    vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
      data: { currency: null },
      isLoading: false,
      error: null,
    } as unknown as DisplayCurrencyResult);
    vi.mocked(usePerformance).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    } as unknown as PerformanceResult);
    vi.mocked(usePositions).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<QuickStatsTab />);
    expect(container.querySelector('[data-testid="quick-stats-win-rate-skeleton"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-avg-win-skeleton"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-avg-loss-skeleton"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="quick-stats-open-notional-skeleton"]'),
    ).not.toBeNull();
    // No value testids should be present.
    expect(container.querySelector('[data-testid="quick-stats-win-rate-value"]')).toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-avg-win-value"]')).toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-avg-loss-value"]')).toBeNull();
    expect(container.querySelector('[data-testid="quick-stats-open-notional-value"]')).toBeNull();
    unmount(container, root);
  });
});
