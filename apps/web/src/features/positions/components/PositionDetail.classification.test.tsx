// @vitest-environment jsdom
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

afterEach(() => {
  vi.clearAllMocks();
});

// A closed position; only `classification` varies per case. The API only sets a
// classification on closed rows, so the header badge keys off that one field.
function mockDetail(classification: 'winning' | 'losing' | 'breakeven' | null) {
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
      fills: [],
      avgEntryPrice: 150,
      avgExitPrice: 160,
      totalEntryQuantity: 100,
      totalExitQuantity: 100,
      realizedPnl: 0,
      returnPercentage: 0,
      brokerageName: null,
      grossPnl: 0,
      brokerageFees: 0,
      netPnl: 0,
      targetPrice: null,
      stopLoss: null,
      targetRR: null,
      actualRR: null,
      openUnits: 0,
      closedUnits: 0,
      classification,
    },
    isLoading: false,
  } as unknown as PositionResult);
}

function badge(container: HTMLElement): Element | null {
  return container.querySelector('[aria-label*="rounds to zero"]');
}

describe('PositionDetail — Breakeven badge in the header', () => {
  it('shows the badge for a breakeven position', () => {
    mockDetail('breakeven');
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    const el = badge(container);
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe('Breakeven');
    unmount(container, root);
  });

  it('shows no badge for a winning position', () => {
    mockDetail('winning');
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    expect(badge(container)).toBeNull();
    unmount(container, root);
  });

  it('shows no badge when classification is null', () => {
    mockDetail(null);
    const { container, root } = mountWith(<PositionDetailView positionId="p1" />);
    expect(badge(container)).toBeNull();
    unmount(container, root);
  });
});
