// @vitest-environment jsdom
//
// user-onboarding R2.4 — the equity curve must bucket by the user's STORED
// reporting timezone, not by whatever zone the current device reports.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import EquityCurveWidget from './EquityCurveWidget';

type PerformanceResult = ReturnType<typeof usePerformance>;
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

describe('EquityCurveWidget — reporting timezone', () => {
  it('sends the stored zone as `tz`', () => {
    timezoneState.value = 'Europe/Berlin';

    const { container, root } = mountWith(<EquityCurveWidget />);
    expect(vi.mocked(usePerformance).mock.calls[0]?.[0]).toMatchObject({
      tz: 'Europe/Berlin',
      granularity: 'month',
      currency: 'USD',
    });
    unmount(container, root);
  });

  it('passes null (query disabled) and holds the skeleton while the zone is in flight', () => {
    timezoneState.value = undefined;

    const { container, root } = mountWith(<EquityCurveWidget />);
    expect(vi.mocked(usePerformance).mock.calls[0]?.[0]).toBeNull();
    expect(container.textContent).not.toContain('Close a position');
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    unmount(container, root);
  });
});
