// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionListItem } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';
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

// __root.tsx provides TooltipProvider app-wide; supply one for isolated renders.
function renderActions(overrides: Partial<PositionListItem> = {}) {
  return render(
    <TooltipProvider>
      <PositionRowActions position={makePosition(overrides)} />
    </TooltipProvider>,
  );
}

function action(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

describe('PositionRowActions — actions are inline buttons, not a menu', () => {
  it('exposes each action as its own button with an accessible name', () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 40 });
    expect(action('Add to position')).toBeTruthy();
    expect(action('Reduce position')).toBeTruthy();
    expect(action('Delete')).toBeTruthy();
    // No dropdown trigger stands between the user and the actions.
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  // A balancing exit auto-closes server-side (R7 amendment), so "−" then All is
  // the close; a dedicated button could never be reached in an enabled state.
  it('offers no Close action in any status', () => {
    for (const overrides of [
      { status: 'draft' as const },
      { status: 'open' as const, totalEntryQuantity: 100, totalExitQuantity: 100 },
      { status: 'open' as const, totalEntryQuantity: 100, totalExitQuantity: 40 },
      { status: 'closed' as const },
    ]) {
      renderActions(overrides);
      expect(screen.queryByRole('button', { name: 'Close position' })).toBeNull();
      cleanup();
    }
  });

  // A draft is a plan with no units, so there is nothing to add to or reduce.
  it('offers Add to position only on an open position', () => {
    renderActions({ status: 'open' });
    expect(action('Add to position')).toBeTruthy();
    cleanup();

    renderActions({ status: 'draft' });
    expect(screen.queryByRole('button', { name: 'Add to position' })).toBeNull();
    cleanup();

    renderActions({ status: 'closed', closedAt: `${TODAY_UTC}T13:00:00.000Z` });
    expect(screen.queryByRole('button', { name: 'Add to position' })).toBeNull();
  });

  it('leaves a draft row with only Open position and Delete', () => {
    renderActions({ status: 'draft', totalEntryQuantity: 0, totalExitQuantity: 0 });
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter(Boolean);
    expect(labels).toEqual(['Open position', 'Delete']);
  });

  // Exit fills 409 on a draft (R5-AC3), so the "−" button is open-only.
  it('offers Reduce position only on an open position', () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 0 });
    expect(action('Reduce position').disabled).toBe(false);
    cleanup();

    renderActions({ status: 'draft', totalEntryQuantity: 100 });
    expect(screen.queryByRole('button', { name: 'Reduce position' })).toBeNull();
    cleanup();

    renderActions({ status: 'closed', closedAt: `${TODAY_UTC}T13:00:00.000Z` });
    expect(screen.queryByRole('button', { name: 'Reduce position' })).toBeNull();
  });

  it('disables Reduce position when nothing is left open to reduce', () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 100 });
    expect(action('Reduce position').disabled).toBe(true);
  });
});

// R11-AC4: Open is shown-and-disabled on a draft, never hidden.
describe('PositionRowActions — lifecycle gating', () => {
  // Play is never disabled on a draft — with no entry fill it collects one
  // first, so a freshly created draft is never stranded in the list.
  it('enables Open position on a draft that has an entry fill', () => {
    renderActions({ status: 'draft', totalEntryQuantity: 100, totalExitQuantity: 0 });
    expect(action('Open position').disabled).toBe(false);
  });

  it('enables Open position on a draft with no fills yet', () => {
    renderActions({ status: 'draft', totalEntryQuantity: 0, totalExitQuantity: 0 });
    expect(action('Open position').disabled).toBe(false);
  });

  it('does not offer Open position on a non-draft position', () => {
    renderActions({ status: 'open' });
    expect(screen.queryByRole('button', { name: 'Open position' })).toBeNull();
  });

  it('offers Reopen for a closed position opened today in the account timezone', () => {
    renderActions({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: `${TODAY_UTC}T09:00:00.000Z`,
    });
    expect(action('Reopen')).toBeTruthy();
  });

  it('hides Reopen for a closed position opened on a previous day', () => {
    renderActions({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });
});

describe('PositionRowActions — actions fire the right mutation', () => {
  it('Open position calls the open mutation when an entry fill already exists', () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 100 });
    fireEvent.click(action('Open position'));

    expect(mutate).toHaveBeenCalledWith({});
    expect(screen.queryByTestId('fill-dialog')).toBeNull();
  });

  // The server rejects an open with no entry fill, so play collects one first
  // rather than sitting disabled.
  it('Open position on an empty draft collects the entry instead of mutating', () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 0 });
    fireEvent.click(action('Open position'));

    expect(screen.getByTestId('fill-dialog')).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('opens the position once that entry fill saves', () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 0 });
    fireEvent.click(action('Open position'));
    fireEvent.click(screen.getByTestId('fill-dialog-added'));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('does not open the position if the entry dialog is cancelled', () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 0 });
    fireEvent.click(action('Open position'));
    fireEvent.click(screen.getByTestId('fill-dialog-cancel'));

    expect(mutate).not.toHaveBeenCalled();
  });

  // "+" on an open position must not chain an open — that intent belongs to
  // play alone, and an open position has nothing to transition to.
  it('does not open the position when a fill is added via "+"', () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'open', totalEntryQuantity: 100 });
    fireEvent.click(action('Add to position'));
    fireEvent.click(screen.getByTestId('fill-dialog-added'));

    expect(mutate).not.toHaveBeenCalled();
  });

  it('Reopen calls the reopen mutation', () => {
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
    fireEvent.click(action('Reopen'));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('Add to position opens the fill dialog rather than mutating', () => {
    renderActions({ status: 'open' });
    fireEvent.click(action('Add to position'));

    expect(screen.getByTestId('fill-dialog')).toBeTruthy();
  });
});

describe('PositionRowActions — delete confirmation', () => {
  it('confirms before deleting, then calls the delete mutation', () => {
    const mutate = vi.fn();
    vi.mocked(useDeletePosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useDeletePosition>);

    renderActions({ status: 'open' });
    fireEvent.click(action('Delete'));

    // The icon click alone must not delete — the dialog stands between.
    expect(mutate).not.toHaveBeenCalled();

    // Scope to the dialog: the row's own trash icon is also named "Delete".
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('carries the closed-position tax warning', () => {
    renderActions({
      status: 'closed',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    fireEvent.click(action('Delete'));

    expect(screen.getByText(/removes its realized P&L from the account balance/i)).toBeTruthy();
    expect(screen.getByText(/including prior tax years/i)).toBeTruthy();
    expect(screen.getByText(/wash-sale classification/i)).toBeTruthy();
  });

  // R4 amendment: the confirmation dialog SHALL name the position.
  it('names the position in both the closed and non-closed copy', () => {
    renderActions({ status: 'open', symbol: 'MSFT' });
    fireEvent.click(action('Delete'));
    expect(screen.getByText(/"MSFT"/)).toBeTruthy();
    cleanup();

    renderActions({
      status: 'closed',
      symbol: 'NVDA260321C120',
      accountTimezone: 'UTC',
      openedAt: '2020-01-01T09:00:00.000Z',
    });
    fireEvent.click(action('Delete'));
    expect(screen.getByText(/"NVDA260321C120"/)).toBeTruthy();
  });

  it('keeps the lighter copy on a non-closed position', () => {
    renderActions({ status: 'open' });
    fireEvent.click(action('Delete'));

    expect(screen.getByText(/Are you sure you want to delete "AAPL"\?/i)).toBeTruthy();
    expect(screen.queryByText(/wash-sale classification/i)).toBeNull();
  });
});
