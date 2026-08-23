// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionListItem } from '@tradr/shared';

import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import { useDeletePosition, useOpenPosition, useReopenPosition } from '../hooks/usePosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/usePosition', () => ({
  useDeletePosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useOpenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useReopenPosition: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

// Stub exposes the two outcomes the row chains off: a successful add (onAdded
// fires BEFORE the close, per its contract) and a cancel (close only).
vi.mock('./FillDialog', () => ({
  FillDialog: ({
    open,
    onAdded,
    onOpenChange,
  }: {
    open: boolean;
    onAdded?: () => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="fill-dialog">
        <button
          type="button"
          data-testid="fill-dialog-added"
          onClick={() => {
            onAdded?.();
            onOpenChange(false);
          }}
        />
        <button
          type="button"
          data-testid="fill-dialog-cancel"
          onClick={() => onOpenChange(false)}
        />
      </div>
    ) : null,
}));

import { PositionRowActions } from './PositionRowActions';

// The same-day reopen guard compares openedAt's calendar date to *today* in the
// account timezone; anchor "today" to the real UTC date against a 'UTC' account.
const TODAY_UTC = new Date().toISOString().slice(0, 10);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderActions(overrides: Partial<PositionListItem> = {}) {
  return render(<PositionRowActions position={makePosition(overrides)} />);
}

/** Open the row's ⋯ menu. The trigger's accessible name carries the symbol so
 * a screen reader can tell one row's menu from the next. */
async function openMenu(symbol = 'AAPL'): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${symbol}` }));
}

function menuItem(name: string | RegExp): HTMLElement {
  return screen.getByRole('menuitem', { name });
}

function queryMenuItem(name: string | RegExp): HTMLElement | null {
  return screen.queryByRole('menuitem', { name });
}

// The redesign folds the old icon strip into one ⋯ menu (visual-redesign
// task 7): the desk table spends its width on data, and destructive Delete
// sits a deliberate click deep rather than permanently exposed at 31px rows.
describe('PositionRowActions — one row menu', () => {
  it('exposes the actions as menu items behind a per-row trigger', async () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 40 });
    // Collapsed: only the trigger renders — no always-on action buttons.
    expect(screen.queryByRole('menuitem')).toBeNull();
    await openMenu();
    expect(menuItem('Add to position')).toBeTruthy();
    expect(menuItem('Reduce position')).toBeTruthy();
    expect(menuItem('Delete')).toBeTruthy();
  });

  // A balancing exit auto-closes server-side (R7 amendment), so "Reduce" then
  // All is the close; a dedicated item could never be reached enabled.
  it('offers no Close action in any status', async () => {
    for (const overrides of [
      { status: 'draft' as const },
      { status: 'open' as const, totalEntryQuantity: 100, totalExitQuantity: 100 },
      { status: 'open' as const, totalEntryQuantity: 100, totalExitQuantity: 40 },
      { status: 'closed' as const },
    ]) {
      renderActions(overrides);
      await openMenu();
      expect(queryMenuItem('Close position')).toBeNull();
      cleanup();
    }
  });

  // A draft is a plan with no units, so there is nothing to add to or reduce.
  it('offers Add to position only on an open position', async () => {
    renderActions({ status: 'open' });
    await openMenu();
    expect(menuItem('Add to position')).toBeTruthy();
    cleanup();

    renderActions({ status: 'draft' });
    await openMenu();
    expect(queryMenuItem('Add to position')).toBeNull();
    cleanup();

    renderActions({ status: 'closed', closedAt: `${TODAY_UTC}T13:00:00.000Z` });
    await openMenu();
    expect(queryMenuItem('Add to position')).toBeNull();
  });

  it('leaves a draft row with only Open position and Delete', async () => {
    renderActions({ status: 'draft', totalEntryQuantity: 0, totalExitQuantity: 0 });
    await openMenu();
    const labels = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(labels).toEqual(['Open position', 'Delete']);
  });

  // Exit fills 409 on a draft (R5-AC3), so Reduce is open-only.
  it('offers Reduce position only on an open position', async () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 0 });
    await openMenu();
    expect(menuItem('Reduce position').getAttribute('aria-disabled')).toBeNull();
    cleanup();

    renderActions({ status: 'draft', totalEntryQuantity: 100 });
    await openMenu();
    expect(queryMenuItem(/Reduce position/)).toBeNull();
    cleanup();

    renderActions({ status: 'closed', closedAt: `${TODAY_UTC}T13:00:00.000Z` });
    await openMenu();
    expect(queryMenuItem(/Reduce position/)).toBeNull();
  });

  it('disables Reduce position when nothing is left open to reduce, and says why', async () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 100 });
    await openMenu();
    const item = menuItem(/Reduce position/);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    // The strip's tooltip explanation moved inline into the item label.
    expect(item.textContent).toContain('nothing open');
  });
});

// R11-AC4: Open is offered on a draft, never hidden.
describe('PositionRowActions — lifecycle gating', () => {
  // Open is never disabled on a draft — with no entry fill it collects one
  // first, so a freshly created draft is never stranded in the list.
  it('enables Open position on a draft that has an entry fill', async () => {
    renderActions({ status: 'draft', totalEntryQuantity: 100, totalExitQuantity: 0 });
    await openMenu();
    expect(menuItem('Open position').getAttribute('aria-disabled')).toBeNull();
  });

  it('enables Open position on a draft with no fills yet', async () => {
    renderActions({ status: 'draft', totalEntryQuantity: 0, totalExitQuantity: 0 });
    await openMenu();
    expect(menuItem('Open position').getAttribute('aria-disabled')).toBeNull();
  });

  it('does not offer Open position on a non-draft position', async () => {
    renderActions({ status: 'open' });
    await openMenu();
    expect(queryMenuItem('Open position')).toBeNull();
  });

  it('offers Reopen for a closed position opened today in the account timezone', async () => {
    renderActions({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: `${TODAY_UTC}T09:00:00.000Z`,
    });
    await openMenu();
    expect(menuItem('Reopen')).toBeTruthy();
  });

  it('hides Reopen for a closed position opened on a previous day', async () => {
    renderActions({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    await openMenu();
    expect(queryMenuItem('Reopen')).toBeNull();
  });
});

describe('PositionRowActions — actions fire the right mutation', () => {
  it('Open position calls the open mutation when an entry fill already exists', async () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 100 });
    await openMenu();
    await userEvent.click(menuItem('Open position'));

    expect(mutate).toHaveBeenCalledWith({});
    expect(screen.queryByTestId('fill-dialog')).toBeNull();
  });

  // The server rejects an open with no entry fill, so Open collects one first
  // rather than sitting disabled.
  it('Open position on an empty draft collects the entry instead of mutating', async () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 0 });
    await openMenu();
    await userEvent.click(menuItem('Open position'));

    expect(screen.getByTestId('fill-dialog')).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('opens the position once that entry fill saves', async () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 0 });
    await openMenu();
    await userEvent.click(menuItem('Open position'));
    fireEvent.click(screen.getByTestId('fill-dialog-added'));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('does not open the position if the entry dialog is cancelled', async () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 0 });
    await openMenu();
    await userEvent.click(menuItem('Open position'));
    fireEvent.click(screen.getByTestId('fill-dialog-cancel'));

    expect(mutate).not.toHaveBeenCalled();
  });

  // "Add to position" must not chain an open — that intent belongs to Open
  // alone, and an open position has nothing to transition to.
  it('does not open the position when a fill is added via Add to position', async () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'open', totalEntryQuantity: 100 });
    await openMenu();
    await userEvent.click(menuItem('Add to position'));
    fireEvent.click(screen.getByTestId('fill-dialog-added'));

    expect(mutate).not.toHaveBeenCalled();
  });

  it('Reopen calls the reopen mutation', async () => {
    const mutate = vi.fn();
    vi.mocked(useReopenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useReopenPosition>);

    renderActions({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: `${TODAY_UTC}T09:00:00.000Z`,
    });
    await openMenu();
    await userEvent.click(menuItem('Reopen'));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('Add to position opens the fill dialog rather than mutating', async () => {
    renderActions({ status: 'open' });
    await openMenu();
    await userEvent.click(menuItem('Add to position'));

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

    renderActions({ status: 'open' });
    await openMenu();
    await userEvent.click(menuItem('Delete'));

    // The menu selection alone must not delete — the dialog stands between.
    expect(mutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('carries the closed-position tax warning', async () => {
    renderActions({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    await openMenu();
    await userEvent.click(menuItem('Delete'));

    expect(screen.getByText(/removes its realized P&L from the account balance/i)).toBeTruthy();
    expect(screen.getByText(/including prior tax years/i)).toBeTruthy();
    expect(screen.getByText(/wash-sale classification/i)).toBeTruthy();
  });

  // R4 amendment: the confirmation dialog SHALL name the position.
  it('names the position in both the closed and non-closed copy', async () => {
    renderActions({ status: 'open', symbol: 'MSFT' });
    await openMenu('MSFT');
    await userEvent.click(menuItem('Delete'));
    expect(screen.getByText(/"MSFT"/)).toBeTruthy();
    cleanup();

    renderActions({
      status: 'closed',
      symbol: 'NVDA260321C120',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    await openMenu('NVDA260321C120');
    await userEvent.click(menuItem('Delete'));
    expect(screen.getByText(/"NVDA260321C120"/)).toBeTruthy();
  });

  it('keeps the lighter copy on a non-closed position', async () => {
    renderActions({ status: 'open' });
    await openMenu();
    await userEvent.click(menuItem('Delete'));

    expect(screen.getByText(/Are you sure you want to delete "AAPL"\?/i)).toBeTruthy();
    expect(screen.queryByText(/wash-sale classification/i)).toBeNull();
  });
});
