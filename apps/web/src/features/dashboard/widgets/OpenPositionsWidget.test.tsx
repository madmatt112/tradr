// @vitest-environment jsdom
//
// The Open Positions widget summarises: it renders at most
// OPEN_POSITIONS_ROW_CAP rows, most recently updated first, and links to the
// full list carrying the total count (Req 3). These tests mount the widget
// with a stubbed positions hook and router, so the cap and the empty state are
// exercised without a query client or route context.
//
// Task 9 (design C10) adds the mark-to-market columns. These tests also stub
// `useStockQuotes` (design C7) and the shadcn Tooltip primitives (as
// CrossCurrencyTotal.test.tsx:38-48 and CostBasisOnly.test.tsx:14-22 do), so
// the widget's own composition of the hook, the C8 helpers and the C9 display
// parts is exercised without a query client or Radix portals.
//
// Contract block — one row per success criterion, plus the Requirement 5.2
// regression guard carried from the pre-task-9 suite below.
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | Not configured: header unchanged, no reason/staleness text (Req 1.1, 1.3) | useStockQuotes → `configured: false`; one open stock USD row | mountWith(<OpenPositionsWidget />) | header cells are exactly Symbol, Side, Asset, Quantity, Opened, Actions; container text has no "Cost basis only" or "Prices are delayed" | design C10 "not configured" bullet; AC 1.1, 1.3 |
// | Configured: header adds Last, Unrealised P&L, Unrealised % before Actions (Req 5.1) | useStockQuotes → `configured: true`; one open stock USD row | mountWith(<OpenPositionsWidget />) | header cell texts, in order, are Symbol, Side, Asset, Quantity, Opened, Last, Unrealised P&L, Unrealised %, Actions | design C10 bullet 2; AC 5.1 |
// | Long 10 @ cost basis 1001.00, last 110.00 USD renders 110.00 / 99.00 / 9.89% (Req 3.6, 5.3) | configured: true; eligible row, quote → `{ state: 'price', lastPrice: '110.00' }` | mountWith(<OpenPositionsWidget />) | the row's new cells' text contains '110.00', '99.00' and '9.89' | requirements.md AC 3.6 worked example 1; design C10 Numeric settings |
// | Absent cell renders the em-dash, never 0.00 (Req 4.5) | configured: true; eligible row, quote → `{ state: 'absent' }` | mountWith(<OpenPositionsWidget />) | each of the row's three new cells contains EM_DASH and none contains '0.00' | Numeric.tsx:8-9 absent state; AC 4.5 |
// | Loading cell renders the Numeric loading state (Req 4.6) | configured: true; eligible row, quote → `{ state: 'loading' }` | mountWith(<OpenPositionsWidget />) | the row holds three `[data-testid="numeric-skeleton"]` elements | Numeric.tsx loading branch; AC 4.6 |
// | An option row shows "Cost basis only" with its reason (Req 4.2, 4.7) | configured: true; one row with assetType 'option' | mountWith(<OpenPositionsWidget />) | one cell's text contains "Cost basis only" and "Delayed quotes cover stocks, not option contracts." | design C8 reason order bullet 2; AC 4.2 |
// | A group row shows "Cost basis only" with its reason (Req 4.3, 4.7) | configured: true; one PositionGroupEntry row | mountWith(<OpenPositionsWidget />) | one cell's text contains "Cost basis only" and "Multi-leg groups are not marked to market." | design C8 reason order bullet 1; AC 4.3 |
// | A EUR row shows "Cost basis only" with its reason (Req 4.4, 4.7) | configured: true; one row with accountCurrency 'EUR' | mountWith(<OpenPositionsWidget />) | one cell's text contains "Cost basis only" and "Quotes are in USD; this account is in EUR" | design C8 reason order bullet 3; AC 4.4 |
// | Staleness line renders when one price shows (Req 5.4) | configured: true; eligible row, quote → `{ state: 'price', fetchedAt: <iso> }` | mountWith(<OpenPositionsWidget />) | container text contains "Prices are delayed about 15 minutes; oldest as of" | design C9 QuoteStaleness sentence; AC 5.4 |
//
// Requirement 5.2 is a regression guard, not a new red test: the pre-existing
// five-row-cap, group-row and past-expiry cases below (unchanged) must keep
// passing once `useStockQuotes` is mocked `configured: false` by default.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PositionListEntry, PositionListItem } from '@tradr/shared';

import { usePositions } from '@/features/positions/hooks/usePositions';
import { type QuoteCell, useStockQuotes } from '@/hooks/useStockQuotes';
import { EM_DASH } from '@/lib/format';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
}));

vi.mock('@/hooks/useStockQuotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useStockQuotes')>();
  return {
    ...actual,
    useStockQuotes: vi.fn(),
  };
});

// Mock the shadcn Tooltip primitives exactly as CrossCurrencyTotal.test.tsx
// and CostBasisOnly.test.tsx do, so jsdom isn't fighting Radix portals and
// the reason text is always in the DOM to assert on.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

// PositionRowActions pulls in mutation hooks and dialogs; the row-cap contract
// does not touch it, so render nothing.
vi.mock('@/features/positions/components/PositionRowActions', () => ({
  PositionRowActions: () => null,
}));

// Same reason: PositionGroupRowActions pulls in useCloseGroup (useQueryClient)
// through CloseGroupDialog, and there is no QueryClientProvider here.
vi.mock('@/features/positions/components/PositionGroupRowActions', () => ({
  PositionGroupRowActions: () => null,
}));

// Stub TanStack Router: <Link> becomes a plain anchor so href / text are
// inspectable without a router context, and useNavigate is a no-op (no row is
// clicked in these tests).
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

import OpenPositionsWidget from './OpenPositionsWidget';

type PositionsResult = ReturnType<typeof usePositions>;

// A PositionListItem-shaped row carrying just the fields the widget reads; the
// rest are filled to keep the shape plausible and cast at the boundary.
function makePosition(overrides: Partial<PositionListItem>): PositionListItem {
  return {
    id: 'id',
    symbol: 'SYM',
    side: 'long',
    assetType: 'stock',
    status: 'open',
    totalEntryQuantity: 10,
    totalExitQuantity: 0,
    openedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as PositionListItem;
}

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
  // Req 5.2 regression guard default: the existing cap/past-expiry cases
  // below never configure quotes, so the table stays exactly as it was
  // before task 9 unless a test overrides this.
  vi.mocked(useStockQuotes).mockReturnValue(notConfigured());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenPositionsWidget — five-row cap', () => {
  it('renders five of six rows, drops the oldest, and counts all six in the link', () => {
    // updatedAt climbs with the index, so SYM0 is the oldest and must fall
    // outside the five-row cap once the list is sorted newest-first.
    const positions = Array.from({ length: 6 }, (_, i) =>
      makePosition({
        id: `id-${i}`,
        symbol: `SYM${i}`,
        updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    vi.mocked(usePositions).mockReturnValue({
      data: positions,
      isLoading: false,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<OpenPositionsWidget />);

    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(container.textContent).not.toContain('SYM0');
    expect(container.textContent).toContain('View all 6 open positions');

    unmount(container, root);
  });

  // Contract (design C14, AC 7.1): a group takes one of the five rows and
  // counts once in "View all N open positions" — the five-row list runs over
  // entries, not flattened legs.
  it('shows a group as one row with its label, counted once among the five rows', () => {
    const plainPositions = Array.from({ length: 4 }, (_, i) =>
      makePosition({
        id: `id-${i}`,
        symbol: `SYM${i}`,
        updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    // A raw group entry — fields a group row needs the widget to read instead
    // of `symbol`/`side`/`assetType`/`totalEntryQuantity`.
    const group = {
      kind: 'group',
      id: 'group-1',
      label: 'BCS',
      underlying: 'AAPL',
      status: 'open',
      openedAt: '2026-01-10T00:00:00.000Z',
      updatedAt: '2026-01-10T00:00:00.000Z',
      legs: [
        { id: 'leg-1', status: 'closed' },
        { id: 'leg-2', status: 'open' },
      ],
    } as unknown as PositionListEntry;

    vi.mocked(usePositions).mockReturnValue({
      data: [...plainPositions, group],
      isLoading: false,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<OpenPositionsWidget />);

    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(container.textContent).toContain('BCS');
    expect(container.textContent).toContain('View all 5 open positions');

    unmount(container, root);
  });

  it('keeps the empty state and its New position link when there are no positions', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<OpenPositionsWidget />);

    expect(container.textContent).toContain('No open positions. Create one to get started.');
    const link = container.querySelector('a[href="/positions"]');
    expect(link?.textContent).toContain('New position');

    unmount(container, root);
  });
});

// Contract (design C10, Req 1.5): a flagged row carries the past-expiry mark
// in the widget row; an unflagged row carries none. `makePosition` omits
// `pastExpiryUnsettled` by default, so the unflagged row below carries no key
// at all, matching a non-option/non-flagged read.
describe('OpenPositionsWidget — past-expiry chip', () => {
  it('shows the chip on a flagged row and not on an unflagged row', () => {
    const positions = [
      makePosition({
        id: 'id-flagged',
        symbol: 'FLAGGED',
        updatedAt: '2026-01-02T00:00:00.000Z',
        pastExpiryUnsettled: true,
      }),
      makePosition({
        id: 'id-plain',
        symbol: 'PLAIN',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    vi.mocked(usePositions).mockReturnValue({
      data: positions,
      isLoading: false,
    } as unknown as PositionsResult);

    const { container, root } = mountWith(<OpenPositionsWidget />);

    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('Past expiry');
    expect(rows[1].textContent).not.toContain('Past expiry');

    unmount(container, root);
  });
});

function headerTexts(container: HTMLElement): (string | undefined)[] {
  return Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
}

describe('OpenPositionsWidget — not configured (Req 1.1, 1.3)', () => {
  it('keeps the header and rows exactly as today, with no reason or staleness text', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [makePosition({ id: 'id-1', symbol: 'AAPL', accountCurrency: 'USD' })],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(notConfigured());

    const { container, root } = mountWith(<OpenPositionsWidget />);

    // The widget must call the quote feed hook (design C10 bullet 1) and
    // still render the unconfigured table — this fails on today's widget,
    // which never imports useStockQuotes at all.
    expect(useStockQuotes).toHaveBeenCalled();
    expect(headerTexts(container)).toEqual([
      'Symbol',
      'Side',
      'Asset',
      'Quantity',
      'Opened',
      'Actions',
    ]);
    expect(container.textContent).not.toContain('Cost basis only');
    expect(container.textContent).not.toContain('Prices are delayed');

    unmount(container, root);
  });
});

describe('OpenPositionsWidget — configured header (Req 5.1)', () => {
  it('adds Last, Unrealised P&L and Unrealised % before Actions', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [makePosition({ id: 'id-1', symbol: 'AAPL', accountCurrency: 'USD' })],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'loading' }));

    const { container, root } = mountWith(<OpenPositionsWidget />);

    expect(headerTexts(container)).toEqual([
      'Symbol',
      'Side',
      'Asset',
      'Quantity',
      'Opened',
      'Last',
      'Unrealised P&L',
      'Unrealised %',
      'Actions',
    ]);

    unmount(container, root);
  });
});

describe('OpenPositionsWidget — marked-to-market figures (Req 3.6, 4.5, 4.6, 5.3)', () => {
  it('shows last price, unrealised P&L and percent for the Requirement 3.6 long worked example', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: 'id-1',
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          accountCurrency: 'USD',
          totalEntryQuantity: 10,
          totalExitQuantity: 0,
          openCostBasis: 1001.0,
        }),
      ],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(
      configuredWith({
        state: 'price',
        lastPrice: '110.00',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const { container, root } = mountWith(<OpenPositionsWidget />);

    const row = container.querySelector('tbody tr');
    expect(row?.textContent).toContain('110.00');
    expect(row?.textContent).toContain('99.00');
    expect(row?.textContent).toContain('9.89');

    unmount(container, root);
  });

  it('renders the em-dash, never 0.00, for an absent quote cell', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: 'id-1',
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          accountCurrency: 'USD',
          totalEntryQuantity: 10,
          totalExitQuantity: 0,
          openCostBasis: 1001.0,
        }),
      ],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsWidget />);

    const cells = container.querySelectorAll('tbody tr [data-testid="numeric"]');
    expect(cells.length).toBe(3);
    cells.forEach((cell) => {
      expect(cell.textContent).toContain(EM_DASH);
      expect(cell.textContent).not.toContain('0.00');
    });

    unmount(container, root);
  });

  it('renders the Numeric loading state for a loading quote cell', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: 'id-1',
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          accountCurrency: 'USD',
          totalEntryQuantity: 10,
          totalExitQuantity: 0,
          openCostBasis: 1001.0,
        }),
      ],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'loading' }));

    const { container, root } = mountWith(<OpenPositionsWidget />);

    const skeletons = container.querySelectorAll('tbody tr [data-testid="numeric-skeleton"]');
    expect(skeletons.length).toBe(3);

    unmount(container, root);
  });
});

describe('OpenPositionsWidget — cost-basis-only rows (Req 4.2, 4.3, 4.4, 4.7)', () => {
  it('shows the option reason for an option row', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: 'id-1',
          symbol: 'AAPL230120C00150000',
          assetType: 'option',
          accountCurrency: 'USD',
        }),
      ],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsWidget />);

    const row = container.querySelector('tbody tr');
    expect(row?.textContent).toContain('Cost basis only');
    expect(row?.textContent).toContain('Delayed quotes cover stocks, not option contracts.');

    unmount(container, root);
  });

  it('shows the group reason for a multi-leg group row', () => {
    const group = {
      kind: 'group',
      id: 'group-1',
      label: 'BCS',
      underlying: 'AAPL',
      accountCurrency: 'USD',
      status: 'open',
      openedAt: '2026-01-10T00:00:00.000Z',
      updatedAt: '2026-01-10T00:00:00.000Z',
      legs: [{ id: 'leg-1', status: 'open' }],
    } as unknown as PositionListEntry;

    vi.mocked(usePositions).mockReturnValue({
      data: [group],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsWidget />);

    const row = container.querySelector('tbody tr');
    expect(row?.textContent).toContain('Cost basis only');
    expect(row?.textContent).toContain('Multi-leg groups are not marked to market.');

    unmount(container, root);
  });

  it('shows the non-USD currency reason for a EUR row', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: 'id-1',
          symbol: 'SAP',
          assetType: 'stock',
          accountCurrency: 'EUR',
        }),
      ],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountWith(<OpenPositionsWidget />);

    const row = container.querySelector('tbody tr');
    expect(row?.textContent).toContain('Cost basis only');
    expect(row?.textContent).toContain('Quotes are in USD; this account is in EUR');

    unmount(container, root);
  });
});

describe('OpenPositionsWidget — staleness line (Req 5.4)', () => {
  it('renders the staleness sentence when at least one price is displayed', () => {
    vi.mocked(usePositions).mockReturnValue({
      data: [
        makePosition({
          id: 'id-1',
          symbol: 'AAPL',
          side: 'long',
          assetType: 'stock',
          accountCurrency: 'USD',
          totalEntryQuantity: 10,
          totalExitQuantity: 0,
          openCostBasis: 1001.0,
        }),
      ],
      isLoading: false,
    } as unknown as PositionsResult);
    vi.mocked(useStockQuotes).mockReturnValue(
      configuredWith({
        state: 'price',
        lastPrice: '110.00',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const { container, root } = mountWith(<OpenPositionsWidget />);

    expect(container.textContent).toContain('Prices are delayed about 15 minutes; oldest as of');

    unmount(container, root);
  });
});
