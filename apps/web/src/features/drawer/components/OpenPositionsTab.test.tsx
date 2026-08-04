// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { formatCurrency } from '@/lib/format';
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

beforeEach(() => {
  vi.mocked(usePositions).mockReset();
  vi.mocked(useMediaQuery).mockReset();
  vi.mocked(useMediaQuery).mockReturnValue(false);
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
        id: '00000000-0000-0000-0000-0000000000a1',
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
        id: '00000000-0000-0000-0000-0000000000a2',
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
        id: '00000000-0000-0000-0000-0000000000b1',
        symbol: 'OLD',
        openedAt: '2026-05-01T10:00:00.000Z',
      }),
      makePosition({
        id: '00000000-0000-0000-0000-0000000000b2',
        symbol: 'NULLROW',
        openedAt: null,
      }),
      makePosition({
        id: '00000000-0000-0000-0000-0000000000b3',
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

  it('closes the drawer on row click when on mobile', () => {
    vi.mocked(useMediaQuery).mockReturnValue(true);
    const rows = [
      makePosition({
        id: '00000000-0000-0000-0000-0000000000c1',
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
    expect(link?.getAttribute('href')).toBe('/positions/00000000-0000-0000-0000-0000000000c1');

    act(() => {
      link!.click();
    });

    expect(useDrawerStore.getState().isOpen).toBe(false);
    unmount(container, root);
  });
});
