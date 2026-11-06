// @vitest-environment jsdom
//
// The Open Positions widget summarises: it renders at most
// OPEN_POSITIONS_ROW_CAP rows, most recently updated first, and links to the
// full list carrying the total count (Req 3). These tests mount the widget
// with a stubbed positions hook and router, so the cap and the empty state are
// exercised without a query client or route context.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionListEntry, PositionListItem } from '@tradr/shared';

import { usePositions } from '@/features/positions/hooks/usePositions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/features/positions/hooks/usePositions', () => ({
  usePositions: vi.fn(),
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
