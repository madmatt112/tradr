// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeleteAccountSection } from './DeleteAccountSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The status query and the cancel mutation are the section's inputs; both are
// mocked so each state renders deterministically without a QueryClient or fetch.
/* eslint-disable @typescript-eslint/no-explicit-any */
let statusState: any;
let cancelState: any;
const cancelMutate = vi.fn();
const refetch = vi.fn();

vi.mock('../hooks/useAccountDeletion', () => ({
  useDeletionStatus: () => statusState,
  useCancelDeletion: () => cancelState,
}));

// Stubbed so the section test never mounts the real dialog (and its billing
// reads); the open/close wiring is all we assert here.
vi.mock('./DeleteAccountDialog', () => ({
  DeleteAccountDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="delete-account-dialog">
      <button onClick={onClose}>close-dialog</button>
    </div>
  ),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  statusState = {
    isLoading: false,
    isError: false,
    data: { scheduledFor: null, state: null },
    refetch,
  };
  cancelState = { mutate: cancelMutate, isPending: false, isError: false };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DeleteAccountSection', () => {
  it('loading: shows a skeleton and no delete control', () => {
    statusState = { isLoading: true, isError: false, data: undefined, refetch };
    render(<DeleteAccountSection />);

    expect(screen.queryByRole('button', { name: 'Delete account' })).toBeNull();
    expect(screen.queryByTestId('deletion-scheduled')).toBeNull();
  });

  it('status error: shows an inline error and a retry that refetches', () => {
    statusState = { isLoading: false, isError: true, data: undefined, refetch };
    render(<DeleteAccountSection />);

    expect(screen.getByText(/Could not load your account-deletion status/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('scheduled: shows the locale date and a neutral cancel control that fires the mutation', () => {
    statusState = {
      isLoading: false,
      isError: false,
      data: { scheduledFor: '2026-10-01T00:00:00.000Z', state: 'scheduled' },
      refetch,
    };
    render(<DeleteAccountSection />);

    const line = screen.getByTestId('deletion-scheduled');
    expect(line.textContent).toContain('Deletion scheduled for');
    expect(line.textContent).toContain(new Date('2026-10-01T00:00:00.000Z').toLocaleDateString());

    const cancelBtn = screen.getByRole('button', { name: 'Cancel deletion' });
    // Neutral, not destructive (Req 8.4 cancel is a reversal, not a delete).
    expect(cancelBtn.getAttribute('data-variant')).not.toBe('destructive');
    fireEvent.click(cancelBtn);
    expect(cancelMutate).toHaveBeenCalledOnce();
  });

  it('scheduled + failed cancel: keeps the state, shows the error, keeps the button as the retry', () => {
    statusState = {
      isLoading: false,
      isError: false,
      data: { scheduledFor: '2026-10-01T00:00:00.000Z', state: 'scheduled' },
      refetch,
    };
    cancelState = { mutate: cancelMutate, isPending: false, isError: true };
    render(<DeleteAccountSection />);

    expect(screen.getByText(/Could not cancel the deletion/)).toBeTruthy();
    expect(screen.getByTestId('deletion-scheduled')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
  });

  it.each(['pending', 'cancelling', 'firing'])(
    'in-progress state %s: neutral line, no control',
    (state) => {
      statusState = {
        isLoading: false,
        isError: false,
        data: { scheduledFor: null, state },
        refetch,
      };
      render(<DeleteAccountSection />);

      expect(screen.getByTestId('deletion-in-progress').textContent).toContain(
        'Deletion in progress',
      );
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it('no schedule: shows the destructive delete button and opens the dialog', () => {
    render(<DeleteAccountSection />);

    const deleteBtn = screen.getByRole('button', { name: 'Delete account' });
    expect(deleteBtn.getAttribute('data-variant')).toBe('destructive');
    expect(screen.queryByTestId('delete-account-dialog')).toBeNull();

    fireEvent.click(deleteBtn);
    expect(screen.getByTestId('delete-account-dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'close-dialog' }));
    expect(screen.queryByTestId('delete-account-dialog')).toBeNull();
  });
});
