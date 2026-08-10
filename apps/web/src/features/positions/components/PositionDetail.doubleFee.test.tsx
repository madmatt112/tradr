// @vitest-environment jsdom
//
// The double-fee warning must depend on an ACTUAL brokerage being attached, not
// merely on `brokerageFees` being non-zero. That field carries the fee attributed
// to the realized portion whatever its source, so on a brokerage-less account it
// is just the manual fill fees pro-rated — and the warning would fire for every
// position that has a fee, telling the user to delete the only fee data they have.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('./FillDialog', () => ({ FillDialog: () => null }));
vi.mock('./FillTable', () => ({ FillTable: () => null }));
vi.mock('./PositionEditDialog', () => ({ PositionEditDialog: () => null }));
// The Fills-header coach mark reads onboarding state through TanStack Query;
// this file mounts bare, with no QueryClient. Its own suite covers it — this
// file is about the double-fee warning.
vi.mock('@/features/onboarding/components/CoachMark', () => ({ CoachMark: () => null }));

import { PositionDetailView } from './PositionDetail';

type PositionResult = ReturnType<typeof usePosition>;

const WARNING = /both manual fill fees and brokerage-calculated fees/;

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
  vi.clearAllMocks();
});

function mockDetail({
  fillFees,
  brokerageName,
  brokerageFees,
}: {
  fillFees: string;
  brokerageName: string | null;
  brokerageFees: number;
}) {
  vi.mocked(usePosition).mockReturnValue({
    data: {
      id: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000100',
      accountId: '00000000-0000-0000-0000-000000000010',
      accountTimezone: 'America/New_York',
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      notes: null,
      openedAt: '2026-05-01T12:00:00.000Z',
      closedAt: '2026-05-02T12:00:00.000Z',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-02T12:00:00.000Z',
      fills: [
        {
          id: '00000000-0000-0000-0000-0000000000f1',
          positionId: '00000000-0000-0000-0000-000000000001',
          type: 'exit',
          price: '160',
          quantity: '100',
          fees: fillFees,
          notes: null,
          filledAt: '2026-05-02T12:00:00.000Z',
          createdAt: '2026-05-02T12:00:00.000Z',
        },
      ],
      avgEntryPrice: 150,
      avgExitPrice: 160,
      totalEntryQuantity: 100,
      totalExitQuantity: 100,
      realizedPnl: 1000,
      returnPercentage: 6.7,
      brokerageName,
      grossPnl: 1000,
      brokerageFees,
      netPnl: 1000 - brokerageFees,
      targetPrice: null,
      stopLoss: null,
      targetRR: null,
      actualRR: null,
      openUnits: 0,
      closedUnits: 100,
    },
    isLoading: false,
  } as unknown as PositionResult);
}

describe('PositionDetail — double-fee warning', () => {
  it('stays hidden when no brokerage is attached, however large the fill fees', () => {
    // The regression: brokerageFees is non-zero here because it is the manual
    // fill fee attributed to the realized portion, NOT a calculated fee.
    mockDetail({ fillFees: '1.80', brokerageName: null, brokerageFees: 1.8 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    expect(container.textContent).not.toMatch(WARNING);

    unmount(container, root);
  });

  it('shows when a brokerage is attached and the position also carries manual fees', () => {
    mockDetail({ fillFees: '1.00', brokerageName: 'Interactive Brokers', brokerageFees: 2.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    expect(container.textContent).toMatch(WARNING);

    unmount(container, root);
  });

  it('stays hidden with a brokerage but no manual fill fees', () => {
    mockDetail({ fillFees: '0', brokerageName: 'Interactive Brokers', brokerageFees: 2.5 });
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);

    expect(container.textContent).not.toMatch(WARNING);

    unmount(container, root);
  });
});
