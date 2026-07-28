// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionListItem } from '@tradr/shared';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import {
  useDeletePosition,
  useOpenPosition,
  useClosePosition,
  useReopenPosition,
} from '../hooks/usePosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

vi.mock('../hooks/usePosition', () => ({
  useDeletePosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useOpenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useClosePosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useReopenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('./FillDialog', () => ({
  FillDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="fill-dialog" /> : null),
}));

import { PositionRowActions } from './PositionRowActions';

// The same-day reopen guard compares openedAt's calendar date to *today* in the
// account timezone; anchor "today" to the real UTC date against a 'UTC' account.
const TODAY_UTC = new Date().toISOString().slice(0, 10);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openMenu(overrides: Partial<PositionListItem> = {}) {
  const user = userEvent.setup();
  render(<PositionRowActions position={makePosition(overrides)} />);
  await user.click(screen.getByRole('button', { name: /Actions for/ }));
  return user;
}

describe('PositionRowActions — lifecycle gating', () => {
  it('always offers View details and Delete', async () => {
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'View details' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('offers Add fill on a draft and an open position, but not a closed one', async () => {
    await openMenu({ status: 'draft' });
    expect(screen.getByRole('menuitem', { name: 'Add fill' })).toBeTruthy();
    cleanup();

    await openMenu({ status: 'open' });
    expect(screen.getByRole('menuitem', { name: 'Add fill' })).toBeTruthy();
    cleanup();

    await openMenu({ status: 'closed', closedAt: `${TODAY_UTC}T13:00:00.000Z` });
    expect(screen.queryByRole('menuitem', { name: 'Add fill' })).toBeNull();
  });

  // R11-AC4/AC5: shown-and-disabled, never hidden, for their own status.
  it('enables Open position on a draft that has an entry fill', async () => {
    await openMenu({ status: 'draft', totalEntryQuantity: 100, totalExitQuantity: 0 });
    const item = screen.getByRole('menuitem', { name: 'Open position' });
    expect(item.getAttribute('data-disabled')).toBeNull();
  });

  it('shows Open position disabled on a draft with no fills yet', async () => {
    await openMenu({ status: 'draft', totalEntryQuantity: 0, totalExitQuantity: 0 });
    const item = screen.getByRole('menuitem', { name: 'Open position' });
    expect(item.getAttribute('data-disabled')).not.toBeNull();
  });

  it('does not offer Open position on a non-draft position', async () => {
    await openMenu({ status: 'open' });
    expect(screen.queryByRole('menuitem', { name: 'Open position' })).toBeNull();
  });

  it('enables Close position once the position is fully exited', async () => {
    await openMenu({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 100 });
    const item = screen.getByRole('menuitem', { name: 'Close position' });
    expect(item.getAttribute('data-disabled')).toBeNull();
  });

  it('shows Close position disabled while the position is only partly exited', async () => {
    await openMenu({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 40 });
    const item = screen.getByRole('menuitem', { name: 'Close position' });
    expect(item.getAttribute('data-disabled')).not.toBeNull();
  });

  it('offers Reopen for a closed position opened today in the account timezone', async () => {
    await openMenu({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: `${TODAY_UTC}T09:00:00.000Z`,
    });
    expect(screen.getByRole('menuitem', { name: 'Reopen' })).toBeTruthy();
  });

  it('hides Reopen for a closed position opened on a previous day', async () => {
    await openMenu({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    expect(screen.queryByRole('menuitem', { name: 'Reopen' })).toBeNull();
  });
});

describe('PositionRowActions — actions fire the right mutation', () => {
  it('Open position calls the open mutation', async () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    const user = await openMenu({ status: 'draft', totalEntryQuantity: 100 });
    await user.click(screen.getByRole('menuitem', { name: 'Open position' }));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('Close position calls the close mutation', async () => {
    const mutate = vi.fn();
    vi.mocked(useClosePosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useClosePosition>);

    const user = await openMenu({
      status: 'open',
      totalEntryQuantity: 100,
      totalExitQuantity: 100,
    });
    await user.click(screen.getByRole('menuitem', { name: 'Close position' }));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('Reopen calls the reopen mutation', async () => {
    const mutate = vi.fn();
    vi.mocked(useReopenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useReopenPosition>);

    const user = await openMenu({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: `${TODAY_UTC}T09:00:00.000Z`,
    });
    await user.click(screen.getByRole('menuitem', { name: 'Reopen' }));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('Add fill opens the fill dialog rather than mutating', async () => {
    const user = await openMenu({ status: 'open' });
    await user.click(screen.getByRole('menuitem', { name: 'Add fill' }));

    expect(screen.getByTestId('fill-dialog')).toBeTruthy();
  });
});

describe('PositionRowActions — delete confirmation', () => {
  it('confirms before deleting, then calls the delete mutation', async () => {
    const mutate = vi.fn();
    vi.mocked(useDeletePosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useDeletePosition>);

    const user = await openMenu({ status: 'open' });
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    // Menu click alone must not delete — the dialog stands between.
    expect(mutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('carries the closed-position tax warning', async () => {
    await openMenu({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(screen.getByText(/removes its realized P&L from the account balance/i)).toBeTruthy();
    expect(screen.getByText(/including prior tax years/i)).toBeTruthy();
    expect(screen.getByText(/wash-sale classification/i)).toBeTruthy();
  });

  it('keeps the lighter copy on a non-closed position', async () => {
    const user = await openMenu({ status: 'open' });
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(screen.getByText(/Are you sure you want to delete "AAPL"\?/i)).toBeTruthy();
    expect(screen.queryByText(/wash-sale classification/i)).toBeNull();
  });

  // R4 amendment: the confirmation dialog SHALL name the position.
  it('names the position in both the closed and non-closed copy', async () => {
    const user = await openMenu({ status: 'open', symbol: 'MSFT' });
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByText(/"MSFT"/)).toBeTruthy();
    cleanup();

    const user2 = await openMenu({
      status: 'closed',
      symbol: 'NVDA260321C120',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    await user2.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByText(/"NVDA260321C120"/)).toBeTruthy();
  });
});
