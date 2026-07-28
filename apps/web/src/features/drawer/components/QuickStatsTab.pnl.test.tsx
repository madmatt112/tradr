// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { usePerformance } from '@/features/performance/hooks/usePerformance';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useNow } from '@/hooks/useNow';

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
vi.mock('@/hooks/useNow', () => ({
  useNow: vi.fn(() => new Date('2026-05-27T12:00:00.000Z')),
}));

import { QuickStatsTab } from './QuickStatsTab';

type PerformanceResult = ReturnType<typeof usePerformance>;
type PositionsResult = ReturnType<typeof usePositions>;
type DisplayCurrencyResult = ReturnType<typeof useDisplayCurrencyQuery>;

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

function perfData(avgWin: string | null, avgLoss: string | null) {
  return {
    resolvedTimezone: 'UTC',
    resolvedWeekStartDay: 1 as 0 | 1,
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
        historyRange: { earliestClosedAt: null, mostRecentClosedAt: null, totalClosedPositions: 1 },
        series: [],
        equityCurve: [],
        stats: {
          totalPositions: 1,
          totalNetPnl: '0',
          winRate: 50,
          breakevenRate: null,
          avgWin,
          avgLoss,
          profitFactor: null,
          largestWin: null,
          largestLoss: null,
          hasWins: true,
          hasLosses: true,
        },
      },
    ],
  };
}

function mountStats(avgWin: string | null, avgLoss: string | null) {
  vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
    data: { currency: 'USD' },
    isLoading: false,
    error: null,
  } as unknown as DisplayCurrencyResult);
  vi.mocked(usePerformance).mockReturnValue({
    data: perfData(avgWin, avgLoss),
    isLoading: false,
    error: null,
  } as unknown as PerformanceResult);
  vi.mocked(usePositions).mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  } as unknown as PositionsResult);
  return mountWith(<QuickStatsTab />);
}

function numericIn(container: HTMLElement, testid: string): HTMLElement {
  return container
    .querySelector(`[data-testid="${testid}"]`)!
    .querySelector('[data-testid="numeric"]') as HTMLElement;
}

beforeEach(() => {
  vi.mocked(useNow).mockReturnValue(new Date('2026-05-27T12:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('QuickStatsTab — Avg Win/Loss render via <Numeric>', () => {
  it('gain (avgWin) / loss (avgLoss): sign + token per direction, no arrow glyph', () => {
    const { container, root } = mountStats('100.00', '-50.00');
    const win = numericIn(container, 'quick-stats-avg-win-value');
    expect(win.getAttribute('data-state')).toBe('gain');
    expect(win.className).toContain('text-gain');
    expect(win.textContent).toContain('+');
    expect(win.querySelector('svg')).toBeNull();

    const loss = numericIn(container, 'quick-stats-avg-loss-value');
    expect(loss.getAttribute('data-state')).toBe('loss');
    expect(loss.className).toContain('text-loss');
    expect(loss.textContent).toContain('−'); // U+2212
    expect(loss.querySelector('svg')).toBeNull();
    unmount(container, root);
  });

  it('flat (zero figure): literal 0.00 with no marker, never em-dash', () => {
    const { container, root } = mountStats('0.00', '0.00');
    const win = numericIn(container, 'quick-stats-avg-win-value');
    expect(win.getAttribute('data-state')).toBe('flat');
    expect(win.textContent).toContain('0.00');
    expect(win.textContent).not.toContain('—');
    unmount(container, root);
  });

  it('absent (no figure): the em-dash with no glyph', () => {
    const { container, root } = mountStats(null, null);
    const win = numericIn(container, 'quick-stats-avg-win-value');
    expect(win.getAttribute('data-state')).toBe('absent');
    expect(win.textContent).toContain('—');
    expect(win.querySelector('svg')).toBeNull();
    unmount(container, root);
  });
});
