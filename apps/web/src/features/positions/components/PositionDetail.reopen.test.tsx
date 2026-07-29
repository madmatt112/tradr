// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionDetail } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';

import { usePosition, useReopenPosition } from '../hooks/usePosition';

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

import { PositionDetailView } from './PositionDetail';

// The disabled Open/Close affordances carry tooltips; __root.tsx provides the
// TooltipProvider at runtime, so supply one here as the dashboard route test does.
function renderDetail() {
  return render(
    <TooltipProvider>
      <PositionDetailView positionId="p1" />
    </TooltipProvider>,
  );
}

type PositionResult = ReturnType<typeof usePosition>;

// The same-day guard compares openedAt's calendar date to *today* in the
// account timezone. Anchor "today" to the real current UTC date string so the
// test is deterministic against the account tz 'UTC' the fixtures use.
const TODAY_UTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function makeDetail(overrides: Partial<PositionDetail> = {}): PositionDetail {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    userId: '00000000-0000-0000-0000-000000000100',
    accountId: '00000000-0000-0000-0000-000000000010',
    accountTimezone: 'UTC',
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    status: 'closed',
    notes: null,
    openedAt: `${TODAY_UTC}T12:00:00.000Z`,
    closedAt: `${TODAY_UTC}T13:00:00.000Z`,
    createdAt: `${TODAY_UTC}T12:00:00.000Z`,
    updatedAt: `${TODAY_UTC}T13:00:00.000Z`,
    fills: [],
    avgEntryPrice: 150,
    avgExitPrice: 160,
    totalEntryQuantity: 100,
    totalExitQuantity: 100,
    realizedPnl: 1000,
    returnPercentage: 6.67,
    brokerageName: null,
    grossPnl: 1000,
    brokerageFees: 0,
    netPnl: 1000,
    targetPrice: null,
    stopLoss: null,
    targetRR: null,
    actualRR: null,
    openUnits: 0,
    closedUnits: 100,
    ...overrides,
  } as PositionDetail;
}

function mockDetail(overrides: Partial<PositionDetail> = {}) {
  vi.mocked(usePosition).mockReturnValue({
    data: makeDetail(overrides),
    isLoading: false,
  } as unknown as PositionResult);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PositionDetail — Reopen button (R13 same-day)', () => {
  it('shows Reopen for a closed position opened today in the account timezone', () => {
    mockDetail({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: `${TODAY_UTC}T09:00:00.000Z`,
    });
    renderDetail();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });

  it('hides Reopen for a closed position opened on a previous day', () => {
    mockDetail({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('does not show Reopen for a non-closed (open) position', () => {
    mockDetail({ status: 'open', openedAt: `${TODAY_UTC}T09:00:00.000Z`, closedAt: null });
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('clicking Reopen calls the reopen mutation', () => {
    const mutate = vi.fn();
    vi.mocked(useReopenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useReopenPosition>);
    mockDetail({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: `${TODAY_UTC}T09:00:00.000Z`,
    });

    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({});
  });
});

describe('PositionDetail — delete confirmation copy', () => {
  it('warns about balance, tax/performance (incl. prior tax years) and wash-sale on a closed position', () => {
    mockDetail({ status: 'closed', openedAt: '2020-01-01T09:00:00.000Z' });
    renderDetail();

    // Only the header Delete exists before the dialog opens.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText(/removes its realized P&L from the account balance/i)).toBeTruthy();
    expect(screen.getByText(/tax and performance summaries/i)).toBeTruthy();
    expect(screen.getByText(/including prior tax years/i)).toBeTruthy();
    expect(screen.getByText(/wash-sale classification/i)).toBeTruthy();
  });

  it('keeps the lighter copy for a non-closed (open) position', () => {
    mockDetail({ status: 'open', openedAt: `${TODAY_UTC}T09:00:00.000Z`, closedAt: null });
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByText(/Are you sure you want to delete "AAPL"\?/i)).toBeTruthy();
    expect(screen.queryByText(/wash-sale classification/i)).toBeNull();
  });
});

// R11-AC4/AC5: Open/Close are shown for their status and disabled until the
// position is eligible, rather than hidden (the pre-amendment behavior).
describe('PositionDetail — Open/Close shown-and-disabled', () => {
  function openButton(name: string): HTMLButtonElement {
    return screen.getByRole('button', { name }) as HTMLButtonElement;
  }

  it('shows Open Position disabled on a draft with no entry fills', () => {
    mockDetail({ status: 'draft', fills: [], closedAt: null });
    renderDetail();
    expect(openButton('Open Position').disabled).toBe(true);
  });

  it('enables Open Position once an entry fill exists', () => {
    mockDetail({
      status: 'draft',
      closedAt: null,
      fills: [{ id: 'f1', type: 'entry' }] as unknown as PositionDetail['fills'],
    });
    renderDetail();
    expect(openButton('Open Position').disabled).toBe(false);
  });

  it('shows Close Position disabled while only partly exited', () => {
    mockDetail({
      status: 'open',
      closedAt: null,
      totalEntryQuantity: 100,
      totalExitQuantity: 40,
    });
    renderDetail();
    expect(openButton('Close Position').disabled).toBe(true);
  });

  it('enables Close Position once fully exited', () => {
    mockDetail({
      status: 'open',
      closedAt: null,
      totalEntryQuantity: 100,
      totalExitQuantity: 100,
    });
    renderDetail();
    expect(openButton('Close Position').disabled).toBe(false);
  });
});
