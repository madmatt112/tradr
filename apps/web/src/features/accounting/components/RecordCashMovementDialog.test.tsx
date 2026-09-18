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
// ReconcileBalanceDialog.test.tsx).
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

// Mock the shadcn Select as a native <select>: the trigger/value render nothing
// and the items become <option>s under a real select whose change fires
// `onValueChange`, so the type can be driven from a test.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      data-testid="cash-movement-type"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
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
}));

const recordMutateAsync = vi.fn();
vi.mock('@/features/accounting/hooks/useCashMovements', () => ({
  useRecordCashMovement: () => ({
    mutateAsync: recordMutateAsync,
    isPending: false,
  }),
}));

import { RecordCashMovementDialog } from './RecordCashMovementDialog';

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

/** Type into a controlled text input the way React expects. */
function typeInput(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`${selector} not found`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function typeAmount(container: HTMLElement, value: string): void {
  typeInput(container, '#cashMovementAmount', value);
}

/** Change the (mocked native) type select. */
function selectType(container: HTMLElement, value: 'deposit' | 'withdrawal'): void {
  const select = container.querySelector<HTMLSelectElement>('[data-testid="cash-movement-type"]');
  if (!select) throw new Error('type select not found');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!btn) throw new Error('submit button not found');
  return btn;
}

function testidText(container: HTMLElement, testid: string): string {
  return container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';
}

async function submitForm(container: HTMLElement): Promise<void> {
  const formEl = container.querySelector('form');
  if (!formEl) throw new Error('form not found');
  await act(async () => {
    formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  // Flush the async resolver + mutation microtasks.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  recordMutateAsync.mockReset();
  recordMutateAsync.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Balance preview
// ---------------------------------------------------------------------------

describe('RecordCashMovementDialog — balance preview', () => {
  it('shows current and resulting balance for a deposit', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeAmount(container, '250.50');
    expect(testidText(container, 'cash-movement-current-balance')).toContain('1,000.00');
    expect(testidText(container, 'cash-movement-resulting-balance')).toContain('1,250.50');

    unmount(container, root);
  });

  it('shows current and resulting balance for a withdrawal', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    selectType(container, 'withdrawal');
    typeAmount(container, '250.50');
    expect(testidText(container, 'cash-movement-current-balance')).toContain('1,000.00');
    expect(testidText(container, 'cash-movement-resulting-balance')).toContain('749.50');

    unmount(container, root);
  });

  it('renders an em dash for the resulting balance before an amount is typed', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    expect(testidText(container, 'cash-movement-resulting-balance')).toBe('—');

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Title (design D19)
// ---------------------------------------------------------------------------

describe('RecordCashMovementDialog — title', () => {
  it('renders the design title literal', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    expect(container.querySelector('h2')?.textContent).toBe('Record a deposit or withdrawal');

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Overdraw warning (Req 6.4) — shown, but never blocks submission
// ---------------------------------------------------------------------------

describe('RecordCashMovementDialog — negative-balance warning', () => {
  it('warns and keeps submit enabled when the withdrawal takes the balance below zero', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    selectType(container, 'withdrawal');
    typeAmount(container, '1500');

    const warning = testidText(container, 'cash-movement-negative-warning');
    expect(warning).toContain('below zero');
    expect(warning).toContain('does not include the market value of open positions');
    expect(submitButton(container).disabled).toBe(false);

    unmount(container, root);
  });

  it('shows no warning when the resulting balance stays non-negative', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    selectType(container, 'withdrawal');
    typeAmount(container, '500');
    expect(container.querySelector('[data-testid="cash-movement-negative-warning"]')).toBeNull();

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Submit gating
// ---------------------------------------------------------------------------

describe('RecordCashMovementDialog — submit gating', () => {
  it('disables submit before anything is typed', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );
    expect(submitButton(container).disabled).toBe(true);
    unmount(container, root);
  });

  it.each(['', '0', 'abc', '-5'])('disables submit for the invalid amount %j', (value) => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeAmount(container, value);
    expect(submitButton(container).disabled).toBe(true);

    unmount(container, root);
  });

  it('enables submit once a positive amount is entered', () => {
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={() => {}} />,
    );

    typeAmount(container, '250');
    expect(submitButton(container).disabled).toBe(false);

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

describe('RecordCashMovementDialog — submission', () => {
  it('sends { type, amount, occurredAt: ISO } and closes', async () => {
    const onOpenChange = vi.fn();
    const { container, root } = mountWith(
      <RecordCashMovementDialog account={makeAccount()} open onOpenChange={onOpenChange} />,
    );

    typeAmount(container, '250.50');
    await submitForm(container);

    expect(recordMutateAsync).toHaveBeenCalledTimes(1);
    const payload = recordMutateAsync.mock.calls[0][0];
    expect(payload.type).toBe('deposit');
    expect(payload.amount).toBe('250.50');
    expect(payload.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    unmount(container, root);
  });
});

// ---------------------------------------------------------------------------
// Reset on reopen
// ---------------------------------------------------------------------------

describe('RecordCashMovementDialog — reset on reopen', () => {
  it('clears a previously-typed amount when the dialog is reopened', () => {
    const account = makeAccount();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<RecordCashMovementDialog account={account} open onOpenChange={() => {}} />);
    });

    typeAmount(container, '999');
    expect(submitButton(container).disabled).toBe(false);

    act(() => {
      root.render(
        <RecordCashMovementDialog account={account} open={false} onOpenChange={() => {}} />,
      );
    });
    act(() => {
      root.render(<RecordCashMovementDialog account={account} open onOpenChange={() => {}} />);
    });

    const amount = container.querySelector<HTMLInputElement>('#cashMovementAmount');
    expect(amount?.value).toBe('');
    expect(submitButton(container).disabled).toBe(true);

    unmount(container, root);
  });
});
