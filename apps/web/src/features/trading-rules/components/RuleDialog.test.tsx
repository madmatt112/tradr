// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT_USD = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_GBP = '22222222-2222-4222-8222-222222222222';

const { createMutateAsync, updateMutateAsync, accountsState, tagsState } = vi.hoisted(() => ({
  createMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  accountsState: {
    current: [] as { id: string; name: string; currency: string; defaultRiskPercent?: string }[],
  },
  tagsState: { current: [] as { id: string; name: string }[] },
}));

// Keep the real error-code reader — the dialog's inline mapping goes through it.
vi.mock('../hooks/useTradingRules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useTradingRules')>();
  return {
    ...actual,
    useCreateTradingRule: () => ({ mutateAsync: createMutateAsync, isPending: false }),
    useUpdateTradingRule: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  };
});

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accountsState.current }),
}));

vi.mock('@/features/tags/hooks/useTags', () => ({
  useTags: () => ({ data: tagsState.current }),
}));

// Stub the Radix dialog (portals/focus-trap fight jsdom).
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// A native <select> stub: lift the trigger id (which the <Label htmlFor> points
// at) onto the select, and forward `disabled` so the currency-lock test can read
// it.
vi.mock('@/components/ui/select', async () => {
  const { Children, isValidElement } = await import('react');
  const triggerId = (children: React.ReactNode): string | undefined => {
    let id: string | undefined;
    Children.forEach(children, (child) => {
      if (isValidElement<{ id?: string }>(child) && child.props.id) id = child.props.id;
    });
    return id;
  };
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value?: string;
      onValueChange: (v: string) => void;
      disabled?: boolean;
      children: React.ReactNode;
    }) => (
      <select
        id={triggerId(children)}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.currentTarget.value)}
      >
        {children}
      </select>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectLabel: () => null,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import { RuleDialog } from './RuleDialog';

function renderDialog() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <RuleDialog open onOpenChange={onOpenChange} rule={null} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

function selectByLabel(label: string): HTMLSelectElement {
  return screen.getByLabelText(label) as HTMLSelectElement;
}

beforeEach(() => {
  createMutateAsync.mockReset();
  updateMutateAsync.mockReset();
  accountsState.current = [
    { id: ACCOUNT_USD, name: 'USD acct', currency: 'USD', defaultRiskPercent: '2.50' },
    { id: ACCOUNT_GBP, name: 'GBP acct', currency: 'GBP', defaultRiskPercent: '3' },
  ];
  tagsState.current = [];
});

afterEach(() => {
  cleanup();
});

describe('RuleDialog — percent prefill', () => {
  it('prefills the percent from the scoped account default while untouched, then stops', () => {
    renderDialog();

    // Default type is max_risk_percent; scope the USD account (default 2.50%).
    fireEvent.change(selectByLabel('Account scope'), { target: { value: ACCOUNT_USD } });
    expect((screen.getByLabelText('Percent of balance') as HTMLInputElement).value).toBe('2.50');

    // Once the user types, the prefill no longer overrides on an account change.
    fireEvent.change(screen.getByLabelText('Percent of balance'), { target: { value: '1' } });
    fireEvent.change(selectByLabel('Account scope'), { target: { value: ACCOUNT_GBP } });
    expect((screen.getByLabelText('Percent of balance') as HTMLInputElement).value).toBe('1');
  });
});

describe('RuleDialog — currency lock', () => {
  it("locks an amount rule's currency to the scoped account's currency", () => {
    renderDialog();

    fireEvent.change(selectByLabel('Type'), { target: { value: 'max_risk_amount' } });
    // Free before an account is scoped.
    expect(selectByLabel('Currency').disabled).toBe(false);

    fireEvent.change(selectByLabel('Account scope'), { target: { value: ACCOUNT_GBP } });
    expect(selectByLabel('Currency').value).toBe('GBP');
    expect(selectByLabel('Currency').disabled).toBe(true);
  });
});

describe('RuleDialog — field errors', () => {
  it('shows a field error and does not submit when the percent is empty', () => {
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(screen.getByText(/Percent must be a decimal/i)).toBeTruthy();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });
});

describe('RuleDialog — inline 409', () => {
  it('renders the duplicate refusal inline by code and keeps the dialog open', async () => {
    createMutateAsync.mockRejectedValue({
      status: 409,
      error: { code: 'TRADING_RULE_DUPLICATE', message: 'server text not branched on' },
    });
    const onOpenChange = renderDialog();

    fireEvent.change(screen.getByLabelText('Percent of balance'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByTestId('rule-refusal')).toBeTruthy());
    expect(screen.getByText(/already have a rule/i)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('renders the limit refusal inline by code', async () => {
    createMutateAsync.mockRejectedValue({
      status: 409,
      error: { code: 'TRADING_RULE_LIMIT_REACHED', message: 'cap' },
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText('Percent of balance'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByTestId('rule-refusal')).toBeTruthy());
    expect(screen.getByText(/reached the limit of 50 rules/i)).toBeTruthy();
  });
});

describe('RuleDialog — create payload', () => {
  it('submits the assembled input and closes on success', async () => {
    createMutateAsync.mockResolvedValue({ id: 'new' });
    const onOpenChange = renderDialog();

    fireEvent.change(selectByLabel('Weight'), { target: { value: 'critical' } });
    fireEvent.change(screen.getByLabelText('Percent of balance'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync).toHaveBeenCalledWith({
      definition: { type: 'max_risk_percent', params: { percent: '1.5' } },
      weight: 'critical',
      enabled: true,
      accountId: null,
      tagId: null,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
