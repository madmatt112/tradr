// @vitest-environment jsdom
//
// user-onboarding R2.4 — this widget must bucket by the user's STORED
// reporting timezone. It used to read `Intl.DateTimeFormat().resolvedOptions()
// .timeZone` at render time, so the same account showed different daily and
// weekly figures from a second machine, a VPN, or a trip abroad.
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

// `undefined` is the in-flight window the real hook exposes; it carries no
// client-side fallback on purpose.
const timezoneState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('@/hooks/useUserTimezone', () => ({
  useUserTimezone: () => timezoneState.value,
}));

import StatsSummaryWidget from './StatsSummaryWidget';

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

describe('StatsSummaryWidget — reporting timezone', () => {
  it('sends the stored zone as `tz`', () => {
    timezoneState.value = 'Asia/Tokyo';

    const { container, root } = mountWith(<StatsSummaryWidget />);
    expect(vi.mocked(usePerformance).mock.calls[0]?.[0]).toMatchObject({
      tz: 'Asia/Tokyo',
      granularity: 'year',
      currency: 'USD',
    });
    unmount(container, root);
  });

  it('derives a different all-time window for a different stored zone', () => {
    timezoneState.value = 'Pacific/Kiritimati';
    const first = mountWith(<StatsSummaryWidget />);
    const kiritimati = vi.mocked(usePerformance).mock.calls[0]?.[0];
    unmount(first.container, first.root);

    vi.mocked(usePerformance).mockClear();
    timezoneState.value = 'Pacific/Midway';
    const second = mountWith(<StatsSummaryWidget />);
    const midway = vi.mocked(usePerformance).mock.calls[0]?.[0];
    unmount(second.container, second.root);

    // +14 vs -11: the month boundary lands on a different UTC instant, which
    // is exactly the bucket shift this task removes.
    expect(kiritimati?.end).not.toBe(midway?.end);
  });

  it('passes null (query disabled) and holds the skeleton while the zone is in flight', () => {
    timezoneState.value = undefined;

    const { container, root } = mountWith(<StatsSummaryWidget />);
    expect(vi.mocked(usePerformance).mock.calls[0]?.[0]).toBeNull();
    // A disabled query reports isLoading:false, so without an explicit wait the
    // widget would flash its "Close a position…" empty state.
    expect(container.textContent).not.toContain('Close a position');
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    unmount(container, root);
  });
});
