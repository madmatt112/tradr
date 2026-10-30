// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { holdTerm, type FeeSchedule, type Fill } from '@tradr/shared';

import { useAccountFeeSchedule } from '../hooks/useAccountFeeSchedule';
import { usePositionLots } from '../hooks/usePositionLots';
import { useTransferLink } from '../hooks/useTransferLink';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const addFillMutate = vi.fn().mockResolvedValue(undefined);
const updateFillMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('../hooks/usePosition', () => ({
  useAddFill: vi.fn(() => ({ mutateAsync: addFillMutate, isPending: false })),
  useUpdateFill: vi.fn(() => ({ mutateAsync: updateFillMutate, isPending: false })),
}));

vi.mock('../hooks/useAccountFeeSchedule', () => ({
  useAccountFeeSchedule: vi.fn(() => null),
}));

// usePositionLots.ts does not exist until task 12 is implemented, so every test
// in this file fails to resolve this module until the implementer creates it
// (task note: "it gains a vi.mock of the new hook"). Default to no lots so the
// pre-existing suites above render no picker and keep their current assertions.
vi.mock('../hooks/usePositionLots', () => ({
  usePositionLots: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

// useTransferLink.ts does not exist until task 10 is implemented, so every
// test in this file fails to resolve this module until the implementer
// creates it. Default to no link and no candidates so the pre-existing
// suites above render no section and keep their current assertions.
const linkMutateAsync = vi.fn().mockResolvedValue(undefined);
const removeLinkMutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('../hooks/useTransferLink', () => ({
  useTransferLink: vi.fn(() => ({ data: undefined, isLoading: false })),
  useSetTransferLink: vi.fn(() => ({ mutateAsync: linkMutateAsync, isPending: false })),
  useRemoveTransferLink: vi.fn(() => ({ mutateAsync: removeLinkMutateAsync, isPending: false })),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

// AccountDialog.test.tsx's established stand-in: Radix Select's pointer-capture
// machinery is browser-only, so the candidate picker is driven as a native
// <select>. SelectTrigger's `id` (what the sibling <Label htmlFor> points at)
// is lifted onto the <select> so the control stays reachable by its label.
vi.mock('@/components/ui/select', async () => {
  const { Children, isValidElement } = await import('react');
  const triggerId = (children: React.ReactNode): string | undefined => {
    let id: string | undefined;
    Children.forEach(children, (child) => {
      if (isValidElement<{ id?: string }>(child) && child.props.id) id = child.props.id;
    });
    return id;
  };
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange: (v: string) => void;
      children: React.ReactNode;
    }) => (
      <select
        id={triggerId(children)}
        value={value ?? ''}
        onChange={(e) => onValueChange(e.currentTarget.value)}
      >
        {children}
      </select>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import { FillDialog, type FillPositionContext } from './FillDialog';

const schedule: FeeSchedule = {
  stockPerShareCommission: '0.005',
  stockMinPerFill: '1',
  stockMaxPerFill: '0',
  optionsPerContractCommission: '0.65',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '0',
  optionsMaxPerFill: '0',
};

const position: FillPositionContext = {
  accountId: '00000000-0000-4000-a000-000000000010',
  assetType: 'stock',
  side: 'long',
  openUnits: 100,
  avgEntryPrice: 150,
  targetPrice: 195,
  stopLoss: 140,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(useAccountFeeSchedule).mockReturnValue(null);
  vi.mocked(usePositionLots).mockReturnValue({
    data: undefined,
    isLoading: false,
  } as ReturnType<typeof usePositionLots>);
  vi.mocked(useTransferLink).mockReturnValue({
    data: undefined,
    isLoading: false,
  } as ReturnType<typeof useTransferLink>);
});

function renderDialog(props: Partial<React.ComponentProps<typeof FillDialog>> = {}) {
  return render(
    <FillDialog
      open
      onOpenChange={vi.fn()}
      positionId="p1"
      positionStatus="open"
      position={position}
      {...props}
    />,
  );
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

// Two entry lots for a US position: LOT_A opened 31 days before the fixed
// dialog filledAt used in the term test (short-term), LOT_B opened well over a
// year before it (long-term) — see holdTerm usage below.
const LOT_A = {
  entryFillId: '00000000-0000-4000-a000-000000000101',
  filledAt: '2025-05-01T00:00:00.000Z',
  price: '100.00',
  quantity: '10',
  available: '10',
};
const LOT_B = {
  entryFillId: '00000000-0000-4000-a000-000000000102',
  filledAt: '2023-01-01T00:00:00.000Z',
  price: '90.00',
  quantity: '10',
  available: '10',
};
const DIALOG_FILLED_AT = '2025-06-01T12:00';

function mockLots(
  data:
    | {
        method: 'fifo' | 'average' | 'acb';
        jurisdiction: 'US' | 'CA' | 'other';
        lots: Array<{
          entryFillId: string;
          filledAt: string;
          price: string;
          quantity: string;
          available: string;
        }>;
      }
    | undefined,
) {
  vi.mocked(usePositionLots).mockReturnValue({
    data,
    isLoading: false,
  } as ReturnType<typeof usePositionLots>);
}

const editFillWithSelection: Fill = {
  id: 'f1',
  positionId: 'p1',
  type: 'exit',
  price: '160',
  quantity: '10',
  fees: '0',
  notes: null,
  filledAt: '2025-06-01T12:00:00.000Z',
  createdAt: '2025-06-01T12:00:00.000Z',
  lotSelection: [{ entryFillId: LOT_A.entryFillId, quantity: '4' }],
};

// Fixtures for the transfer-link section (task 10; design C7; requirements.md
// AC 6.5).
const editExitFill: Fill = {
  id: 'f2',
  positionId: 'p1',
  type: 'exit',
  price: '160',
  quantity: '10',
  fees: '0',
  notes: null,
  filledAt: '2025-06-01T12:00:00.000Z',
  createdAt: '2025-06-01T12:00:00.000Z',
  lotSelection: null,
};
const editEntryFill: Fill = {
  ...editExitFill,
  id: 'f3',
  type: 'entry',
};

const LINK = {
  id: 'link-1',
  exitFillId: editExitFill.id,
  entryFillId: '00000000-0000-4000-a000-000000000201',
  entryPositionId: 'p2',
  entryAccountId: 'a2',
  entryAccountName: 'TFSA',
  createdAt: '2025-06-01T00:00:00.000Z',
};
const CANDIDATE_A = {
  entryFillId: '00000000-0000-4000-a000-000000000301',
  positionId: 'p3',
  accountId: 'a3',
  accountName: 'RRSP',
  filledAt: '2025-05-15T00:00:00.000Z',
  price: '100.00',
  quantity: '10',
};
const CANDIDATE_B = {
  entryFillId: '00000000-0000-4000-a000-000000000302',
  positionId: 'p4',
  accountId: 'a4',
  accountName: 'Margin',
  filledAt: '2025-05-20T00:00:00.000Z',
  price: '105.00',
  quantity: '10',
};

function mockTransferLink(data: {
  link: typeof LINK | null;
  candidates: Array<typeof CANDIDATE_A>;
}) {
  vi.mocked(useTransferLink).mockReturnValue({
    data,
    isLoading: false,
  } as ReturnType<typeof useTransferLink>);
}

describe('FillDialog — price prefill differs by direction', () => {
  it('prefills an entry with the average entry price', () => {
    renderDialog({ defaultType: 'entry' });
    expect(field('Price').value).toBe('150');
  });

  it('prefills an exit with the target price', () => {
    renderDialog({ defaultType: 'exit' });
    expect(field('Price').value).toBe('195');
  });

  it('leaves the price empty when the position carries no prices', () => {
    renderDialog({
      defaultType: 'entry',
      position: { ...position, avgEntryPrice: null, targetPrice: null, stopLoss: null },
    });
    expect(field('Price').value).toBe('');
  });
});

describe('FillDialog — quantity presets', () => {
  it('offers fractions of open size when reducing', () => {
    renderDialog({ defaultType: 'exit' });
    expect(screen.getByText('of 100 open')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '½' }));
    expect(field('Quantity').value).toBe('50');
  });

  it('rounds a preset down so it cannot exceed the open size', () => {
    renderDialog({ defaultType: 'exit', position: { ...position, openUnits: 10 } });
    fireEvent.click(screen.getByRole('button', { name: '⅓' }));
    expect(field('Quantity').value).toBe('3.33333333');
  });

  it('fills the exact open size for All', () => {
    renderDialog({ defaultType: 'exit' });
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(field('Quantity').value).toBe('100');
  });

  it('does not offer presets on an entry — there is no denominator', () => {
    renderDialog({ defaultType: 'entry' });
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
  });

  it('does not offer presets when nothing is open', () => {
    renderDialog({ defaultType: 'exit', position: { ...position, openUnits: 0 } });
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
  });
});

describe('FillDialog — brokerage fee preview', () => {
  it('leaves fees editable when the account has no fee schedule', () => {
    renderDialog({ defaultType: 'entry' });
    expect(field('Fees').readOnly).toBe(false);
    expect(screen.queryByLabelText('Override')).toBeNull();
  });

  it('shows a read-only calculated fee when a schedule exists', () => {
    vi.mocked(useAccountFeeSchedule).mockReturnValue(schedule);
    renderDialog({ defaultType: 'entry' });

    fireEvent.change(field('Quantity'), { target: { value: '1000' } });
    // 1000 shares × 0.005 = 5.00
    expect(field('Fees').value).toBe('5');
    expect(field('Fees').readOnly).toBe(true);
  });

  it('updates the preview as price and quantity change', () => {
    vi.mocked(useAccountFeeSchedule).mockReturnValue(schedule);
    renderDialog({ defaultType: 'entry' });

    fireEvent.change(field('Quantity'), { target: { value: '1000' } });
    expect(field('Fees').value).toBe('5');

    fireEvent.change(field('Quantity'), { target: { value: '4000' } });
    expect(field('Fees').value).toBe('20');
  });

  it('re-opens the field when Override is switched on', () => {
    vi.mocked(useAccountFeeSchedule).mockReturnValue(schedule);
    renderDialog({ defaultType: 'entry' });

    expect(field('Fees').readOnly).toBe(true);
    fireEvent.click(screen.getByLabelText('Override'));
    expect(field('Fees').readOnly).toBe(false);
  });
});

// Manual fill fees and the server's brokerageFees are additive, so a calculated
// fee must NOT be written onto the fill.
describe('FillDialog — submitted fees avoid double-counting', () => {
  it('submits 0 when the fee is schedule-derived', async () => {
    vi.mocked(useAccountFeeSchedule).mockReturnValue(schedule);
    renderDialog({ defaultType: 'entry' });

    fireEvent.change(field('Quantity'), { target: { value: '1000' } });
    expect(field('Fees').value).toBe('5');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addFillMutate).toHaveBeenCalled());
    expect(addFillMutate.mock.calls[0][0]).toMatchObject({ fees: '0' });
  });

  it('submits the typed value when overridden', async () => {
    vi.mocked(useAccountFeeSchedule).mockReturnValue(schedule);
    renderDialog({ defaultType: 'entry' });

    fireEvent.change(field('Quantity'), { target: { value: '1000' } });
    fireEvent.click(screen.getByLabelText('Override'));
    fireEvent.change(field('Fees'), { target: { value: '2.75' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addFillMutate).toHaveBeenCalled());
    expect(addFillMutate.mock.calls[0][0]).toMatchObject({ fees: '2.75' });
  });

  it('submits the typed value when there is no schedule at all', async () => {
    renderDialog({ defaultType: 'entry' });

    fireEvent.change(field('Quantity'), { target: { value: '1000' } });
    fireEvent.change(field('Fees'), { target: { value: '1.10' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addFillMutate).toHaveBeenCalled());
    expect(addFillMutate.mock.calls[0][0]).toMatchObject({ fees: '1.10' });
  });
});

// The row chains "open the position" off a successful add, and cancels that
// intent from onOpenChange — so the ordering here is load-bearing.
describe('FillDialog — onAdded', () => {
  it('fires on a successful add, before the dialog closes', async () => {
    const calls: string[] = [];
    renderDialog({
      defaultType: 'entry',
      onAdded: () => calls.push('added'),
      onOpenChange: (open: boolean) => calls.push(open ? 'open' : 'close'),
    });

    fireEvent.change(field('Quantity'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(calls).toContain('added'));
    expect(calls).toEqual(['added', 'close']);
  });

  it('does not fire when the dialog is cancelled', () => {
    const onAdded = vi.fn();
    renderDialog({ defaultType: 'entry', onAdded });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe('FillDialog — single-purpose type', () => {
  it('hides the type picker when the caller fixed the direction', () => {
    renderDialog({ defaultType: 'exit' });
    expect(screen.queryByText('Type')).toBeNull();
    expect(screen.getByText('Reduce position')).toBeTruthy();
  });

  it('still offers the picker on the generic add-fill flow', () => {
    renderDialog({});
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.getByText('Add Fill')).toBeTruthy();
  });
});

// Contract block — task 12, FillDialog lot picker (design C11; requirements.md
// Requirement 4). Every case renders FillDialog with usePositionLots mocked
// and reaches the behaviour through that render, exactly as the task's Test
// line specifies.
//
// AC 4.1 — Pre: exit fill, method fifo, two lots with available > 0. Call:
//   render(FillDialog, {defaultType:'exit'}). Observe: a "FIFO" toggle button
//   with aria-pressed="true" and a "Pick lots" button with aria-pressed=
//   "false". Source: requirements.md AC 4.1 ("offer a lot picker, with FIFO
//   preselected").
// AC 4.2 — Pre: as above, Pick lots clicked, dialog filledAt set to a fixed
//   value. Call: same render, then click "Pick lots". Observe: each lot row
//   (data-testid lot-row-<entryFillId>) shows its filledAt, price, available
//   and (jurisdiction US) its term. Source: requirements.md AC 4.2; term
//   values from the real holdTerm(lot.filledAt, dialog filledAt) (task 1,
//   packages/shared/src/lib/tax-lots.ts).
// AC 4.3 — Pre: exit quantity 10, one lot picked at 6. Call: same render.
//   Observe: Add button disabled, a lot-picker-difference element containing
//   "4", and no addFillMutate call on click. Source: requirements.md AC 4.3
//   (10 - 6 = 4).
// AC 4.4 (+ design C11, no standalone AC for the pick-mode half — folded
//   here) — Pre: FIFO left selected, vs. two lots picked summing to the exit
//   quantity. Call: fill the form and click Add. Observe: FIFO submits a
//   payload with no lotSelection key; a pick submits
//   lotSelection:[{entryFillId,quantity}, ...] matching the entered values.
//   Source: requirements.md AC 4.4; design.md C11 ("a pick submits the
//   picked items" — brief Success line, same task).
// AC 4.5 — Pre: (a) method average, two available lots; (b) method fifo, one
//   of two lots has available "0". Call: same render. Observe: no "FIFO" /
//   "Pick lots" buttons in either case. Source: requirements.md AC 4.5.
// AC 4.6 — Pre: edit of an exit fill carrying a stored selection.
//   (a) two available lots: Call: render(FillDialog, {fill}). Observe: Pick
//       lots pre-pressed, the stored quantity pre-filled; clicking FIFO then
//       Save sends data.lotSelection === null. Source: requirements.md
//       AC 4.6 first sentence + brief Success ("switching to FIFO submits
//       null", resolving the brief's own wording over requirements.md's
//       "submits no selection" — UpdateFillSchema's lotSelection is
//       nullable+optional, so a clear can only be expressed by sending
//       null, never by omission).
//   (b) fewer than two available lots: Call: render(FillDialog, {fill}).
//       Observe: only a "Clear lot selection" button; clicking it then Save
//       sends lotSelection === null. Source: requirements.md AC 4.6 second
//       sentence.
//   (c) restriction, folded under AC 4.6 ("an untouched edit picker sends no
//       field"): Call: render(FillDialog, {fill}), change an unrelated field,
//       click Save. Observe: data has no lotSelection key. Source: task 12's
//       Restrictions line.
// AC 4.7 — Pre: picker shown, Pick lots clicked. Call: same render. Observe:
//   the FIFO and Pick lots buttons carry cursor-pointer; each lot row's
//   quantity input has a <label for=...> matching its id. Source:
//   requirements.md AC 4.7.
//
// AC 8.4 is NOT reachable through FillDialog — it is PositionDetail's Net
// P&L card, a different component the task also touches. Its red test lives
// in PositionDetail.pnl.test.tsx instead (see that file); flagged here
// because the task names only this file's render call as the seam.
describe('FillDialog — lot picker (AC 4.1)', () => {
  it('shows the picker with FIFO preselected for a FIFO exit with two available lots', () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    const fifoBtn = screen.getByRole('button', { name: 'FIFO' });
    const pickBtn = screen.getByRole('button', { name: 'Pick lots' });
    expect(fifoBtn.getAttribute('aria-pressed')).toBe('true');
    expect(pickBtn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('FillDialog — lot picker rows (AC 4.2)', () => {
  it("lists each US lot's open date, price, available quantity and term at the dialog filledAt", () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    fireEvent.change(field('Date & Time'), { target: { value: DIALOG_FILLED_AT } });
    fireEvent.click(screen.getByRole('button', { name: 'Pick lots' }));

    const rowA = screen.getByTestId(`lot-row-${LOT_A.entryFillId}`);
    expect(within(rowA).getByText(LOT_A.filledAt)).toBeTruthy();
    expect(within(rowA).getByText(LOT_A.price)).toBeTruthy();
    expect(within(rowA).getByText(LOT_A.available)).toBeTruthy();
    expect(within(rowA).getByText(holdTerm(LOT_A.filledAt, DIALOG_FILLED_AT))).toBeTruthy();

    const rowB = screen.getByTestId(`lot-row-${LOT_B.entryFillId}`);
    expect(within(rowB).getByText(holdTerm(LOT_B.filledAt, DIALOG_FILLED_AT))).toBeTruthy();
    // The two lots fall on opposite sides of the 365-day line, so this also
    // proves both terms are read live rather than one hardcoded value.
    expect(holdTerm(LOT_A.filledAt, DIALOG_FILLED_AT)).not.toBe(
      holdTerm(LOT_B.filledAt, DIALOG_FILLED_AT),
    );
  });
});

describe('FillDialog — lot picker sum mismatch (AC 4.3)', () => {
  it('blocks submit and shows the difference when picks do not sum to the exit quantity', () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    fireEvent.change(field('Quantity'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pick lots' }));

    const rowA = screen.getByTestId(`lot-row-${LOT_A.entryFillId}`);
    fireEvent.change(within(rowA).getByRole('textbox'), { target: { value: '6' } });

    const addBtn = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
    expect(screen.getByTestId('lot-picker-difference').textContent).toContain('4');

    fireEvent.click(addBtn);
    expect(addFillMutate).not.toHaveBeenCalled();
  });

  it('does not flag a fractional pick that sums within tolerance (0.1 + 0.2 = 0.3)', async () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    fireEvent.change(field('Quantity'), { target: { value: '0.3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pick lots' }));
    fireEvent.change(
      within(screen.getByTestId(`lot-row-${LOT_A.entryFillId}`)).getByRole('textbox'),
      { target: { value: '0.1' } },
    );
    fireEvent.change(
      within(screen.getByTestId(`lot-row-${LOT_B.entryFillId}`)).getByRole('textbox'),
      { target: { value: '0.2' } },
    );

    const addBtn = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    // Float noise is absorbed, so the readout shows an exact match, not 4e-17.
    expect(screen.getByTestId('lot-picker-difference').textContent).toContain('difference 0');

    fireEvent.click(addBtn);
    await waitFor(() => expect(addFillMutate).toHaveBeenCalled());
  });
});

describe('FillDialog — lot picker submission (AC 4.4)', () => {
  it('leaves FIFO selected and submits no lotSelection', async () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    fireEvent.change(field('Quantity'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addFillMutate).toHaveBeenCalled());
    expect(addFillMutate.mock.calls[0][0]).not.toHaveProperty('lotSelection');
  });

  it('submits the picked items when the user picks lots', async () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    fireEvent.change(field('Quantity'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pick lots' }));
    fireEvent.change(
      within(screen.getByTestId(`lot-row-${LOT_A.entryFillId}`)).getByRole('textbox'),
      {
        target: { value: '4' },
      },
    );
    fireEvent.change(
      within(screen.getByTestId(`lot-row-${LOT_B.entryFillId}`)).getByRole('textbox'),
      {
        target: { value: '6' },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addFillMutate).toHaveBeenCalled());
    const sent = addFillMutate.mock.calls[0][0];
    expect(sent.lotSelection).toHaveLength(2);
    expect(sent.lotSelection).toEqual(
      expect.arrayContaining([
        { entryFillId: LOT_A.entryFillId, quantity: '4' },
        { entryFillId: LOT_B.entryFillId, quantity: '6' },
      ]),
    );
  });
});

describe('FillDialog — no picker under average cost or one available lot (AC 4.5)', () => {
  it('shows no picker under average cost even with two available lots', () => {
    mockLots({ method: 'average', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    expect(screen.queryByRole('button', { name: 'FIFO' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pick lots' })).toBeNull();
  });

  it('shows no picker under FIFO when only one lot carries available quantity', () => {
    mockLots({
      method: 'fifo',
      jurisdiction: 'US',
      lots: [LOT_A, { ...LOT_B, available: '0' }],
    });
    renderDialog({ defaultType: 'exit' });

    expect(screen.queryByRole('button', { name: 'FIFO' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pick lots' })).toBeNull();
  });
});

describe('FillDialog — editing a selected exit (AC 4.6)', () => {
  it('opens pick mode with the stored selection, and switching to FIFO submits null', async () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ fill: editFillWithSelection });

    const pickBtn = screen.getByRole('button', { name: 'Pick lots' });
    expect(pickBtn.getAttribute('aria-pressed')).toBe('true');
    const rowA = screen.getByTestId(`lot-row-${LOT_A.entryFillId}`);
    expect((within(rowA).getByRole('textbox') as HTMLInputElement).value).toBe('4');

    fireEvent.click(screen.getByRole('button', { name: 'FIFO' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateFillMutate).toHaveBeenCalled());
    expect(updateFillMutate.mock.calls[0][0].data).toEqual({ lotSelection: null });
  });

  it('offers only "Clear lot selection" when fewer than two lots have available quantity, and clearing submits null', async () => {
    mockLots({
      method: 'fifo',
      jurisdiction: 'US',
      lots: [
        { ...LOT_A, available: '4' },
        { ...LOT_B, available: '0' },
      ],
    });
    renderDialog({ fill: editFillWithSelection });

    expect(screen.queryByRole('button', { name: 'FIFO' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pick lots' })).toBeNull();
    const clearBtn = screen.getByRole('button', { name: 'Clear lot selection' });

    fireEvent.click(clearBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateFillMutate).toHaveBeenCalled());
    expect(updateFillMutate.mock.calls[0][0].data).toEqual({ lotSelection: null });
  });

  it('sends no lotSelection field when an existing selection is left untouched', async () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ fill: editFillWithSelection });

    fireEvent.change(field('Notes'), { target: { value: 'updated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateFillMutate).toHaveBeenCalled());
    expect(updateFillMutate.mock.calls[0][0].data).not.toHaveProperty('lotSelection');
  });
});

describe('FillDialog — lot picker controls (AC 4.7)', () => {
  it('gives the toggle buttons cursor-pointer and ties each quantity input to a Label by htmlFor', () => {
    mockLots({ method: 'fifo', jurisdiction: 'US', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    for (const name of ['FIFO', 'Pick lots']) {
      expect(screen.getByRole('button', { name }).className).toContain('cursor-pointer');
    }

    fireEvent.click(screen.getByRole('button', { name: 'Pick lots' }));

    for (const lot of [LOT_A, LOT_B]) {
      const row = screen.getByTestId(`lot-row-${lot.entryFillId}`);
      const input = within(row).getByRole('textbox') as HTMLInputElement;
      const label = row.querySelector('label');
      expect(label).not.toBeNull();
      expect(input.id).toBeTruthy();
      expect(label!.getAttribute('for')).toBe(input.id);
    }
  });
});

describe('FillDialog — no lots network call when closed or on an entry (restriction, folded under AC 4.1/4.6)', () => {
  it('passes enabled:false while the dialog is closed or recording an entry', () => {
    renderDialog({ open: false, defaultType: 'exit' });
    let lastCall = vi.mocked(usePositionLots).mock.calls.at(-1);
    expect(lastCall?.[2]).toBe(false);
    cleanup();

    renderDialog({ defaultType: 'entry' });
    lastCall = vi.mocked(usePositionLots).mock.calls.at(-1);
    expect(lastCall?.[2]).toBe(false);
  });
});

// Contract block — task 10, FillDialog transfer-link section (design C7 web
// bullet; requirements.md AC 6.5). Every case renders FillDialog with
// useTransferLink mocked and reaches the behaviour through that render,
// exactly as the task's Test line specifies.
//
// AC 6.5 (a) — Pre: exit edit, the fetched data carries a link. Call:
//   render(FillDialog, {fill: editExitFill}). Observe: the linked account's
//   name renders, and clicking "Remove link" calls the delete mutation.
//   Source: task 10 Success ("an exit edit with a link shows the linked
//   account and Remove link, which calls the delete mutation").
// AC 6.5 (b) — Pre: exit edit, the fetched data carries two candidates and no
//   link. Call: same render, pick a candidate in the Select, click
//   "Link transfer". Observe: each candidate is listed as
//   "account · date · quantity @ price"; the mutation is sent the chosen
//   entryFillId. Source: task 10 Success ("lists each and Link transfer
//   sends the chosen entryFillId") + design C7 web bullet (candidate label
//   shape).
// AC 6.5 (c) — Pre: exit edit, no link and no candidates. Call: same render.
//   Observe: no "Link transfer" button. Source: task 10 Success ("an exit
//   edit with no candidates and no link shows no Link transfer").
// AC 6.5 (d) — Pre: (i) entry edit; (ii) a create (no fill). Call: same
//   render. Observe: neither "Link transfer" nor "Remove link" renders in
//   either case. Source: task 10 Success ("an entry edit and a create show
//   no section").
// AC 6.5 (e) — Pre: exit edit, one candidate, the link mutation rejects with
//   a 409-shaped `{ error: { message } }`. Call: same render, click
//   "Link transfer". Observe: the toast shows that message. Source: task 10
//   Prompt ("A 409 shows its message in a toast").
// Restriction — Pre: as AC 6.5 (a)/(b). Call: same renders. Observe: "Remove
//   link" and "Link transfer" both carry cursor-pointer; the candidate
//   Select resolves through `getByLabelText` (its Label is tied by htmlFor).
//   Source: task 10 Restrictions line.
// Restriction — Pre: exit edit, dialog closed. Call: render(FillDialog,
//   {open:false, fill: editExitFill}). Observe: the query hook's third
//   argument is false. Source: task 10 Restrictions line ("no network call
//   on ... a closed dialog"); the entry/create halves of this restriction are
//   covered by AC 6.5 (d) above — neither case renders the section (or calls
//   the hook) at all.
//
// Regression guard, NOT red-first (RED-IMPOSSIBLE): FillDialog.tsx's existing
// `showLotPicker` condition (line 198) already reads
// `lotsData?.method === 'fifo'`, so a method of `acb` already fails that
// check at base, before this task's code exists. No prior test in this file
// set method to `acb` though, so this pins the branch the task note calls
// out: "The hidden picker on acb (AC 2.5) holds at base ... regression
// guard."
describe('FillDialog — hidden lot picker on acb (AC 2.5, regression guard)', () => {
  it('shows no lot picker when the effective method is acb, even with two available lots', () => {
    mockLots({ method: 'acb', jurisdiction: 'CA', lots: [LOT_A, LOT_B] });
    renderDialog({ defaultType: 'exit' });

    expect(screen.queryByRole('button', { name: 'FIFO' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pick lots' })).toBeNull();
  });
});

describe('FillDialog — transfer-link section, an existing link (AC 6.5a)', () => {
  it('shows the linked account and removes it through the delete mutation', async () => {
    mockTransferLink({ link: LINK, candidates: [] });
    renderDialog({ fill: editExitFill });

    expect(screen.getByText(new RegExp(LINK.entryAccountName))).toBeTruthy();
    const removeBtn = screen.getByRole('button', { name: 'Remove link' });
    expect(removeBtn.className).toContain('cursor-pointer');

    fireEvent.click(removeBtn);

    await waitFor(() => expect(removeLinkMutateAsync).toHaveBeenCalled());
  });
});

describe('FillDialog — transfer-link section, candidates (AC 6.5b)', () => {
  it('lists each candidate as "account · date · quantity @ price" and sends the chosen entryFillId', async () => {
    mockTransferLink({ link: null, candidates: [CANDIDATE_A, CANDIDATE_B] });
    renderDialog({ fill: editExitFill });

    expect(
      screen.getByText(
        `${CANDIDATE_A.accountName} · ${CANDIDATE_A.filledAt} · ${CANDIDATE_A.quantity} @ ${CANDIDATE_A.price}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `${CANDIDATE_B.accountName} · ${CANDIDATE_B.filledAt} · ${CANDIDATE_B.quantity} @ ${CANDIDATE_B.price}`,
      ),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Transfer candidate'), {
      target: { value: CANDIDATE_B.entryFillId },
    });
    const linkBtn = screen.getByRole('button', { name: 'Link transfer' });
    expect(linkBtn.className).toContain('cursor-pointer');
    fireEvent.click(linkBtn);

    await waitFor(() => expect(linkMutateAsync).toHaveBeenCalledWith(CANDIDATE_B.entryFillId));
  });
});

describe('FillDialog — transfer-link section, nothing to show (AC 6.5c)', () => {
  it('shows no Link transfer button when there is no link and no candidates', () => {
    mockTransferLink({ link: null, candidates: [] });
    renderDialog({ fill: editExitFill });

    expect(screen.queryByRole('button', { name: 'Link transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull();
  });
});

describe('FillDialog — transfer-link section hidden on an entry edit or a create (AC 6.5d)', () => {
  it('shows no section on an entry edit', () => {
    mockTransferLink({ link: null, candidates: [CANDIDATE_A] });
    renderDialog({ fill: editEntryFill });

    expect(screen.queryByRole('button', { name: 'Link transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull();
  });

  it('shows no section on a create', () => {
    mockTransferLink({ link: null, candidates: [CANDIDATE_A] });
    renderDialog({ defaultType: 'exit' });

    expect(screen.queryByRole('button', { name: 'Link transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull();
  });
});

describe('FillDialog — transfer-link 409 surfaces its reason (AC 6.5e)', () => {
  it('shows the mutation error message in a toast', async () => {
    mockTransferLink({ link: null, candidates: [CANDIDATE_A] });
    linkMutateAsync.mockRejectedValueOnce({
      error: { message: 'same_account: entry already linked' },
    });
    renderDialog({ fill: editExitFill });

    fireEvent.click(screen.getByRole('button', { name: 'Link transfer' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('same_account: entry already linked'),
    );
  });
});

describe('FillDialog — no transfer-link network call on a closed dialog (restriction)', () => {
  it('passes enabled:false to the transfer-link query while the dialog is closed', () => {
    mockTransferLink({ link: null, candidates: [] });
    renderDialog({ open: false, fill: editExitFill });

    const lastCall = vi.mocked(useTransferLink).mock.calls.at(-1);
    expect(lastCall?.[2]).toBe(false);
  });
});
