// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeeSchedule } from '@tradr/shared';

import { useAccountFeeSchedule } from '../hooks/useAccountFeeSchedule';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const addFillMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('../hooks/usePosition', () => ({
  useAddFill: vi.fn(() => ({ mutateAsync: addFillMutate, isPending: false })),
  useUpdateFill: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('../hooks/useAccountFeeSchedule', () => ({
  useAccountFeeSchedule: vi.fn(() => null),
}));

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
  accountId: '00000000-0000-0000-0000-000000000010',
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
