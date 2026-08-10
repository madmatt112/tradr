// @vitest-environment jsdom
import { Component, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceQueryInput, PerformanceResponse } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Tier state is test-configurable (sibling-surface pattern): `undefined`
// (self-host / loading) and `purchasable: false` hide the upgrade CTA;
// `purchasable: true` shows it (REQ-11.5 — no dead-end links).
const { tierData } = vi.hoisted(() => ({
  tierData: { current: undefined as unknown },
}));
vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData.current }),
}));

// TanStack Router's `useNavigate` is exercised inside the selectors. We don't
// test navigation here (TimeframeSelector / CurrencySelector tests cover that)
// — a no-op spy keeps the selectors mountable without a router context. `Link`
// backs the TierWindowNotice upgrade CTA (rest props keep its data-testid).
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  Link: ({
    to,
    onClick,
    children,
    ...rest
  }: {
    to: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    children: React.ReactNode;
  }) => (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

// Replace the chart's lazy chunk with a synchronous stub so jsdom doesn't have
// to resolve a real `import('./EquityCurveChart')`. The stub renders a marker
// div; tests assert presence of either the marker (happy path) OR the skeleton
// (loading state) OR the chunk-stale banner (boundary path).
vi.mock('@/features/performance/components/EquityCurveChart', () => ({
  default: () => <div data-testid="equity-curve-chart-stub" />,
}));

// Stub the shadcn Select primitive — Radix relies on pointer-event machinery
// missing from jsdom. We only need a rendered select-shaped surface for the
// happy-path test; we don't exercise option clicks here.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid="select-root" data-value={value}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="currency-selector" className={className}>
      {children}
    </div>
  ),
  SelectValue: () => null,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`currency-option-${value}`}>{children}</div>
  ),
}));

// Mock the hook so each test can dictate the `usePerformance` return shape.
const useQueryMock = vi.fn();
vi.mock('../hooks/usePerformance', async () => {
  const actual =
    await vi.importActual<typeof import('../hooks/usePerformance')>('../hooks/usePerformance');
  return {
    ...actual,
    usePerformance: () => useQueryMock(),
  };
});

import { __resetInvalidTimezoneState, recordRejectedTimezone } from '@/lib/invalidTimezone';
import { captureClientEvent } from '@/lib/telemetry/posthog';

import { ChartChunkStaleBanner } from './ChartChunkStaleBanner';
import { ChartErrorBoundary, PerformancePage } from './PerformancePage';

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

function buildResponse(overrides: Partial<PerformanceResponse> = {}): PerformanceResponse {
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
        historyRange: {
          earliestClosedAt: '2025-01-01T00:00:00.000Z',
          mostRecentClosedAt: '2026-04-01T00:00:00.000Z',
          totalClosedPositions: 12,
        },
        series: [
          {
            bucketStart: '2026-03-01T00:00:00.000Z',
            netPnl: '125.50',
            grossPnl: '150.00',
            fees: '24.50',
            totalPositions: 4,
            wins: 3,
            losses: 1,
            breakevens: 0,
          },
        ],
        equityCurve: [{ bucketStart: '2026-03-01T00:00:00.000Z', cumulativeNetPnl: '125.50' }],
        stats: {
          totalPositions: 4,
          totalNetPnl: '125.50',
          winRate: 75.0,
          breakevenRate: 0.0,
          avgWin: '50.00',
          avgLoss: '-25.00',
          profitFactor: 6.0,
          largestWin: '60.00',
          largestLoss: '-25.00',
          hasWins: true,
          hasLosses: true,
        },
      },
    ],
    ...overrides,
  };
}

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

beforeEach(() => {
  navigateMock.mockReset();
  useQueryMock.mockReset();
  vi.mocked(captureClientEvent).mockClear();
  sessionStorage.clear();
  __resetInvalidTimezoneState();
  tierData.current = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerformancePage — loading state', () => {
  it('renders skeletons while the query is loading', () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    expect(container.querySelector('[data-testid="performance-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="equity-curve-chart-skeleton"]')).not.toBeNull();
    // Selectors are NOT rendered while loading — banners and selectors require
    // post-fetch fields (resolvedTimezone, currencies, …).
    expect(container.querySelector('[data-testid="timeframe-selector"]')).toBeNull();
    unmount(container, root);
  });
});

describe('PerformancePage — happy path', () => {
  it('renders selectors, chart, stats, and breakdown when populated', async () => {
    useQueryMock.mockReturnValue({
      data: buildResponse(),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);

    // Wait a microtask so React.lazy / Suspense can resolve the stub.
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="performance-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeframe-selector"]')).not.toBeNull();
    // Single-currency response → CurrencySelector renders the static label
    // form. The dropdown form is exercised in CurrencySelector.test.tsx.
    expect(container.querySelector('[data-testid="currency-selector-static"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stats-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="breakdown-table"]')).not.toBeNull();
    // The lazy-import stub becomes the chart's children once Suspense resolves.
    expect(container.querySelector('[data-testid="equity-curve-chart-stub"]')).not.toBeNull();

    unmount(container, root);
  });
});

describe('PerformancePage — empty-state branches', () => {
  it('renders no-accounts branch when !hasAnyAccounts', () => {
    useQueryMock.mockReturnValue({
      data: buildResponse({
        hasAnyAccounts: false,
        hasAnyClosedPositions: false,
        hasAnyClosedPositionsInSupportedCurrency: false,
        currencies: [],
        defaultCurrency: null,
      }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    expect(
      container.querySelector('[data-testid="performance-empty-state-no-accounts"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="timeframe-selector"]')).toBeNull();
    unmount(container, root);
  });

  it('renders no-closed-positions branch when accounts exist but no closes', () => {
    useQueryMock.mockReturnValue({
      data: buildResponse({
        hasAnyAccounts: true,
        hasAnyClosedPositions: false,
        hasAnyClosedPositionsInSupportedCurrency: false,
        currencies: [],
        defaultCurrency: null,
      }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    expect(
      container.querySelector('[data-testid="performance-empty-state-no-closed-positions"]'),
    ).not.toBeNull();
    unmount(container, root);
  });

  it('renders unsupported-currency branch when closes exist in unsupported currencies only', () => {
    useQueryMock.mockReturnValue({
      data: buildResponse({
        hasAnyAccounts: true,
        hasAnyClosedPositions: true,
        hasAnyClosedPositionsInSupportedCurrency: false,
        currencies: [],
        defaultCurrency: null,
      }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    expect(
      container.querySelector('[data-testid="performance-empty-state-unsupported-currency"]'),
    ).not.toBeNull();
    unmount(container, root);
  });

  it('renders in-timeframe-empty branch when active currency has empty series', () => {
    const data = buildResponse();
    // Wipe the active currency's series to flip into the in-timeframe-empty
    // branch while keeping all upstream flags satisfied.
    data.currencies[0]!.series = [];
    useQueryMock.mockReturnValue({
      data,
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    expect(
      container.querySelector('[data-testid="performance-empty-state-in-timeframe-empty"]'),
    ).not.toBeNull();
    // Selectors should NOT render in the empty-state path — empty-state
    // composition replaces the populated view entirely.
    expect(container.querySelector('[data-testid="timeframe-selector"]')).toBeNull();
    unmount(container, root);
  });
});

describe('PerformancePage — tier lookback clamp notice (plan-tiers REQ-7.3)', () => {
  const TIER_WINDOW = {
    clamped: true as const,
    effectiveStart: '2026-01-16T00:00:00.000Z',
    lookbackMonths: 6,
  };

  it('renders the non-blocking notice alongside the data when tierWindow is present', async () => {
    tierData.current = { purchasable: true };
    useQueryMock.mockReturnValue({
      data: buildResponse({ tierWindow: TIER_WINDOW }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    await act(async () => {
      await Promise.resolve();
    });

    const notice = container.querySelector('[data-testid="tier-window-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Showing the last 6 months');
    // Non-blocking: presets stay selectable and the clamped data still renders.
    expect(container.querySelector('[data-testid="timeframe-selector"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stats-panel"]')).not.toBeNull();

    // The upgrade CTA fires the D17 funnel event with this surface's identity.
    const cta = container.querySelector<HTMLAnchorElement>(
      '[data-testid="upgrade-cta-performance"]',
    );
    expect(cta).not.toBeNull();
    act(() => {
      cta!.click();
    });
    expect(captureClientEvent).toHaveBeenCalledWith('upgrade_cta_clicked', {
      surface: 'performance',
    });

    unmount(container, root);
  });

  it('keeps the clamp text but omits the upgrade CTA when Pro is not purchasable (REQ-11.5)', async () => {
    // Gated Stripe-less instance: tierWindow is enforced but the subscription
    // is not purchasable — no dead-end upgrade link.
    tierData.current = { purchasable: false };
    useQueryMock.mockReturnValue({
      data: buildResponse({ tierWindow: TIER_WINDOW }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    await act(async () => {
      await Promise.resolve();
    });

    const notice = container.querySelector('[data-testid="tier-window-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Showing the last 6 months');
    expect(container.querySelector('[data-testid="upgrade-cta-performance"]')).toBeNull();

    unmount(container, root);
  });

  it('omits the upgrade CTA while tier state is absent (self-host / still loading)', async () => {
    // beforeEach left tierData.current undefined — the sibling-surface default.
    useQueryMock.mockReturnValue({
      data: buildResponse({ tierWindow: TIER_WINDOW }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="tier-window-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="upgrade-cta-performance"]')).toBeNull();

    unmount(container, root);
  });

  it('renders the deliberate empty state WITH the same notice for a fully-pre-boundary preset', () => {
    // The floor clamped the whole window away: empty-but-marked series.
    const data = buildResponse({ tierWindow: TIER_WINDOW });
    data.currencies[0]!.series = [];
    data.currencies[0]!.equityCurve = [];
    useQueryMock.mockReturnValue({
      data,
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);

    expect(
      container.querySelector('[data-testid="performance-empty-state-in-timeframe-empty"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="tier-window-notice"]')).not.toBeNull();
    unmount(container, root);
  });

  it('renders no notice when tierWindow is absent (unclamped / gating off)', async () => {
    useQueryMock.mockReturnValue({
      data: buildResponse(),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="tier-window-notice"]')).toBeNull();
    unmount(container, root);
  });
});

describe('PerformancePage — INVALID_TIMEZONE error path', () => {
  it('renders InvalidTimezoneBanner when isError + INVALID_TIMEZONE code', () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { error: { code: 'INVALID_TIMEZONE' } },
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    expect(container.querySelector('[data-testid="invalid-timezone-banner"]')).not.toBeNull();
    unmount(container, root);
  });

  it('flips into second-failure mode only when THIS zone is the rejected one', () => {
    // The request that failed had already dropped `tz`, so it was the server's
    // own default that was rejected — which is exactly what the copy claims.
    recordRejectedTimezone(PARAMS.tz);
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { error: { code: 'INVALID_TIMEZONE' } },
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    const banner = container.querySelector('[data-testid="invalid-timezone-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('data-second-failure')).toBe('true');
    unmount(container, root);
  });

  it('keeps the settings remedy reachable when a DIFFERENT zone is the recorded one', () => {
    // A rejection recorded against the zone the user has since left must not
    // relabel a fresh failure as "the server rejected UTC as well" — this
    // request still CARRIED the user's zone, so profile settings is the fix.
    recordRejectedTimezone('Foo/Bar');
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { error: { code: 'INVALID_TIMEZONE' } },
    });
    const { container, root } = mountWith(
      <PerformancePage params={{ ...PARAMS, tz: 'Europe/London' }} />,
    );
    const banner = container.querySelector('[data-testid="invalid-timezone-banner"]');
    expect(banner?.getAttribute('data-second-failure')).toBeNull();
    expect(
      container.querySelector('[data-testid="invalid-timezone-banner-settings-link"]'),
    ).not.toBeNull();
    unmount(container, root);
  });
});

describe('PerformancePage — UTC fallback success path (REQ-5.6)', () => {
  it('renders InvalidTimezoneBanner alongside data when the tz-omitted retry succeeded', async () => {
    // The hook's retry policy recorded this zone before retrying with `tz` omitted.
    const params: PerformanceQueryInput = { ...PARAMS, tz: 'Europe/London' };
    recordRejectedTimezone(params.tz);

    // Request asked for a non-UTC tz; server resolved to UTC because the
    // retry omitted `tz`. Banner should render in first-failure mode (the
    // request succeeded, so the user sees the informational copy).
    useQueryMock.mockReturnValue({
      data: buildResponse({ resolvedTimezone: 'UTC' }),
      isLoading: false,
      isError: false,
      error: null,
    });

    const { container, root } = mountWith(<PerformancePage params={params} />);
    await act(async () => {
      await Promise.resolve();
    });

    const banner = container.querySelector('[data-testid="invalid-timezone-banner"]');
    expect(banner).not.toBeNull();
    // First-failure mode: dismissible, no `data-second-failure` attribute.
    expect(banner?.getAttribute('data-second-failure')).toBeNull();
    // The remedy this whole banner state exists to carry.
    expect(
      container.querySelector('[data-testid="invalid-timezone-banner-settings-link"]'),
    ).not.toBeNull();
    // Data still renders alongside the banner.
    expect(container.querySelector('[data-testid="stats-panel"]')).not.toBeNull();
    unmount(container, root);
  });

  it('still reaches the settings remedy when sessionStorage reads throw (Safari private)', async () => {
    const params: PerformanceQueryInput = { ...PARAMS, tz: 'Europe/London' };
    recordRejectedTimezone(params.tz);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reads throw, so only the in-memory fallback knows the zone was rejected.
    // Reading through a different accessor than the request used is what made
    // this banner unreachable in this mode.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    useQueryMock.mockReturnValue({
      data: buildResponse({ resolvedTimezone: 'UTC' }),
      isLoading: false,
      isError: false,
      error: null,
    });

    const { container, root } = mountWith(<PerformancePage params={params} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="invalid-timezone-banner-settings-link"]'),
    ).not.toBeNull();
    unmount(container, root);
  });

  it('does NOT render InvalidTimezoneBanner when the requested tz matches resolved tz', async () => {
    // Zone recorded but the request used the same tz the server resolved to —
    // means the page recovered without the swap; no banner needed.
    recordRejectedTimezone(PARAMS.tz);
    useQueryMock.mockReturnValue({
      data: buildResponse({ resolvedTimezone: 'UTC' }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(<PerformancePage params={PARAMS} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="invalid-timezone-banner"]')).toBeNull();
    unmount(container, root);
  });

  it('drops the banner once the rejection no longer names this zone', async () => {
    // What the user sees after correcting the preference: the record was
    // cleared, the sidebar re-seeded a new zone, and the UTC notice goes away
    // instead of following them around for the rest of the tab session.
    recordRejectedTimezone('Foo/Bar');
    useQueryMock.mockReturnValue({
      data: buildResponse({ resolvedTimezone: 'UTC' }),
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container, root } = mountWith(
      <PerformancePage params={{ ...PARAMS, tz: 'Europe/London' }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="invalid-timezone-banner"]')).toBeNull();
    unmount(container, root);
  });
});

describe('ChartErrorBoundary — Vite chunk-404 detection', () => {
  it('renders ChartChunkStaleBanner when child throws "Failed to fetch dynamically imported module"', () => {
    function Boom(): never {
      throw new Error('Failed to fetch dynamically imported module: /assets/chart-abc.js');
    }
    // Suppress React's expected error-log spam during the throw.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountWith(
      <ChartErrorBoundary onReload={() => {}}>
        <Boom />
      </ChartErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="chart-chunk-stale-banner"]')).not.toBeNull();
    unmount(container, root);
    errSpy.mockRestore();
  });

  it('renders ChartChunkStaleBanner for the Safari "Importing a module script failed" message', () => {
    function Boom(): never {
      throw new Error('Importing a module script failed.');
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountWith(
      <ChartErrorBoundary onReload={() => {}}>
        <Boom />
      </ChartErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="chart-chunk-stale-banner"]')).not.toBeNull();
    unmount(container, root);
    errSpy.mockRestore();
  });

  it('renders the children when there is no error', () => {
    const { container, root } = mountWith(
      <ChartErrorBoundary>
        <div data-testid="child" />
      </ChartErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chart-chunk-stale-banner"]')).toBeNull();
    unmount(container, root);
  });

  it('rethrows non-chunk errors so a parent boundary catches them', () => {
    // Parent boundary that mirrors what the root error boundary does:
    // capture any error from children and surface a fallback marker.
    class TestParentBoundary extends Component<{ children: ReactNode }, { caught: Error | null }> {
      state = { caught: null as Error | null };
      static getDerivedStateFromError(error: Error) {
        return { caught: error };
      }
      componentDidCatch(): void {
        // swallow — the test asserts state directly
      }
      render(): ReactNode {
        if (this.state.caught) {
          return <div data-testid="parent-boundary-fallback">{this.state.caught.message}</div>;
        }
        return this.props.children;
      }
    }

    function Boom(): never {
      throw new Error('totally unrelated bug');
    }

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, root } = mountWith(
      <TestParentBoundary>
        <ChartErrorBoundary>
          <Boom />
        </ChartErrorBoundary>
      </TestParentBoundary>,
    );
    // The chart boundary did NOT swallow the non-chunk error: the parent
    // boundary's fallback rendered with the original message.
    const fallback = container.querySelector('[data-testid="parent-boundary-fallback"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toBe('totally unrelated bug');
    // And the chunk-stale banner did NOT render (this isn't a chunk error).
    expect(container.querySelector('[data-testid="chart-chunk-stale-banner"]')).toBeNull();
    unmount(container, root);
    errSpy.mockRestore();
  });
});

describe('ChartChunkStaleBanner refresh wiring', () => {
  it('calls the onReload prop on click (no actual page reload)', () => {
    const onReload = vi.fn();
    const { container, root } = mountWith(<ChartChunkStaleBanner onReload={onReload} />);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="chart-chunk-stale-banner-refresh"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.click();
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    unmount(container, root);
  });
});
