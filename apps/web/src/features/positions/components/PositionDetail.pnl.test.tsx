// @vitest-environment jsdom
//
// Task 11 (design C12) adds EUR formatting and the unrealised cards. These
// tests also stub `useStockQuotes` (design C7), as OpenPositionsWidget.test.tsx
// and OpenPositionsTab.test.tsx do, so the detail page's own composition of
// the hook and the markToMarket/CostBasisOnly/QuoteStaleness parts is
// exercised without a query client.
//
// Contract block — one row per new success criterion this file covers.
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | A EUR position formats its money cards in EUR, no 'USD' literal remains (Req 7.2) | closed position, accountCurrency 'EUR', targetPrice 100, grossPnl 200, netPnl 195 | mountWith(<PositionDetailView positionId />) | Target Price/Gross P&L/Net P&L card text contains formatCurrency(_, 'EUR') and not formatCurrency(_, 'USD') | design C12 "uses position.accountCurrency"; AC 7.2 |
// | An open eligible USD stock adds Last Price, Unrealised P&L and Unrealised % cards and the staleness line (Req 7.3) | open USD stock, qty 10, openCostBasis 1001.00, quote → price 110.00 | mountWith(<PositionDetailView positionId />) | cards titled Last Price / Unrealised P&L / Unrealised % exist with 110.00 / 99.00 / 9.89; container text has the staleness sentence | requirements.md AC 3.6 worked example 1; design C12 bullet "Last Price, Unrealised P&L and Unrealised %" |
// | An open option, a grouped leg and a EUR stock each add one Unrealised P&L card with "Cost basis only" and its reason (Req 7.4) | three open positions: option; USD stock with groupId; EUR stock | mountWith(<PositionDetailView positionId />) | the "Unrealised P&L" card's text contains "Cost basis only" and the matching reason | design C8 reason order; AC 4.2/4.3/4.4, 7.4 |
// | The hook receives only the page's own symbol, or nothing when ineligible (Req 7.6) | open eligible USD stock symbol AAPL; closed position; open option | mountWith(<PositionDetailView positionId />) | useStockQuotes called with ['AAPL'] for the eligible case, with [] for the closed and option cases | design C12 bullet "useStockQuotes(eligible ? [position.symbol] : [])"; AC 7.6 |
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { type QuoteCell, useStockQuotes } from '@/hooks/useStockQuotes';
import { formatCurrency } from '@/lib/format';

import { usePosition } from '../hooks/usePosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('../hooks/usePosition', () => ({
  usePosition: vi.fn(),
  useDeletePosition: vi.fn(() => ({ mutateAsync: vi.fn() })),
  useOpenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useClosePosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useReopenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/useStockQuotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useStockQuotes')>();
  return {
    ...actual,
    useStockQuotes: vi.fn(),
  };
});

vi.mock('./FillDialog', () => ({ FillDialog: () => null }));
vi.mock('./FillTable', () => ({ FillTable: () => null }));
vi.mock('./PositionScreenshots', () => ({ PositionScreenshots: () => null }));
vi.mock('./PositionEditDialog', () => ({ PositionEditDialog: () => null }));
// The Fills-header coach mark reads onboarding state through TanStack Query;
// this file mounts bare, with no QueryClient. Its own suite covers it — this
// file is about the P&L figures.
vi.mock('@/features/onboarding/components/CoachMark', () => ({ CoachMark: () => null }));

import { PositionDetailView } from './PositionDetail';

type PositionResult = ReturnType<typeof usePosition>;

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

// An open position's Close button renders a Tooltip unconditionally (not
// only while disabled); these task-11 fixtures mount 'open' positions, which
// `mountWith` alone never did before, so they need the provider the
// coachMark/reopen suites already supply.
function mountOpen(ui: React.ReactElement): { container: HTMLElement; root: Root } {
  return mountWith(<TooltipProvider>{ui}</TooltipProvider>);
}

function notConfigured(): ReturnType<typeof useStockQuotes> {
  return { configured: false, quote: () => ({ state: 'absent' }) };
}

function configuredWith(cell: QuoteCell): ReturnType<typeof useStockQuotes> {
  return { configured: true, quote: () => cell };
}

beforeEach(() => {
  vi.mocked(useStockQuotes).mockReturnValue(notConfigured());
});

afterEach(() => {
  vi.clearAllMocks();
});

function mockDetail(pnl: {
  grossPnl: number | null;
  netPnl: number | null;
  ret: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  targetRR?: number | null;
  actualRR?: number | null;
}) {
  vi.mocked(usePosition).mockReturnValue({
    data: {
      id: '00000000-0000-4000-a000-000000000001',
      userId: '00000000-0000-4000-a000-000000000100',
      accountId: '00000000-0000-4000-a000-000000000010',
      accountTimezone: 'America/New_York',
      accountCurrency: 'USD',
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      notes: null,
      openedAt: '2026-05-01T12:00:00.000Z',
      closedAt: '2026-05-02T12:00:00.000Z',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-02T12:00:00.000Z',
      fills: [],
      avgEntryPrice: 150,
      avgExitPrice: 160,
      totalEntryQuantity: 100,
      totalExitQuantity: 100,
      realizedPnl: pnl.netPnl,
      returnPercentage: pnl.ret,
      brokerageName: null,
      grossPnl: pnl.grossPnl,
      brokerageFees: 0,
      netPnl: pnl.netPnl,
      targetPrice: pnl.targetPrice ?? null,
      stopLoss: pnl.stopLoss ?? null,
      targetRR: pnl.targetRR ?? null,
      actualRR: pnl.actualRR ?? null,
      openUnits: 0,
      closedUnits: 0,
    },
    isLoading: false,
  } as unknown as PositionResult);
}

/** Return the <Numeric> element inside the summary card with the given title. */
function cardNumeric(container: HTMLElement, title: string): HTMLElement {
  const titleEl = Array.from(container.querySelectorAll('[data-slot="card-title"]')).find(
    (el) => el.textContent === title,
  );
  const numeric = titleEl?.closest('[data-slot="card"]')?.querySelector('[data-testid="numeric"]');
  if (!numeric) throw new Error(`No <Numeric> found in card "${title}"`);
  return numeric as HTMLElement;
}

/** Return the summary card element with the given title (task 11 cards). */
function cardByTitle(container: HTMLElement, title: string): HTMLElement {
  const titleEl = Array.from(container.querySelectorAll('[data-slot="card-title"]')).find(
    (el) => el.textContent === title,
  );
  const card = titleEl?.closest('[data-slot="card"]');
  if (!card) throw new Error(`No card titled "${title}"`);
  return card as HTMLElement;
}

type OpenDetailOverrides = {
  status?: 'draft' | 'open' | 'closed';
  assetType?: 'stock' | 'option';
  accountCurrency?: string;
  groupId?: string | null;
  symbol?: string;
  totalEntryQuantity?: number;
  totalExitQuantity?: number;
  openCostBasis?: number;
  targetPrice?: number | null;
  grossPnl?: number | null;
  netPnl?: number | null;
};

/** Task 11: a position fixture whose status/assetType/currency/group can vary
 * to drive the eligibility branches the unrealised cards gate on (design C12). */
function mockOpenDetail(overrides: OpenDetailOverrides = {}) {
  vi.mocked(usePosition).mockReturnValue({
    data: {
      id: '00000000-0000-4000-a000-000000000001',
      userId: '00000000-0000-4000-a000-000000000100',
      accountId: '00000000-0000-4000-a000-000000000010',
      accountTimezone: 'America/New_York',
      accountCurrency: overrides.accountCurrency ?? 'USD',
      symbol: overrides.symbol ?? 'AAPL',
      side: 'long',
      assetType: overrides.assetType ?? 'stock',
      status: overrides.status ?? 'open',
      notes: null,
      openedAt: '2026-05-01T12:00:00.000Z',
      closedAt: null,
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
      fills: [],
      avgEntryPrice: 100.1,
      avgExitPrice: null,
      totalEntryQuantity: overrides.totalEntryQuantity ?? 10,
      totalExitQuantity: overrides.totalExitQuantity ?? 0,
      realizedPnl: null,
      returnPercentage: null,
      brokerageName: null,
      grossPnl: overrides.grossPnl ?? null,
      brokerageFees: 0,
      netPnl: overrides.netPnl ?? null,
      targetPrice: overrides.targetPrice ?? null,
      stopLoss: null,
      targetRR: null,
      actualRR: null,
      openUnits: 0,
      closedUnits: 0,
      openCostBasis: overrides.openCostBasis ?? 1001.0,
      groupId: overrides.groupId ?? null,
    },
    isLoading: false,
  } as unknown as PositionResult);
}

/** The 3 P&L figures (Gross, Net, Return %) all render through <Numeric>. */
function pnlNumerics(container: HTMLElement): HTMLElement[] {
  return ['Gross P&L', 'Net P&L', 'Return %'].map((title) => cardNumeric(container, title));
}

describe('PositionDetail — P&L renders via <Numeric>', () => {
  it('gain: every P&L figure carries + / text-gain, no arrow glyph', () => {
    mockDetail({ grossPnl: 200, netPnl: 195, ret: 12.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    expect(nums.length).toBe(3);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('gain');
      expect(n.className).toContain('text-gain');
      expect(n.textContent).toContain('+');
      expect(n.querySelector('svg')).toBeNull();
    }
    unmount(container, root);
  });

  it('loss: every P&L figure carries − / text-loss, no arrow glyph', () => {
    mockDetail({ grossPnl: -200, netPnl: -195, ret: -12.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('loss');
      expect(n.className).toContain('text-loss');
      expect(n.textContent).toContain('−'); // U+2212
      expect(n.querySelector('svg')).toBeNull();
    }
    unmount(container, root);
  });

  it('flat: every P&L figure renders the literal zero with no marker', () => {
    mockDetail({ grossPnl: 0, netPnl: 0, ret: 0 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('flat');
      expect(n.textContent).not.toContain('—');
    }
    unmount(container, root);
  });

  it('absent: every P&L figure renders the em-dash with no glyph', () => {
    mockDetail({ grossPnl: null, netPnl: null, ret: null });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const nums = pnlNumerics(container);
    for (const n of nums) {
      expect(n.getAttribute('data-state')).toBe('absent');
      expect(n.textContent).toContain('—');
      expect(n.querySelector('svg')).toBeNull();
    }
    unmount(container, root);
  });
});

describe('PositionDetail — R/R + target-price cards', () => {
  it('renders values: Target R/R neutral, Actual R/R sign-colored', () => {
    mockDetail({
      grossPnl: 200,
      netPnl: 195,
      ret: 12.5,
      targetPrice: 165,
      targetRR: 1.5,
      actualRR: 1,
    });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    const targetPrice = cardNumeric(container, 'Target Price');
    expect(targetPrice.getAttribute('data-state')).toBe('neutral');

    const targetRR = cardNumeric(container, 'Target R/R');
    expect(targetRR.getAttribute('data-state')).toBe('neutral');
    expect(targetRR.textContent).toContain('1.50');

    // actualRR uses direction="auto" — positive reads as a gain with a leading +.
    const actualRR = cardNumeric(container, 'Actual R/R');
    expect(actualRR.getAttribute('data-state')).toBe('gain');
    expect(actualRR.textContent).toContain('+');

    unmount(container, root);
  });

  it('signs a losing Actual R/R with − / text-loss', () => {
    mockDetail({ grossPnl: -50, netPnl: -55, ret: -3, actualRR: -0.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    const actualRR = cardNumeric(container, 'Actual R/R');
    expect(actualRR.getAttribute('data-state')).toBe('loss');
    expect(actualRR.className).toContain('text-loss');
    expect(actualRR.textContent).toContain('−'); // U+2212

    unmount(container, root);
  });

  it('renders "—" for null Target Price / Target R/R / Actual R/R', () => {
    mockDetail({ grossPnl: null, netPnl: null, ret: null });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    for (const title of ['Target Price', 'Target R/R', 'Actual R/R']) {
      const el = cardNumeric(container, title);
      expect(el.getAttribute('data-state')).toBe('absent');
      expect(el.textContent).toContain('—');
    }

    unmount(container, root);
  });
});

// Contract — task 12 AC 8.4 (design C11/D14). Not reachable through
// FillDialog (the task's named Test seam): this is PositionDetail's own Net
// P&L card, so its red test lives here, next to the existing title-based
// regression guard this file already runs. Pre: a position with a net P&L.
// Call: render(PositionDetailView) (this file's own mount pattern). Observe:
// the card still titled "Net P&L" (D14: unchanged, the existing
// `cardNumeric` lookups above are the regression guard for that) now also
// carries the caption "Average cost". Source: requirements.md AC 8.4 +
// design.md D14's exact caption text.
describe('PositionDetail — Net P&L stays labelled as average cost (AC 8.4)', () => {
  it('keeps the Net P&L card title and adds an "Average cost" caption', () => {
    mockDetail({ grossPnl: 200, netPnl: 195, ret: 12.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    const titleEl = Array.from(container.querySelectorAll('[data-slot="card-title"]')).find(
      (el) => el.textContent === 'Net P&L',
    );
    const card = titleEl?.closest('[data-slot="card"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('Average cost');

    unmount(container, root);
  });
});

// Task 11 (design C12, web part). The detail endpoint carries accountCurrency
// (task 5); the page must format every money card in it and drop the
// hard-coded 'USD' fallback.
describe('PositionDetail — formats money cards in the account currency (Req 7.2)', () => {
  it("renders a EUR position's money cards in EUR, never USD", () => {
    mockOpenDetail({
      status: 'closed',
      accountCurrency: 'EUR',
      targetPrice: 100,
      grossPnl: 200,
      netPnl: 195,
    });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    for (const [title, amount] of [
      ['Target Price', 100],
      ['Gross P&L', 200],
      ['Net P&L', 195],
    ] as const) {
      const el = cardNumeric(container, title);
      expect(el.textContent).toContain(formatCurrency(amount, 'EUR'));
      expect(el.textContent).not.toContain(formatCurrency(amount, 'USD'));
    }

    unmount(container, root);
  });
});

describe('PositionDetail — unrealised cards for an eligible open stock (Req 7.3)', () => {
  it('adds Last Price, Unrealised P&L and Unrealised % cards and the staleness line', () => {
    mockOpenDetail({
      status: 'open',
      assetType: 'stock',
      accountCurrency: 'USD',
      groupId: null,
      totalEntryQuantity: 10,
      totalExitQuantity: 0,
      openCostBasis: 1001.0,
    });
    vi.mocked(useStockQuotes).mockReturnValue(
      configuredWith({
        state: 'price',
        lastPrice: '110.00',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    expect(cardNumeric(container, 'Last Price').textContent).toContain('110.00');
    expect(cardNumeric(container, 'Unrealised P&L').textContent).toContain('99.00');
    expect(cardNumeric(container, 'Unrealised %').textContent).toContain('9.89');
    expect(container.textContent).toContain('Prices are delayed about 15 minutes; oldest as of');

    unmount(container, root);
  });
});

describe('PositionDetail — cost-basis-only card for an ineligible open position (Req 7.4)', () => {
  it('shows the option reason', () => {
    mockOpenDetail({
      status: 'open',
      assetType: 'option',
      accountCurrency: 'USD',
      symbol: 'AAPL230120C00150000',
    });
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    const card = cardByTitle(container, 'Unrealised P&L');
    expect(card.textContent).toContain('Cost basis only');
    expect(card.textContent).toContain('Delayed quotes cover stocks, not option contracts.');

    unmount(container, root);
  });

  // Req 4.3: a grouped leg's reason must match the one the widget/drawer show.
  it('shows the group reason for a grouped leg, matching Req 4.3', () => {
    mockOpenDetail({
      status: 'open',
      assetType: 'stock',
      accountCurrency: 'USD',
      groupId: '00000000-0000-4000-a000-000000000099',
    });
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    const card = cardByTitle(container, 'Unrealised P&L');
    expect(card.textContent).toContain('Cost basis only');
    expect(card.textContent).toContain('Multi-leg groups are not marked to market.');

    unmount(container, root);
  });

  it('shows the currency reason for a EUR stock', () => {
    mockOpenDetail({
      status: 'open',
      assetType: 'stock',
      accountCurrency: 'EUR',
      groupId: null,
    });
    vi.mocked(useStockQuotes).mockReturnValue(configuredWith({ state: 'absent' }));

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    const card = cardByTitle(container, 'Unrealised P&L');
    expect(card.textContent).toContain('Cost basis only');
    expect(card.textContent).toContain('Quotes are in USD; this account is in EUR');

    unmount(container, root);
  });
});

// Req 7.5. The draft case is a true red test via the Req 7.6 hook-call
// assertion (today the hook is never called at all); the closed and
// not-configured cases are regression guards — no card renders today
// because the feature does not exist yet, not because these branches are
// gated — named for the implementer brief as regression guards, not red
// tests (no existing assertion in this file covers them).
describe('PositionDetail — no unrealised card for draft, closed, or unconfigured (Req 7.5)', () => {
  it('adds nothing for a draft position, and sends the hook no symbol', () => {
    mockOpenDetail({ status: 'draft', accountCurrency: 'USD' });
    vi.mocked(useStockQuotes).mockReturnValue(
      configuredWith({
        state: 'price',
        lastPrice: '110.00',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    expect(useStockQuotes).toHaveBeenCalledWith([]);
    expect(container.textContent).not.toContain('Last Price');
    expect(container.textContent).not.toContain('Cost basis only');

    unmount(container, root);
  });

  it('adds nothing for a closed position (regression guard)', () => {
    mockOpenDetail({ status: 'closed' });
    vi.mocked(useStockQuotes).mockReturnValue(
      configuredWith({
        state: 'price',
        lastPrice: '110.00',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    expect(container.textContent).not.toContain('Last Price');
    expect(container.textContent).not.toContain('Cost basis only');

    unmount(container, root);
  });

  it('adds nothing when the provider is not configured (regression guard)', () => {
    mockOpenDetail({ status: 'open' });
    vi.mocked(useStockQuotes).mockReturnValue(notConfigured());

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    expect(container.textContent).not.toContain('Last Price');
    expect(container.textContent).not.toContain('Cost basis only');

    unmount(container, root);
  });
});

describe("PositionDetail — the quote hook receives only this page's symbol (Req 7.6)", () => {
  it('passes the single symbol for an eligible open USD stock', () => {
    mockOpenDetail({
      status: 'open',
      assetType: 'stock',
      accountCurrency: 'USD',
      groupId: null,
      symbol: 'AAPL',
    });

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    expect(useStockQuotes).toHaveBeenCalledWith(['AAPL']);

    unmount(container, root);
  });

  it('passes nothing for a closed position', () => {
    mockOpenDetail({ status: 'closed', symbol: 'AAPL' });

    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    expect(useStockQuotes).toHaveBeenCalledWith([]);

    unmount(container, root);
  });

  it('passes nothing for an open option', () => {
    mockOpenDetail({ status: 'open', assetType: 'option', symbol: 'AAPL230120C00150000' });

    const { container, root } = mountOpen(<PositionDetailView positionId="p1" />);

    expect(useStockQuotes).toHaveBeenCalledWith([]);

    unmount(container, root);
  });
});
