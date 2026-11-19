// @vitest-environment jsdom
//
// Task 10 (design C11) adds the mark-to-market third line to each eligible
// single row, the configured/unconfigured note copy, the staleness line and
// the "Cost basis only" reason for option, group and non-USD rows. These
// tests also stub `useStockQuotes` (design C7), so the tab's own composition
// of the hook, the C8 helpers and the C9 display parts is exercised without a
// query client.
//
// Contract block — one row per success criterion this file adds, plus the
// Requirement 6.4 regression guard carried from the pre-task-10 suite below
// (lines 106-333 of that version), which keeps passing once `useStockQuotes`
// is mocked `configured: false` by default.
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | Not configured: note reads "Cost basis only, fees included." and no figure, reason or staleness text (Req 1.1, 1.4) | useStockQuotes → `configured: false`; one eligible stock USD row + one option USD row | mountWith(<OpenPositionsTab />) | the note paragraph's text is exactly "Cost basis only, fees included."; container text has no "Prices are delayed" and no "Delayed quotes cover stocks, not option contracts." | design C11 "not configured" bullet; AC 1.1, 1.4 |
// | Configured: note reads "Cost basis includes entry fees." followed by the staleness line (Req 6.2) | configured: true; eligible row, quote → `{ state: 'price', fetchedAt }` | mountWith(<OpenPositionsTab />) | note text contains "Cost basis includes entry fees."; container text contains "Prices are delayed about 15 minutes; oldest as of" | design C11 bullet 3; AC 6.2 |
// | Eligible row keeps average entry and cost basis and adds last price, unrealised P&L and percent for the Requirement 3.6 long example (Req 6.1) | configured: true; row openCostBasis 1001.00, quote → `{ state: 'price', lastPrice: '110.00' }` | mountWith(<OpenPositionsTab />) | the row's link text contains the formatted avg-entry and cost-basis figures plus '110.00', '99.00' and '9.89' | requirements.md AC 3.6 worked example 1; design C11 bullet 4; AC 6.1 |
// | Absent quote cell renders the em-dash, never 0.00, for each of the three new figures (Req 4.5) | configured: true; eligible row, quote → `{ state: 'absent' }` | mountWith(<OpenPositionsTab />) | each of the row's three new `[data-testid="numeric"]` cells contains EM_DASH and none contains '0.00' | Numeric.tsx absent state; AC 4.5 |
// | Loading quote cell renders the Numeric loading state (Req 4.6) | configured: true; eligible row, quote → `{ state: 'loading' }` | mountWith(<OpenPositionsTab />) | the row holds three `[data-testid="numeric-skeleton"]` elements | Numeric.tsx loading branch; AC 4.6 |
// | An option row shows "Cost basis only" and its reason as visible link text, with no focusable element nested inside the link, and keeps its cost basis (Req 4.2, 4.7, 6.3) | configured: true; one row with assetType 'option' | mountWith(<OpenPositionsTab />) | the row's link text contains "Cost basis only", "Delayed quotes cover stocks, not option contracts." and the cost-basis figure; the link has no `[tabindex]` descendant | design C8 reason order bullet 2 / C11 bullet 5 / D13; AC 4.2, 4.7, 6.3 |
// | A multi-leg group row shows "Cost basis only" and its reason as visible link text and keeps its cost basis (Req 4.3, 6.3) | configured: true; one group row | mountWith(<OpenPositionsTab />) | the row's link text contains "Cost basis only", "Multi-leg groups are not marked to market." and the cost-basis figure | design C8 reason order bullet 1; AC 4.3, 6.3 |
// | A EUR row shows "Cost basis only" and the currency reason as visible link text and keeps its cost basis (Req 4.4, 6.3) | configured: true; one row with accountCurrency 'EUR' | mountWith(<OpenPositionsTab />) | the row's link text contains "Cost basis only", "Quotes are in USD; this account is in EUR" and the cost-basis figure | design C8 reason order bullet 3; AC 4.4, 6.3 |
//
// Requirement 9.4 (repointing the doc comment at lines 18-32) is prose, not
// observable through the `mountWith` seam named by this task's Test: line;
// it is not covered by a red test here and is flagged for the implementer
// brief instead.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makePosition,
  makePositionGroup,
} from '@/features/positions/__fixtures__/position-fixtures';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { type QuoteCell, useStockQuotes } from '@/hooks/useStockQuotes';
import { EM_DASH, formatCurrency } from '@/lib/format';
import { useDrawerStore } from '@/stores/drawer.store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stub TanStack Router's <Link> with a plain anchor so we can assert hrefs
// and click behaviour without booting a router context. The `params` prop is
// interpolated into `to` (`$positionId` → params.positionId) so test 6 can
// assert the navigation target via the rendered href.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    className,
    onClick,
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
    className?: string;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => {
    let href = to;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        href = href.replace(`$${k}`, v);
      }
    }
    return (
      <a
        href={href}
        className={className}
        onClick={(e) => {
          e.preventDefault();
          onClick?.(e);
        }}
      >
        {children}
      </a>
    );
  },
}));

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: vi.fn(() => false),
}));

vi.mock('@/hooks/useStockQuotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useStockQuotes')>();
  return {
    ...actual,
    useStockQuotes: vi.fn(),
  };
});

import { OpenPositionsTab } from './OpenPositionsTab';

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

function notConfigured(): ReturnType<typeof useStockQuotes> {
  return { configured: false, quote: () => ({ state: 'absent' }) };
}

function configuredWith(cell: QuoteCell): ReturnType<typeof useStockQuotes> {
  return { configured: true, quote: () => cell };
}

beforeEach(() => {
  vi.mocked(usePositions).mockReset();
  vi.mocked(useMediaQuery).mockReset();
  vi.mocked(useMediaQuery).mockReturnValue(false);
  // Req 6.4 regression guard default: the existing cases below never
  // configure quotes, so the tab renders exactly as it did before task 10
  // unless a test overrides this.
  vi.mocked(useStockQuotes).mockReset();
  vi.mocked(useStockQuotes).mockReturnValue(notConfigured());
  useDrawerStore.setState({ isOpen: false, activeTab: 'open-positions' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenPositionsTab', () => {
  it('renders 4 skeleton placeholders while loading', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<OpenPositionsTab />);
    const skeletons = container.querySelectorAll('[data-testid="open-positions-skeleton"]');
    expect(skeletons.length).toBe(4);
    unmount(container, root);
  });

  it('renders a destructive Alert on error', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<OpenPositionsTab />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('boom');
    unmount(container, root);
  });

  it('renders the exact verbatim empty-state copy when there are no positions', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<OpenPositionsTab />);
    expect(container.textContent).toContain('No open positions. Open one from the Positions page.');
    unmount(container, root);
  });

  it('renders symbol, direction, quantity, avg entry price, and cost basis per row', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000a1',
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
        totalEntryQuantity: 100,
        totalExitQuantity: 0,
        avgEntryPrice: 150,
        // Cost basis now arrives from the API rather than being recomputed here
        // (ledger-balances Req 10) — 100 × $150, no fees.
        openCostBasis: 100 * 150,
        accountCurrency: 'USD',
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
      makePosition({
        id: '00000000-0000-4000-a000-0000000000a2',
        symbol: 'SPY',
        side: 'short',
        assetType: 'option',
        totalEntryQuantity: 10,
        totalExitQuantity: 0,
        avgEntryPrice: 4.5,
        // NEGATIVE: a short's unexited size is proceeds received against
        // contracts still owed, so it is a liability. The old local helper took
        // an absolute value and reported +$4,500 here.
        openCostBasis: -(10 * 4.5 * 100),
        accountCurrency: 'USD',
        openedAt: '2026-05-24T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<OpenPositionsTab />);
    const text = container.textContent ?? '';

    expect(text).toContain('AAPL');
    expect(text).toContain('Long');
    expect(text).toContain('· 100');
    expect(text).toContain(formatCurrency(150, 'USD'));
    expect(text).toContain(formatCurrency(100 * 150 * 1, 'USD'));

    expect(text).toContain('SPY');
    expect(text).toContain('Short');
    expect(text).toContain('· 10');
    expect(text).toContain(formatCurrency(4.5, 'USD'));
    // The API reports a short's cost basis as negative; this column shows the
    // magnitude, because the row already reads "Short · 10".
    expect(text).toContain(formatCurrency(10 * 4.5 * 100, 'USD'));

    unmount(container, root);
  });

  it('sorts by openedAt desc with null last', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000b1',
        symbol: 'OLD',
        openedAt: '2026-05-01T10:00:00.000Z',
      }),
      makePosition({
        id: '00000000-0000-4000-a000-0000000000b2',
        symbol: 'NULLROW',
        openedAt: null,
      }),
      makePosition({
        id: '00000000-0000-4000-a000-0000000000b3',
        symbol: 'NEW',
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<OpenPositionsTab />);
    const symbols = Array.from(container.querySelectorAll('a')).map(
      (a) => a.querySelector('.font-medium')?.textContent,
    );
    expect(symbols).toEqual(['NEW', 'OLD', 'NULLROW']);
    unmount(container, root);
  });

  // Contract (design C14, AC 7.2): a group is one row showing its label and
  // the magnitude of its open cost basis, linking to its first open leg.
  it('shows a group as one row with its label and |openCostBasis|, linking to its first open leg', () => {
    const closedLeg = {
      ...makePosition({ id: '00000000-0000-4000-a000-0000000000e1', status: 'closed' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const openLeg = {
      ...makePosition({ id: '00000000-0000-4000-a000-0000000000e2', status: 'open' }),
      groupId: '00000000-0000-4000-a000-000000000200',
    };
    const group = makePositionGroup({
      label: 'BCS',
      openCostBasis: -301.3,
      accountCurrency: 'USD',
      openedAt: '2026-05-26T10:00:00.000Z',
      legs: [closedLeg, openLeg],
    });
    vi.mocked(usePositions).mockReturnValue({
      data: [group],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<OpenPositionsTab />);
    const text = container.textContent ?? '';

    expect(text).toContain('BCS');
    expect(text).toContain(formatCurrency(301.3, 'USD'));
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`/positions/${openLeg.id}`);

    unmount(container, root);
  });

  it('closes the drawer on row click when on mobile', () => {
    vi.mocked(useMediaQuery).mockReturnValue(true);
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000c1',
        symbol: 'AAPL',
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    useDrawerStore.setState({ isOpen: true });

    const { container, root } = mountWith(<OpenPositionsTab />);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/positions/00000000-0000-4000-a000-0000000000c1');

    act(() => {
      link!.click();
    });

    expect(useDrawerStore.getState().isOpen).toBe(false);
    unmount(container, root);
  });

  // Contract (design C10, Req 1.5): a flagged row carries the past-expiry
  // mark in the drawer tab row; an unflagged row carries none. `makePosition`
  // omits `pastExpiryUnsettled` by default, so the unflagged row below
  // carries no key at all, matching a non-option/non-flagged read.
  it('shows the past-expiry chip on a flagged row and not on an unflagged row', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000d1',
        symbol: 'FLAGGED',
        openedAt: '2026-05-25T10:00:00.000Z',
        pastExpiryUnsettled: true,
      }),
      makePosition({
        id: '00000000-0000-4000-a000-0000000000d2',
        symbol: 'PLAIN',
        openedAt: '2026-05-24T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);

    const { container, root } = mountWith(<OpenPositionsTab />);
    const links = container.querySelectorAll('a');

    expect(links[0].textContent).toContain('Past expiry');
    expect(links[1].textContent).not.toContain('Past expiry');

    unmount(container, root);
  });
});

describe('OpenPositionsTab — not configured (Req 1.1, 1.4)', () => {
  it('renders the new unconfigured note and adds no figure, reason or staleness text', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f1',
        symbol: 'AAPL',
        assetType: 'stock',
        accountCurrency: 'USD',
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f2',
        symbol: 'AAPL230120C00150000',
        assetType: 'option',
        accountCurrency: 'USD',
        openedAt: '2026-05-24T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(notConfigured());

    const { container, root } = mountWith(<OpenPositionsTab />);

    // The tab must call the quote feed hook (design C11 bullet 1) even while
    // unconfigured — this fails on today's tab, which never imports
    // useStockQuotes at all.
    expect(useStockQuotes).toHaveBeenCalled();
    const note = container.querySelector('p');
    expect(note?.textContent).toBe('Cost basis only, fees included.');
    expect(container.textContent).not.toContain('Prices are delayed');
    expect(container.textContent).not.toContain(
      'Delayed quotes cover stocks, not option contracts.',
    );

    unmount(container, root);
  });
});

describe('OpenPositionsTab — configured note and staleness (Req 6.2)', () => {
  it('reads "Cost basis includes entry fees." followed by the staleness line', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f3',
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
        accountCurrency: 'USD',
        totalEntryQuantity: 10,
        totalExitQuantity: 0,
        avgEntryPrice: 100,
        openCostBasis: 1001.0,
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(
      configuredWith({
        state: 'price',
        lastPrice: '110.00',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const { container, root } = mountWith(<OpenPositionsTab />);

    const note = container.querySelector('p');
    expect(note?.textContent).toContain('Cost basis includes entry fees.');
    expect(container.textContent).toContain('Prices are delayed about 15 minutes; oldest as of');

    unmount(container, root);
  });
});

describe('OpenPositionsTab — marked-to-market figures (Req 3.6, 4.5, 4.6, 6.1)', () => {
  it('keeps average entry and cost basis and adds last price, unrealised P&L and percent for the Requirement 3.6 long example', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f4',
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
        accountCurrency: 'USD',
        totalEntryQuantity: 10,
        totalExitQuantity: 0,
        avgEntryPrice: 100,
        openCostBasis: 1001.0,
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(
      configuredWith({
        state: 'price',
        lastPrice: '110.00',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const { container, root } = mountWith(<OpenPositionsTab />);

    const link = container.querySelector('a');
    const text = link?.textContent ?? '';
    expect(text).toContain(formatCurrency(100, 'USD'));
    expect(text).toContain(formatCurrency(1001.0, 'USD'));
    expect(text).toContain('110.00');
    expect(text).toContain('99.00');
    expect(text).toContain('9.89');

    unmount(container, root);
  });

  it('renders the em-dash, never 0.00, for an absent quote cell', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f5',
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
        accountCurrency: 'USD',
        totalEntryQuantity: 10,
        totalExitQuantity: 0,
        openCostBasis: 1001.0,
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsTab />);

    // The avg-entry and cost-basis cells also render through Numeric and are
    // unaffected by this task (Req 6.1) — drop them to isolate the three new
    // mark-to-market cells, which are the ones this test asserts on.
    const cells = Array.from(container.querySelectorAll('a [data-testid="numeric"]')).slice(2);
    expect(cells.length).toBe(3);
    cells.forEach((cell) => {
      expect(cell.textContent).toContain(EM_DASH);
      expect(cell.textContent).not.toContain('0.00');
    });

    unmount(container, root);
  });

  it('renders the Numeric loading state for a loading quote cell', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f6',
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
        accountCurrency: 'USD',
        totalEntryQuantity: 10,
        totalExitQuantity: 0,
        openCostBasis: 1001.0,
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'loading' }));

    const { container, root } = mountWith(<OpenPositionsTab />);

    const skeletons = container.querySelectorAll('a [data-testid="numeric-skeleton"]');
    expect(skeletons.length).toBe(3);

    unmount(container, root);
  });
});

describe('OpenPositionsTab — cost-basis-only rows (Req 4.2, 4.3, 4.4, 4.7, 6.3)', () => {
  it('shows the option reason as visible link text, with no focusable element nested inside the link, and keeps the cost basis figure', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f7',
        symbol: 'SPY230120P00400000',
        assetType: 'option',
        accountCurrency: 'USD',
        openCostBasis: -4500,
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsTab />);

    const link = container.querySelector('a');
    expect(link?.textContent).toContain('Cost basis only');
    expect(link?.textContent).toContain('Delayed quotes cover stocks, not option contracts.');
    expect(link?.textContent).toContain(formatCurrency(4500, 'USD'));
    expect(link?.querySelector('[tabindex]')).toBeNull();

    unmount(container, root);
  });

  it('shows the group reason as visible link text and keeps the cost basis figure', () => {
    const group = makePositionGroup({
      label: 'BCS',
      openCostBasis: -301.3,
      accountCurrency: 'USD',
      openedAt: '2026-05-26T10:00:00.000Z',
    });
    vi.mocked(usePositions).mockReturnValue({
      data: [group],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsTab />);

    const link = container.querySelector('a');
    expect(link?.textContent).toContain('Cost basis only');
    expect(link?.textContent).toContain('Multi-leg groups are not marked to market.');
    expect(link?.textContent).toContain(formatCurrency(301.3, 'USD'));

    unmount(container, root);
  });

  it('shows the non-USD currency reason as visible link text and keeps the cost basis figure', () => {
    const rows = [
      makePosition({
        id: '00000000-0000-4000-a000-0000000000f8',
        symbol: 'SAP',
        assetType: 'stock',
        accountCurrency: 'EUR',
        openCostBasis: 2000,
        openedAt: '2026-05-25T10:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: rows,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof usePositions>);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsTab />);

    const link = container.querySelector('a');
    expect(link?.textContent).toContain('Cost basis only');
    expect(link?.textContent).toContain('Quotes are in USD; this account is in EUR');
    expect(link?.textContent).toContain(formatCurrency(2000, 'EUR'));

    unmount(container, root);
  });
});
