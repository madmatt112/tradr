// @vitest-environment jsdom
// UsageSection (admin-platform Task 20; REQ-4.1/4.2/4.3, REQ-7.5).
//
// Covers the Component 5 captions on the billed-vs-provider cards (distinct
// figures, never summed), the count-based partial-coverage disclosure, the
// providerCost-null state, the top-50 disclosure on the top-users table, the
// 7/30/90-day preset selector driving the query window, and the day series
// reaching the lazy chart (mocked here — the Recharts chunk split is a build
// concern, verified by the bundle gate, not by jsdom).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminUsage } from '@tradr/shared/schemas/admin';

import { api } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}));

// Stub the lazy chart: the real module is the feature's only Recharts
// importer and stays out of this suite entirely.
vi.mock('../UsageChart', () => ({
  default: ({ series }: { series: ReadonlyArray<unknown> }) => (
    <div data-testid="usage-chart">{series.length} points</div>
  ),
}));

import { UsageSection } from '../UsageSection';

const usd = (micro: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
    Number(micro) / 1_000_000,
  );

const USAGE: AdminUsage = {
  period: { from: '2026-05-12T00:00:00.000Z', to: '2026-06-11T00:00:00.000Z' },
  totals: {
    inputTokens: '1500',
    outputTokens: '2500',
    billedCredits: '12000000', // $12.00 — as-charged, markup-inclusive
    providerCost: '10000000', // $10.00 — distinct pre-markup figure
    providerCostCoverage: { records: 5, recordsWithRawCost: 5 },
  },
  series: [
    { day: '2026-06-01', billedCredits: '6000000', inputTokens: '700', outputTokens: '1200' },
    { day: '2026-06-02', billedCredits: '6000000', inputTokens: '800', outputTokens: '1300' },
  ],
  topUsers: [
    {
      userId: '33333333-3333-3333-3333-333333333333',
      email: 'top@x.com',
      billedCredits: '7000000',
      inputTokens: '1500',
      outputTokens: '2500',
      turns: 4,
    },
  ],
  revenue: { credited: '0', reversed: '0', net: '0' },
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return render(<UsageSection />, { wrapper });
}

// Extract {from,to} from a `/admin/usage?from=...&to=...` call URL.
function periodOfCall(url: string): { from: string; to: string } {
  const params = new URLSearchParams(url.split('?')[1] ?? '');
  return { from: params.get('from') ?? '', to: params.get('to') ?? '' };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UsageSection — billed vs provider cost cards', () => {
  it('renders both cards with the Component 5 captions, never a summed figure', async () => {
    vi.mocked(api.get).mockResolvedValue(USAGE);

    renderSection();

    // Pinned captions: billed is as-charged/markup-inclusive; provider cost
    // is the distinct pre-markup persisted figure.
    expect(
      await screen.findByText('Billed / as-charged consumption (markup-inclusive)'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Pre-markup provider cost from persisted raw cost — never derived from current pricing config',
      ),
    ).toBeTruthy();

    expect(screen.getByText(usd('12000000'))).toBeTruthy();
    expect(screen.getByText(usd('10000000'))).toBeTruthy();
    // Never summed or conflated ($22.00 appears nowhere).
    expect(screen.queryByText(usd('22000000'))).toBeNull();
    // Full coverage → no partial-coverage note.
    expect(screen.queryByText(/Partial coverage/)).toBeNull();
  });

  it('discloses partial provider-cost coverage with explicit counts', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...USAGE,
      totals: {
        ...USAGE.totals,
        providerCostCoverage: { records: 8, recordsWithRawCost: 5 },
      },
    });

    renderSection();

    expect(
      await screen.findByText(/Partial coverage: provider cost recorded for 5 of 8 records/),
    ).toBeTruthy();
  });

  it('renders an em dash and a no-coverage note when providerCost is null', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...USAGE,
      totals: {
        ...USAGE.totals,
        providerCost: null,
        providerCostCoverage: { records: 3, recordsWithRawCost: 0 },
      },
    });

    renderSection();

    expect(await screen.findByText('—')).toBeTruthy();
    expect(screen.getByText('No records with recorded provider cost in this period.')).toBeTruthy();
  });
});

describe('UsageSection — top users', () => {
  it('renders the table with the top-50 disclosure', async () => {
    vi.mocked(api.get).mockResolvedValue(USAGE);

    renderSection();

    expect(await screen.findByText('top 50 by billed credits')).toBeTruthy();
    expect(screen.getByText('top@x.com')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy(); // turns
    expect(screen.getByText(new Intl.NumberFormat().format(1500n))).toBeTruthy();
    expect(screen.getByText(new Intl.NumberFormat().format(2500n))).toBeTruthy();
  });

  it('renders an empty notice instead of a table when there are no top users', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...USAGE, series: [], topUsers: [] });

    renderSection();

    expect(await screen.findByText('No user activity in this period.')).toBeTruthy();
    expect(screen.getByText('No usage recorded in this period.')).toBeTruthy();
    expect(screen.queryByTestId('usage-chart')).toBeNull();
  });
});

describe('UsageSection — chart and presets', () => {
  it('passes the day series to the lazily loaded chart', async () => {
    vi.mocked(api.get).mockResolvedValue(USAGE);

    renderSection();

    expect((await screen.findByTestId('usage-chart')).textContent).toBe('2 points');
  });

  it('defaults to a trailing 30-day window and switches to 7 days via the preset tabs', async () => {
    vi.mocked(api.get).mockResolvedValue(USAGE);
    const user = userEvent.setup();

    renderSection();
    await screen.findByTestId('usage-chart');

    const first = periodOfCall(vi.mocked(api.get).mock.calls[0]?.[0] as string);
    const dayMs = 86_400_000;
    expect(new Date(first.to).getTime() - new Date(first.from).getTime()).toBe(30 * dayMs);

    const sevenDays = screen.getByRole('tab', { name: '7 days' });
    expect(sevenDays.className).toContain('cursor-pointer');
    await user.click(sevenDays);

    await waitFor(() => {
      const calls = vi.mocked(api.get).mock.calls;
      const last = periodOfCall(calls[calls.length - 1]?.[0] as string);
      expect(new Date(last.to).getTime() - new Date(last.from).getTime()).toBe(7 * dayMs);
    });
  });
});

describe('UsageSection — loading and errors', () => {
  it('renders Skeleton placeholders while usage loads', () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}) as never);

    const { container } = renderSection();

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders a failure line on error', async () => {
    vi.mocked(api.get).mockRejectedValue({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      status: 429,
    });

    renderSection();

    expect(await screen.findByText('Failed to load usage.')).toBeTruthy();
  });
});
