// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the shadcn Dialog primitive so jsdom doesn't have to fight Radix's
// pointer-event / focus-trap machinery (same approach as
// RateChangeConfirmModal.test.tsx).
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-description">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const reconcileMutateAsync = vi.fn();
vi.mock('@/features/accounting/hooks/useReconcileBalance', () => ({
  useReconcileBalance: () => ({
    mutateAsync: reconcileMutateAsync,
    isPending: false,
  }),
}));

import { ReconcileBalanceDialog } from './ReconcileBalanceDialog';

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

function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: 'acct-1',
    userId: 'user-1',
    name: 'Test Account',
    currency: 'USD',
    timezone: 'America/New_York',
    brokerageId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    balance: '1000.0000',
    ...over,
  } as Account;
}

/** Type into the target-balance input the way React's controlled input expects. */
function typeTarget(container: HTMLElement, value: string): void {
  const input = container.querySelector<HTMLInputElement>('#targetBalance');
  if (!input) throw new Error('targetBalance input not found');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!btn) throw new Error('submit button not found');
  return btn;
}

function adjustmentText(container: HTMLElement): string {
  return container.querySelector('[data-testid="reconcile-adjustment"]')?.textContent ?? '';
}

beforeEach(() => {
  reconcileMutateAsync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Disclosure copy (Req 8.11) — the reason this dialog can skip an
// open-positions warning is that it says what the number covers.
// ---------------------------------------------------------------------------

describe('ReconcileBalanceDialog — disclosure copy', () => {
  it('states that the balance is starting balance plus realized P&L and excludes open positions', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    const copy = container.querySelector('[data-testid="dialog-description"]')?.textContent ?? '';
    expect(copy).toContain('cash balance');
    expect(copy).toContain('starting balance');
    expect(copy).toContain('realized P&L');
    expect(copy).toContain('does not include the market value of open positions');

    unmount(container, root);
  });

  it('renders nothing when closed', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open={false} onOpenChange={() => {}} />,
    );
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Live adjustment preview
// ---------------------------------------------------------------------------

describe('ReconcileBalanceDialog — adjustment preview', () => {
  it('shows a signed credit for a target above the current balance', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeTarget(container, '1250.50');
    const text = adjustmentText(container);
    expect(text).toContain('+');
    expect(text).toContain('250.50');
    expect(text).toContain('credit');
    expect(text).not.toContain('debit');

    unmount(container, root);
  });

  it('shows a signed debit for a target below the current balance', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeTarget(container, '900');
    const text = adjustmentText(container);
    expect(text).toContain('−');
    expect(text).toContain('100.00');
    expect(text).toContain('debit');

    unmount(container, root);
  });

  it('handles a negative target (margin balance) as a debit', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeTarget(container, '-250');
    const text = adjustmentText(container);
    expect(text).toContain('debit');
    expect(text).toContain('1,250.00');

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Zero-delta gate — the client mirror of the server's 409 (Req 8.5 / 8.11)
// ---------------------------------------------------------------------------

describe('ReconcileBalanceDialog — zero-delta gate', () => {
  it('disables submit and says so when the target equals the current balance', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeTarget(container, '1000');
    expect(adjustmentText(container)).toContain('already matches');
    expect(submitButton(container).disabled).toBe(true);

    unmount(container, root);
  });

  it('treats a differently-scaled but equal target as a no-op', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    // Current balance arrives as '1000.0000'; '1000.00' is the same number.
    typeTarget(container, '1000.00');
    expect(submitButton(container).disabled).toBe(true);

    unmount(container, root);
  });

  it('disables submit before anything is typed', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );
    expect(submitButton(container).disabled).toBe(true);
    unmount(container, root);
  });

  it('enables submit once a non-zero delta is entered', () => {
    const { container, root } = mountWith(
      <ReconcileBalanceDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeTarget(container, '1200');
    expect(submitButton(container).disabled).toBe(false);

    unmount(container, root);
  });
});
