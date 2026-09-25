// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeleteAccountDialog } from './DeleteAccountDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The delete mutation and the two billing reads are mocked so the dialog renders
// without a QueryClient or fetch; the code map is the thing under test.
/* eslint-disable @typescript-eslint/no-explicit-any */
let deleteState: any;
let walletData: any;
let tierData: any;
const deleteMutate = vi.fn();

vi.mock('../hooks/useAccountDeletion', () => ({
  useDeleteAccount: () => deleteState,
}));
vi.mock('@/features/billing/useWalletBalance', () => ({
  billingKeys: { tier: () => ['billing', 'tier'] },
  useWalletBalance: () => ({ data: walletData }),
}));
vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData }),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  deleteState = { mutate: deleteMutate, isPending: false, isError: false, error: null };
  walletData = { balance: '2500000', available: '2500000' };
  tierData = { subscription: null };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function passwordInput() {
  return screen.getByLabelText('Confirm your password') as HTMLInputElement;
}

describe('DeleteAccountDialog', () => {
  it('confirm is disabled until the password field is non-empty', () => {
    render(<DeleteAccountDialog onClose={vi.fn()} />);

    const confirm = screen.getByRole('button', { name: 'Delete my account' });
    expect(confirm.getAttribute('data-variant')).toBe('destructive');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    const input = passwordInput();
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    fireEvent.change(input, { target: { value: 'hunter2!' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the unused credit balance from the wallet read', () => {
    render(<DeleteAccountDialog onClose={vi.fn()} />);
    expect(screen.getByTestId('retention-credits').textContent).toContain('2,500,000');
  });

  it('timing line: immediate when there is no live future subscription', () => {
    render(<DeleteAccountDialog onClose={vi.fn()} />);
    expect(screen.getByText(/will be deleted immediately/)).toBeTruthy();
  });

  it('timing line: a future paid period defers the delete to that date', () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    tierData = {
      subscription: {
        status: 'active',
        currentPeriodEnd: future,
        cancelAtPeriodEnd: false,
        pastDue: false,
        priceUnitAmount: null,
        priceCurrency: null,
        manageable: true,
      },
    };
    render(<DeleteAccountDialog onClose={vi.fn()} />);
    expect(
      screen.getByText(new RegExp(`will be deleted on ${new Date(future).toLocaleDateString()}`)),
    ).toBeTruthy();
  });

  it('pending: confirm disabled and labelled while the mutation runs', () => {
    deleteState = { mutate: deleteMutate, isPending: true, isError: false, error: null };
    render(<DeleteAccountDialog onClose={vi.fn()} />);

    const confirm = screen.getByRole('button', { name: 'Deleting…' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  const codeCases: Array<[string, RegExp]> = [
    ['VALIDATION_ERROR', /password is not valid/],
    ['INVALID_PASSWORD', /password is incorrect/],
    ['LAST_ADMIN', /last admin/],
    ['SUBSCRIPTION_UNRESOLVED', /subscription cannot be resolved/],
    ['RATE_LIMITED', /Too many attempts/],
    ['STRIPE_CANCEL_FAILED', /subscription could not be updated/],
    ['DELETION_IN_PROGRESS', /already in progress/],
  ];

  it.each(codeCases)('maps error code %s to its own message and stays open', (code, pattern) => {
    deleteState = {
      mutate: deleteMutate,
      isPending: false,
      isError: true,
      error: { error: { code }, status: 409 },
    };
    render(<DeleteAccountDialog onClose={vi.fn()} />);

    expect(screen.getByTestId('delete-account-error').textContent).toMatch(pattern);
    // Stays open: the dialog and its confirm are still on screen.
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeTruthy();
  });

  it('falls back to a neutral message for an unmapped code (a bare 500)', () => {
    deleteState = {
      mutate: deleteMutate,
      isPending: false,
      isError: true,
      error: { message: 'Request failed', status: 500 },
    };
    render(<DeleteAccountDialog onClose={vi.fn()} />);
    expect(screen.getByTestId('delete-account-error').textContent).toMatch(/Something went wrong/);
  });

  it('a scheduled outcome closes the dialog; the mutation carries the password', () => {
    deleteMutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({ outcome: 'scheduled', scheduledFor: '2026-10-01T00:00:00.000Z' }),
    );
    const onClose = vi.fn();
    render(<DeleteAccountDialog onClose={onClose} />);

    fireEvent.change(passwordInput(), { target: { value: 'hunter2!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(deleteMutate).toHaveBeenCalledWith({ password: 'hunter2!' }, expect.any(Object));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a deleted outcome does not close the dialog (navigation unmounts it instead)', () => {
    deleteMutate.mockImplementation((_vars, opts) => opts.onSuccess({ outcome: 'deleted' }));
    const onClose = vi.fn();
    render(<DeleteAccountDialog onClose={onClose} />);

    fireEvent.change(passwordInput(), { target: { value: 'hunter2!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(onClose).not.toHaveBeenCalled();
  });
});
