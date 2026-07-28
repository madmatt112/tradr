// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PositionListItem } from '@tradr/shared';

import { TooltipProvider } from '@/components/ui/tooltip';
import { makePosition } from '@/features/positions/__fixtures__/position-fixtures';

import {
  useDeletePosition,
  useOpenPosition,
  useClosePosition,
  useReopenPosition,
} from '../hooks/usePosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 100 });
    expect(action('Add fill')).toBeTruthy();
    expect(action('Close position')).toBeTruthy();
    expect(action('Delete')).toBeTruthy();
    // No dropdown trigger stands between the user and the actions.
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('offers Add fill on draft and open, but not on closed', () => {
    renderActions({ status: 'draft' });
    expect(action('Add fill')).toBeTruthy();
    cleanup();

    renderActions({ status: 'open' });
    expect(action('Add fill')).toBeTruthy();
    cleanup();

    renderActions({ status: 'closed', closedAt: `${TODAY_UTC}T13:00:00.000Z` });
    expect(screen.queryByRole('button', { name: 'Add fill' })).toBeNull();
  });
});

// R11-AC4/AC5: shown-and-disabled for their own status, never hidden.
describe('PositionRowActions — lifecycle gating', () => {
  it('enables Open position on a draft that has an entry fill', () => {
    renderActions({ status: 'draft', totalEntryQuantity: 100, totalExitQuantity: 0 });
    expect(action('Open position').disabled).toBe(false);
  });

  it('shows Open position disabled on a draft with no fills yet', () => {
    renderActions({ status: 'draft', totalEntryQuantity: 0, totalExitQuantity: 0 });
    expect(action('Open position').disabled).toBe(true);
  });

  it('does not offer Open position on a non-draft position', () => {
    renderActions({ status: 'open' });
    expect(screen.queryByRole('button', { name: 'Open position' })).toBeNull();
  });

  it('enables Close position once fully exited', () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 100 });
    expect(action('Close position').disabled).toBe(false);
  });

  it('shows Close position disabled while only partly exited', () => {
    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 40 });
    expect(action('Close position').disabled).toBe(true);
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
  it('Open position calls the open mutation', () => {
    const mutate = vi.fn();
    vi.mocked(useOpenPosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useOpenPosition>);

    renderActions({ status: 'draft', totalEntryQuantity: 100 });
    fireEvent.click(action('Open position'));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it('Close position calls the close mutation', () => {
    const mutate = vi.fn();
    vi.mocked(useClosePosition).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useClosePosition>);

    renderActions({ status: 'open', totalEntryQuantity: 100, totalExitQuantity: 100 });
    fireEvent.click(action('Close position'));

    expect(mutate).toHaveBeenCalledWith({});
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

  it('Add fill opens the fill dialog rather than mutating', () => {
    renderActions({ status: 'open' });
    fireEvent.click(action('Add fill'));

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
