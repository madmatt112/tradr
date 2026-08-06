// @vitest-environment jsdom
//
// user-onboarding R2.4 — the per-bucket P&L chart must bucket by the user's
// STORED reporting timezone. The configured timeframe still decides the
// granularity; only the zone the buckets are cut in changed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WidgetPlacement } from '@tradr/shared';

import { useDisplayCurrencyQuery } from '@/features/accounting/hooks/useDisplayCurrency';
import { usePerformance } from '@/features/performance/hooks/usePerformance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/features/accounting/hooks/useDisplayCurrency', () => ({
  useDisplayCurrencyQuery: vi.fn(),
}));
vi.mock('@/features/performance/hooks/usePerformance', () => ({
  usePerformance: vi.fn(),
}));

const timezoneState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => timezoneState.value,
}));

import PerformanceChartWidget from './PerformanceChartWidget';

type PerformanceResult = ReturnType<typeof usePerformance>;
type DisplayCurrencyResult = ReturnType<typeof useDisplayCurrencyQuery>;

const placement = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'performance-chart',
  x: 0,
  y: 0,
  w: 6,
  h: 4,
  config: { timeframe: 'weekly' },
} as unknown as WidgetPlacement;

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

beforeEach(() => {
  timezoneState.value = 'America/New_York';
  vi.mocked(useDisplayCurrencyQuery).mockReturnValue({
    data: { currency: 'USD' },
    isLoading: false,
  } as unknown as DisplayCurrencyResult);
  vi.mocked(usePerformance).mockReset();
  vi.mocked(usePerformance).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as PerformanceResult);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PerformanceChartWidget — reporting timezone', () => {
  it('sends the stored zone as `tz` and keeps the configured granularity', () => {
    timezoneState.value = 'Australia/Sydney';

    const { container, root } = mountWith(
      <PerformanceChartWidget placement={placement} onUpdateConfig={vi.fn()} />,
    );
    expect(vi.mocked(usePerformance).mock.calls[0]?.[0]).toMatchObject({
      tz: 'Australia/Sydney',
      // `weekly` still maps to week buckets — the preset logic is untouched.
      granularity: 'week',
      currency: 'USD',
    });
    unmount(container, root);
  });

  it('passes null (query disabled) and holds the skeleton while the zone is in flight', () => {
    timezoneState.value = undefined;

    const { container, root } = mountWith(
      <PerformanceChartWidget placement={placement} onUpdateConfig={vi.fn()} />,
    );
    expect(vi.mocked(usePerformance).mock.calls[0]?.[0]).toBeNull();
    expect(container.textContent).not.toContain('Close a position');
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    unmount(container, root);
  });
});
