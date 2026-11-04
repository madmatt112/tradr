// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeeSchedule, PositionGroupEntry } from '@tradr/shared';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import { useAccountFeeSchedule } from '../hooks/useAccountFeeSchedule';
import { useCloseGroup } from '../hooks/usePositionGroups';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion                                                | Pre-condition                                                              | Call (seam)                                              | Observable result                                                                                                     | Source of expected value |
 * |-------------------------------------------------------------|---------------------------------------------------------------------------|-------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|---------------------------|
 * | Lists only open legs                                         | group with one open leg (AAPL) and one closed leg (MSFT)                  | render(CloseGroupDialog)                                   | an exit-price field for AAPL exists; none exists for MSFT                                                                  | requirements.md AC 6.5/4.5; tasks.md task 14 Prompt "the dialog lists only open legs" |
 * | Submits one exit per open leg with the optional date, and a price of 0 submits | group with two open legs; one leg's price typed as 0, the other non-zero; an optional date typed | click "Close all"                | useCloseGroup's mutateAsync is called once with `exits` containing one entry per open leg (positionId + the typed price, including '0') and `closedAt` set from the typed date | requirements.md AC 4.1, 4.5; tasks.md task 14 Prompt "submits one exit per open leg with the optional date" + "a price of 0 submits" |
 * | Fee prefills from the schedule and stays editable            | one open leg (stock, 1000 open units), a fee schedule mocked (0.005/share) | type '10' into the price field, then type '99' into the fee field | fee field reads '5' after the price is typed (1000 × 0.005), then reads '99' after being edited directly                  | requirements.md AC 4.5 "preview an editable fee from the account's schedule"; tasks.md task 14 Prompt |
 * | Fee reads 0 at a price of 0                                   | same one-leg setup                                                        | type '0' into the price field                              | fee field reads '0'                                                                                                        | tasks.md task 14 Prompt: "computeFillFee returns null at a price of 0 ..., so the fee then reads 0 and stays editable (AC 4.5)" |
 * | A server error keeps the dialog open and shows the leg's message | mutateAsync rejects with `{ error: { message: "AAPL is already closed" } }` | click "Close all"                                           | onOpenChange is never called with `false`; the text "AAPL is already closed" renders in the dialog                        | design.md Error Handling #5; tasks.md task 14 Prompt "a server error keeps the dialog open with the message shown" |
 */

vi.mock('../hooks/usePositionGroups', () => ({
  useCloseGroup: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/useAccountFeeSchedule', () => ({
  useAccountFeeSchedule: vi.fn(() => null),
}));

import { CloseGroupDialog } from './CloseGroupDialog';

const schedule: FeeSchedule = {
  stockPerShareCommission: '0.005',
  stockMinPerFill: '1',
  stockMaxPerFill: '0',
  optionsPerContractCommission: '0.65',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '0',
  optionsMaxPerFill: '0',
};

const GROUP_ACCOUNT_ID = '00000000-0000-4000-a000-000000000010';

function makeGroup(overrides: Partial<PositionGroupEntry> = {}): PositionGroupEntry {
  const openLeg = {
    ...makePosition({
      id: 'leg-aapl',
      symbol: 'AAPL',
      status: 'open',
      assetType: 'stock',
      openUnits: 1000,
      closedUnits: 0,
      accountId: GROUP_ACCOUNT_ID,
    }),
    groupId: 'group-1',
  };
  return {
    kind: 'group',
    id: 'group-1',
    userId: '00000000-0000-4000-a000-000000000100',
    accountId: GROUP_ACCOUNT_ID,
    accountName: 'Test Account',
    accountCurrency: 'USD',
    accountTimezone: 'America/New_York',
    underlying: 'AAPL',
    label: 'AAPL spread',
    detectedLabel: 'AAPL spread',
    labelOverride: null,
    status: 'open',
    openedAt: '2026-05-01T12:00:00.000Z',
    closedAt: null,
    createdAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T12:00:00.000Z',
    tags: [],
    classification: null,
    netEntry: 150,
    grossPnl: null,
    netPnl: null,
    brokerageFees: 0,
    openCostBasis: 150000,
    maxLoss: null,
    maxLossReason: null,
    legs: [openLeg],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(useAccountFeeSchedule).mockReturnValue(null);
});

function renderDialog(props: Partial<React.ComponentProps<typeof CloseGroupDialog>> = {}) {
  return render(<CloseGroupDialog group={makeGroup()} open onOpenChange={vi.fn()} {...props} />);
}

describe('CloseGroupDialog — lists only open legs', () => {
  it('shows an exit price field for an open leg and none for a closed one', () => {
    const closedLeg = {
      ...makePosition({
        id: 'leg-msft',
        symbol: 'MSFT',
        status: 'closed',
        openUnits: 0,
        closedUnits: 100,
        accountId: GROUP_ACCOUNT_ID,
      }),
      groupId: 'group-1',
    };
    const openLeg = {
      ...makePosition({
        id: 'leg-aapl',
        symbol: 'AAPL',
        status: 'open',
        openUnits: 1000,
        accountId: GROUP_ACCOUNT_ID,
      }),
      groupId: 'group-1',
    };

    renderDialog({ group: makeGroup({ legs: [openLeg, closedLeg] }) });

    expect(screen.getByLabelText('Exit price (AAPL)')).toBeTruthy();
    expect(screen.queryByLabelText('Exit price (MSFT)')).toBeNull();
  });
});

describe('CloseGroupDialog — submission', () => {
  it('submits one exit per open leg, carrying the optional date, and accepts a price of 0', async () => {
    const legA = {
      ...makePosition({
        id: 'leg-aapl',
        symbol: 'AAPL',
        status: 'open',
        openUnits: 1000,
        accountId: GROUP_ACCOUNT_ID,
      }),
      groupId: 'group-1',
    };
    const legB = {
      ...makePosition({
        id: 'leg-goog',
        symbol: 'GOOG',
        status: 'open',
        openUnits: 50,
        accountId: GROUP_ACCOUNT_ID,
      }),
      groupId: 'group-1',
    };
    const mutateAsync = vi.fn().mockResolvedValue({ id: 'group-1' });
    vi.mocked(useCloseGroup).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCloseGroup>);

    renderDialog({ group: makeGroup({ legs: [legA, legB] }) });

    fireEvent.change(screen.getByLabelText('Exit price (AAPL)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Exit price (GOOG)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-06-01T12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close all' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());

    const payload = mutateAsync.mock.calls[0][0];
    expect(payload.exits).toHaveLength(2);
    expect(payload.exits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ positionId: 'leg-aapl', price: '0' }),
        expect.objectContaining({ positionId: 'leg-goog', price: '10' }),
      ]),
    );
    expect(payload.closedAt).toBe(new Date('2026-06-01T12:00').toISOString());
  });
});

describe('CloseGroupDialog — brokerage fee preview', () => {
  it('prefills the fee from the schedule and keeps it directly editable', () => {
    vi.mocked(useAccountFeeSchedule).mockReturnValue(schedule);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Exit price (AAPL)'), { target: { value: '10' } });
    // 1000 open units × stockPerShareCommission 0.005 = 5.00
    expect((screen.getByLabelText('Fee (AAPL)') as HTMLInputElement).value).toBe('5');

    fireEvent.change(screen.getByLabelText('Fee (AAPL)'), { target: { value: '99' } });
    expect((screen.getByLabelText('Fee (AAPL)') as HTMLInputElement).value).toBe('99');
  });

  it('reads the fee as 0 when the exit price is 0', () => {
    vi.mocked(useAccountFeeSchedule).mockReturnValue(schedule);
    renderDialog();

    fireEvent.change(screen.getByLabelText('Exit price (AAPL)'), { target: { value: '0' } });
    expect((screen.getByLabelText('Fee (AAPL)') as HTMLInputElement).value).toBe('0');
  });
});

describe('CloseGroupDialog — a failed close', () => {
  it("keeps the dialog open and shows the failing leg's message", async () => {
    const mutateAsync = vi.fn().mockRejectedValue({ error: { message: 'AAPL is already closed' } });
    vi.mocked(useCloseGroup).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCloseGroup>);
    const onOpenChange = vi.fn();

    renderDialog({ onOpenChange });

    fireEvent.change(screen.getByLabelText('Exit price (AAPL)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close all' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('AAPL is already closed')).toBeTruthy());

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
