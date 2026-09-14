// @vitest-environment jsdom
//
// Drives the real `useBreakdown` hook end-to-end against a mocked `api.get`, so
// the table's states, its `multiValued`-driven footer, the profit-factor
// branches, and the hook's request path + query-key prefix are all exercised
// through the component the page mounts (design Components 14 and 15).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BreakdownResponse, PerformanceStats, Tag } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  isUnauthorized: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { status?: number }).status === 401,
}));

import { __resetInvalidTimezoneState, recordRejectedTimezone } from '@/lib/invalidTimezone';

import { DimensionBreakdownTable } from './DimensionBreakdownTable';

const PARAMS = {
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-07-01T00:00:00.000Z',
  tz: 'UTC',
};

function stats(overrides: Partial<PerformanceStats> = {}): PerformanceStats {
  return {
    totalPositions: 0,
    totalNetPnl: '0.00',
    winRate: null,
    breakevenRate: null,
    avgWin: null,
    avgLoss: null,
    profitFactor: null,
    largestWin: null,
    largestLoss: null,
    expectancy: null,
    hasWins: false,
    hasLosses: false,
    ...overrides,
  };
}

function tag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Breakout',
    category: 'setup',
    color: 'tag-1',
    ...overrides,
  };
}

function response(overrides: Partial<BreakdownResponse> = {}): BreakdownResponse {
  return {
    by: 'symbol',
    multiValued: false,
    resolvedTimezone: 'UTC',
    resolvedWeekStartDay: 0,
    dataQuality: { timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 } },
    currencies: [{ code: 'USD', total: stats(), rows: [] }],
    ...overrides,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0, staleTime: 0 } },
  });
}

function mount(ui: ReactNode, client: QueryClient) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  });
  return { container, root };
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function requestedPaths(): string[] {
  return getMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  sessionStorage.clear();
  __resetInvalidTimezoneState();
  getMock.mockReset();
  document.body.innerHTML = '';
});

describe('DimensionBreakdownTable — request wiring (useBreakdown)', () => {
  it('requests /performance/breakdown with the page window, dimension and active currency', async () => {
    getMock.mockResolvedValue(response());
    const { root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      makeClient(),
    );
    await settle();

    const path = requestedPaths()[0];
    expect(path).toContain('/performance/breakdown?');
    expect(path).toContain('by=symbol');
    expect(path).toContain('tz=UTC');
    expect(path).toContain('currency=USD');
    act(() => root.unmount());
  });

  it('omits tz for the exact zone the server rejected (omitTz rule)', async () => {
    recordRejectedTimezone('UTC');
    getMock.mockResolvedValue(response());
    const { root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      makeClient(),
    );
    await settle();

    expect(requestedPaths()[0]).not.toContain('tz=');
    act(() => root.unmount());
  });

  it('keys the query under the ["performance"] prefix', async () => {
    getMock.mockResolvedValue(response());
    const client = makeClient();
    const { root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      client,
    );
    await settle();

    const found = client.getQueryCache().findAll({ queryKey: ['performance'] });
    expect(
      found.some((q) => q.queryKey[0] === 'performance' && q.queryKey[1] === 'breakdown'),
    ).toBe(true);
    act(() => root.unmount());
  });
});

describe('DimensionBreakdownTable — footer driven by multiValued', () => {
  it('renders the total row labelled "Closed positions in range" for a single-valued dimension', async () => {
    getMock.mockResolvedValue(
      response({
        multiValued: false,
        currencies: [
          {
            code: 'USD',
            total: stats({ totalPositions: 5, totalNetPnl: '100.00' }),
            rows: [{ key: 'AAPL', label: 'AAPL', tag: null, stats: stats({ totalPositions: 3 }) }],
          },
        ],
      }),
    );
    const { container, root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      makeClient(),
    );
    await settle();

    const total = container.querySelector('[data-testid="dimension-breakdown-total"]');
    expect(total).not.toBeNull();
    expect(total?.textContent).toContain('Closed positions in range');
    // The reconciling total row exists instead of the multi-valued sentence.
    expect(container.querySelector('[data-testid="dimension-breakdown-note"]')).toBeNull();
    act(() => root.unmount());
  });

  it('renders the multi-valued sentence and NO total row for the tag dimension', async () => {
    getMock.mockResolvedValue(
      response({
        by: 'tag',
        multiValued: true,
        currencies: [
          {
            code: 'USD',
            total: stats({ totalPositions: 4 }),
            rows: [
              { key: tag().id, label: 'Breakout', tag: tag(), stats: stats({ totalPositions: 2 }) },
              { key: 'untagged', label: 'Untagged', tag: null, stats: stats() },
            ],
          },
        ],
      }),
    );
    const { container, root } = mount(
      <DimensionBreakdownTable by="tag" params={PARAMS} currency="USD" />,
      makeClient(),
    );
    await settle();

    expect(container.querySelector('[data-testid="dimension-breakdown-total"]')).toBeNull();
    const note = container.querySelector('[data-testid="dimension-breakdown-note"]');
    expect(note?.textContent).toContain('counts in each row');
    expect(note?.textContent).toContain('Untagged completes the picture');
    // The tag row renders the same chip the tag list uses (aria-label category: name).
    expect(container.querySelector('[aria-label="setup: Breakout"]')).not.toBeNull();
    act(() => root.unmount());
  });
});

describe('DimensionBreakdownTable — profit-factor branches', () => {
  it('renders finite profit factor through Numeric, ∞ and em-dash through formatProfitFactor', async () => {
    getMock.mockResolvedValue(
      response({
        currencies: [
          {
            code: 'USD',
            total: stats(),
            rows: [
              {
                key: 'FINITE',
                label: 'FINITE',
                tag: null,
                stats: stats({ profitFactor: 2.5, hasWins: true, hasLosses: true }),
              },
              {
                key: 'INF',
                label: 'INF',
                tag: null,
                stats: stats({ profitFactor: null, hasWins: true, hasLosses: false }),
              },
              {
                key: 'DASH',
                label: 'DASH',
                tag: null,
                stats: stats({ profitFactor: null, hasWins: false, hasLosses: false }),
              },
            ],
          },
        ],
      }),
    );
    const { container, root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      makeClient(),
    );
    await settle();

    const rowCells = (key: string) => {
      const rows = Array.from(container.querySelectorAll('tbody tr'));
      const row = rows.find((r) => r.textContent?.includes(key));
      return Array.from(row?.querySelectorAll('td') ?? []);
    };

    // Column order: Group, Positions, Win rate, Net P&L, Profit factor, Expectancy.
    const finitePf = rowCells('FINITE')[4];
    expect(finitePf?.querySelector('[data-testid="numeric"]')).not.toBeNull();
    expect(finitePf?.textContent).toContain('2.50');

    const infPf = rowCells('INF')[4];
    // The ∞ branch is NOT the numeric primitive — a bare formatProfitFactor span.
    expect(infPf?.querySelector('[data-testid="numeric"]')).toBeNull();
    expect(infPf?.textContent).toBe('∞');

    const dashPf = rowCells('DASH')[4];
    expect(dashPf?.querySelector('[data-testid="numeric"]')).toBeNull();
    expect(dashPf?.textContent).toBe('—');

    act(() => root.unmount());
  });
});

describe('DimensionBreakdownTable — states', () => {
  it('renders six skeleton rows with six columns each while pending', () => {
    // A never-resolving request keeps the query pending.
    getMock.mockReturnValue(new Promise(() => {}));
    const { container, root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      makeClient(),
    );

    const skeletonRows = container.querySelectorAll(
      '[data-testid="dimension-breakdown-skeleton-row"]',
    );
    expect(skeletonRows.length).toBe(6);
    expect(skeletonRows[0].querySelectorAll('td').length).toBe(6);
    // Header geometry is preserved.
    expect(container.textContent).toContain('Group');
    act(() => root.unmount());
  });

  it('renders the empty state when a symbol breakdown has no rows', async () => {
    getMock.mockResolvedValue(
      response({ currencies: [{ code: 'USD', total: stats(), rows: [] }] }),
    );
    const { container, root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      makeClient(),
    );
    await settle();

    const empty = container.querySelector('[data-testid="table-empty-state"]');
    expect(empty?.textContent).toContain('No closed positions in this timeframe.');
    // Column geometry preserved.
    expect(empty?.querySelector('td')?.getAttribute('colspan')).toBe('6');
    act(() => root.unmount());
  });

  it('renders the error state with a Retry button', async () => {
    // A 4xx is not retried and is not invalidated, so the error settles cleanly.
    getMock.mockRejectedValue({ status: 400, error: { code: 'VALIDATION_ERROR', details: {} } });
    const { container, root } = mount(
      <DimensionBreakdownTable by="symbol" params={PARAMS} currency="USD" />,
      makeClient(),
    );
    await settle();

    const empty = container.querySelector('[data-testid="table-empty-state"]');
    expect(empty?.textContent).toContain("Couldn't load this breakdown.");
    const retry = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry',
    );
    expect(retry).toBeDefined();
    expect(retry?.className).toContain('cursor-pointer');
    act(() => root.unmount());
  });
});
