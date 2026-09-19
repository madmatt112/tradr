// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LedgerEntry, LedgerEntryListResponse } from '@tradr/shared/schemas/accounting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Render router links as plain anchors — a position row needs no live router
// context for these assertions.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

// The query hook is driven per-test through this mutable holder.
let ledgerData: LedgerEntryListResponse | undefined;
vi.mock('@/features/accounting/hooks/useLedger', () => ({
  useLedgerQuery: () => ({ data: ledgerData, isLoading: false }),
}));

// The reverse mutation (task 7). We only need its `.mutate` to observe the
// confirm path; the real hook pulls in `api` and `sonner`, which this replaces.
const reverseMutate = vi.fn();
vi.mock('@/features/accounting/hooks/useCashMovements', () => ({
  useReverseCashMovement: () => ({ mutate: reverseMutate }),
}));

// Stub the AlertDialog primitive so jsdom doesn't fight Radix's focus-trap and
// so the confirm button is a plain <button> we can click (same approach as the
// sibling dialog tests).
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="alert-dialog-title">{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-description">{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" data-testid="alert-dialog-action" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { LedgerView } from './LedgerView';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mountWith(ui: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function unmount(container: HTMLElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function makeEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'entry-1',
    accountId: 'acct-1',
    positionId: null,
    entryType: 'deposit',
    direction: 'credit',
    amount: '100.0000',
    currency: 'USD',
    symbol: null,
    occurredAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    groupId: 'group-1',
    ...over,
  };
}

function makeResponse(
  entries: LedgerEntry[],
  runningBalanceAtFirstRow = '0.0000',
): LedgerEntryListResponse {
  return {
    entries,
    runningBalanceAtFirstRow,
    page: 1,
    pageSize: 50,
    hasMore: false,
  };
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

function rowText(row: HTMLTableRowElement): string {
  return row.textContent ?? '';
}

function deleteButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-testid="ledger-delete-cash-movement"]'),
  );
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  ledgerData = undefined;
  reverseMutate.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Cash-movement row labels (Req 7.1, 7.4)
// ---------------------------------------------------------------------------

describe('LedgerView — cash-movement labels', () => {
  it('renders Deposit / Withdrawal badges for the four cash row kinds', () => {
    ledgerData = makeResponse([
      makeEntry({ id: 'd', entryType: 'deposit', direction: 'credit' }),
      makeEntry({ id: 'w', entryType: 'withdrawal', direction: 'debit' }),
      makeEntry({ id: 'dr', entryType: 'deposit_reversal', direction: 'debit' }),
      makeEntry({ id: 'wr', entryType: 'withdrawal_reversal', direction: 'credit' }),
    ]);

    const { container, root } = mountWith(<LedgerView accountId="acct-1" currency="USD" />);
    const rows = bodyRows(container);

    expect(rowText(rows[0])).toContain('Deposit');
    expect(rowText(rows[1])).toContain('Withdrawal');
    expect(rowText(rows[2])).toContain('Deposit');
    expect(rowText(rows[3])).toContain('Withdrawal');

    unmount(container, root);
  });

  it('marks the two reversal rows with a (reversal) badge, and no row reads (deleted)', () => {
    ledgerData = makeResponse([
      makeEntry({ id: 'd', entryType: 'deposit', direction: 'credit' }),
      makeEntry({ id: 'w', entryType: 'withdrawal', direction: 'debit' }),
      makeEntry({ id: 'dr', entryType: 'deposit_reversal', direction: 'debit' }),
      makeEntry({ id: 'wr', entryType: 'withdrawal_reversal', direction: 'credit' }),
    ]);

    const { container, root } = mountWith(<LedgerView accountId="acct-1" currency="USD" />);
    const rows = bodyRows(container);

    expect(rowText(rows[0])).not.toContain('(reversal)');
    expect(rowText(rows[1])).not.toContain('(reversal)');
    expect(rowText(rows[2])).toContain('(reversal)');
    expect(rowText(rows[3])).toContain('(reversal)');

    // A cash row has a null positionId and symbol; without the cash-label branch
    // it would fall through to the "(deleted)" orphan label (Req 7.4).
    expect(container.textContent ?? '').not.toContain('(deleted)');

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Delete affordance (Req 7.2)
// ---------------------------------------------------------------------------

describe('LedgerView — delete affordance', () => {
  it('shows a delete button only on deposit and withdrawal rows', () => {
    ledgerData = makeResponse([
      makeEntry({ id: 'd', entryType: 'deposit', direction: 'credit' }),
      makeEntry({ id: 'w', entryType: 'withdrawal', direction: 'debit' }),
      makeEntry({ id: 'dr', entryType: 'deposit_reversal', direction: 'debit' }),
      makeEntry({ id: 'wr', entryType: 'withdrawal_reversal', direction: 'credit' }),
      makeEntry({ id: 'adj', entryType: 'balance_adjustment', direction: 'credit' }),
      makeEntry({
        id: 'pnl',
        entryType: 'position_pnl',
        direction: 'credit',
        positionId: 'pos-1',
        symbol: 'AAPL',
      }),
    ]);

    const { container, root } = mountWith(<LedgerView accountId="acct-1" currency="USD" />);

    const buttons = deleteButtons(container);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-label')).toBe('Delete deposit');
    expect(buttons[1].getAttribute('aria-label')).toBe('Delete withdrawal');

    unmount(container, root);
  });

  it('confirming the dialog reverses the movement by entry id', () => {
    ledgerData = makeResponse([
      makeEntry({ id: 'deposit-42', entryType: 'deposit', direction: 'credit' }),
    ]);

    const { container, root } = mountWith(<LedgerView accountId="acct-1" currency="USD" />);

    // No dialog until the delete button is clicked.
    expect(container.querySelector('[data-testid="alert-dialog"]')).toBeNull();

    click(deleteButtons(container)[0]);

    const title = container.querySelector('[data-testid="alert-dialog-title"]');
    expect(title?.textContent).toContain('Delete Deposit?');

    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="alert-dialog-action"]',
    );
    expect(action).not.toBeNull();
    click(action!);

    expect(reverseMutate).toHaveBeenCalledTimes(1);
    expect(reverseMutate).toHaveBeenCalledWith('deposit-42');

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Running balances tie out (computeRunningBalances is untouched)
// ---------------------------------------------------------------------------

describe('LedgerView — running balances', () => {
  it('threads the anchor forward across a three-row page', () => {
    // Newest-first. anchor is the balance BEFORE the newest row applied.
    //   B[0] = 1000 + (+100)      = 1100
    //   B[1] = B[0] − delta[0]    = 1100 − 100 = 1000
    //   B[2] = B[1] − delta[1]    = 1000 − (−50) = 1050
    ledgerData = makeResponse(
      [
        makeEntry({ id: 'a', entryType: 'deposit', direction: 'credit', amount: '100.0000' }),
        makeEntry({ id: 'b', entryType: 'withdrawal', direction: 'debit', amount: '50.0000' }),
        makeEntry({ id: 'c', entryType: 'deposit', direction: 'credit', amount: '200.0000' }),
      ],
      '1000.0000',
    );

    const { container, root } = mountWith(<LedgerView accountId="acct-1" currency="USD" />);
    const rows = bodyRows(container);

    const balanceCell = (row: HTMLTableRowElement) =>
      row.querySelectorAll('td')[4]?.textContent ?? '';

    expect(balanceCell(rows[0])).toContain('1,100.00');
    expect(balanceCell(rows[1])).toContain('1,000.00');
    expect(balanceCell(rows[2])).toContain('1,050.00');

    unmount(container, root);
  });
});
