// @vitest-environment jsdom
// AccountDialog — TIER_LIMIT_ACCOUNTS refusal mapping (plan-tiers REQ-6.1/
// 11.5): the create dialog maps the machine-readable CODE (never message text)
// to an inline banner with the upgrade path, and stays open so the remedy is
// in place.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { createMutateAsync, updateMutateAsync, tierData, brokerageData } = vi.hoisted(() => ({
  createMutateAsync: vi.fn(),
  updateMutateAsync: vi.fn(),
  tierData: { current: undefined as unknown },
  // Only id/name/isSystem are read by the dialog.
  brokerageData: { current: [] as { id: string; name: string; isSystem: boolean }[] },
}));

// Keep the real getAccountErrorCode — the dialog's mapping goes through it.
vi.mock('../hooks/useAccounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAccounts')>();
  return {
    ...actual,
    useCreateAccount: () => ({ mutateAsync: createMutateAsync, isPending: false }),
    useUpdateAccount: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
  };
});

vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData.current }),
}));

vi.mock('@/features/brokerages/hooks/useBrokerages', () => ({
  useBrokerages: () => ({ data: brokerageData.current }),
}));

// Stub the Radix primitives (portals/focus-trap fight jsdom).
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/select', async () => {
  const { Children, isValidElement } = await import('react');
  // SelectTrigger carries the id each <Label htmlFor> points at, and the stub
  // drops the trigger — so lift that id onto the <select> to keep the field
  // reachable by its label rather than by DOM order.
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
      children,
    }: {
      value?: string;
      onValueChange: (v: string) => void;
      children: React.ReactNode;
    }) => (
      <select
        id={triggerId(children)}
        value={value}
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

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    onClick,
    children,
    ...rest
  }: {
    to: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    children: React.ReactNode;
  }) => (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('@/lib/telemetry/posthog', () => ({
  captureClientEvent: vi.fn(),
}));

import type { Account } from '@tradr/shared';

import { AccountDialog } from './AccountDialog';

function renderDialog(onOpenChange = vi.fn(), account?: Account) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <AccountDialog open onOpenChange={onOpenChange} account={account} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    name: 'IBKR Main',
    currency: 'USD',
    timezone: 'America/New_York',
    brokerageId: null,
    brokerageName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const BROKERAGE_A = '33333333-3333-4333-8333-333333333333';
const BROKERAGE_B = '44444444-4444-4444-8444-444444444444';

// AccountList mounts ONE dialog with no `key` and swaps the `account` prop, so
// the same component instance is reused across create/edit and edit/edit
// switches. This drives that instance the way the list does.
function renderPersistentDialog(open: boolean, account: Account | null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (props: { open: boolean; account: Account | null }) => (
    <QueryClientProvider client={qc}>
      <AccountDialog open={props.open} onOpenChange={vi.fn()} account={props.account} />
    </QueryClientProvider>
  );
  const { rerender } = render(tree({ open, account }));
  return (next: { open: boolean; account: Account | null }) => rerender(tree(next));
}

function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;
}

function submitCreate(): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'IBKR Main' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

beforeEach(() => {
  createMutateAsync.mockReset();
  updateMutateAsync.mockReset();
  brokerageData.current = [];
  tierData.current = {
    gatingEnabled: true,
    exempt: false,
    tier: 'free',
    purchasable: true,
    subscription: null,
    limits: {
      free: {
        accounts: 1,
        positions: 1000,
        lookbackMonths: 6,
        platformTurns: 50,
        images: 20,
        csvImports: 3,
      },
      pro: {
        accounts: null,
        positions: null,
        lookbackMonths: null,
        platformTurns: 500,
        images: 200,
        csvImports: null,
      },
    },
    usage: null,
  };
});

afterEach(() => {
  cleanup();
});

describe('AccountDialog — TIER_LIMIT_ACCOUNTS mapping', () => {
  it('renders the inline refusal with the upgrade CTA and keeps the dialog open', async () => {
    createMutateAsync.mockRejectedValue({
      status: 403,
      error: { code: 'TIER_LIMIT_ACCOUNTS', message: 'server text is not branched on' },
    });
    const onOpenChange = renderDialog();

    submitCreate();

    await waitFor(() => expect(screen.getByTestId('account-tier-refusal')).toBeTruthy());
    expect(screen.getByTestId('upgrade-cta-account-dialog')).toBeTruthy();
    // Actionable in place — the dialog never closed on the refusal.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('omits the upgrade CTA when the subscription is not purchasable', async () => {
    (tierData.current as { purchasable: boolean }).purchasable = false;
    createMutateAsync.mockRejectedValue({
      status: 403,
      error: { code: 'TIER_LIMIT_ACCOUNTS', message: 'cap' },
    });
    renderDialog();

    submitCreate();

    await waitFor(() => expect(screen.getByTestId('account-tier-refusal')).toBeTruthy());
    expect(screen.queryByTestId('upgrade-cta-account-dialog')).toBeNull();
  });

  it('renders no tier banner for other refusal codes (toast handles them)', async () => {
    createMutateAsync.mockRejectedValue({
      status: 409,
      error: { code: 'DUPLICATE_NAME', message: 'Name already taken' },
    });
    const onOpenChange = renderDialog();

    submitCreate();

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('account-tier-refusal')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('closes normally on a successful create', async () => {
    createMutateAsync.mockResolvedValue({ id: 'new' });
    const onOpenChange = renderDialog();

    submitCreate();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByTestId('account-tier-refusal')).toBeNull();
  });
});

// Default risk percentage (user-onboarding R1.1/R1.6).
describe('AccountDialog — default risk %', () => {
  it('offers the field with its explanation and a conservative hint on create', () => {
    renderDialog();

    const input = screen.getByLabelText('Default risk %') as HTMLInputElement;
    expect(input.placeholder).toBe('3');
    expect(
      screen.getByText(/share of this account's balance you risk on a single trade/i),
    ).toBeTruthy();
    expect(screen.getByText(/3% is a conservative starting point/i)).toBeTruthy();
  });

  it('submits an empty field as undefined, never an empty string', async () => {
    createMutateAsync.mockResolvedValue({ id: 'new' });
    renderDialog();

    submitCreate();

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const sent = createMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.defaultRiskPercent).toBeUndefined();
    expect(sent).not.toHaveProperty('defaultRiskPercent', '');
  });

  it('submits the entered percentage on create', async () => {
    createMutateAsync.mockResolvedValue({ id: 'new' });
    renderDialog();

    fireEvent.change(screen.getByLabelText('Default risk %'), { target: { value: '1.5' } });
    submitCreate();

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync.mock.calls[0][0]).toMatchObject({ defaultRiskPercent: '1.5' });
  });

  it('blocks submit and renders the schema message for an out-of-range value', async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('Default risk %'), { target: { value: '101' } });
    submitCreate();

    await waitFor(() => expect(screen.getByText(/percentage above 0 and up to 100/i)).toBeTruthy());
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('prefills the field from the account on edit, in the stored normalised form', () => {
    renderDialog(vi.fn(), makeAccount({ defaultRiskPercent: '1.50' }));

    expect((screen.getByLabelText('Default risk %') as HTMLInputElement).value).toBe('1.50');
  });

  it('sends an explicit null when the field is emptied on edit, so the rule clears', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    renderDialog(vi.fn(), makeAccount({ defaultRiskPercent: '1.50' }));

    fireEvent.change(screen.getByLabelText('Default risk %'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.defaultRiskPercent).toBeNull();
  });

  // The dialog stays mounted while AccountList swaps `account` between create
  // and edit, so the fields are re-seeded on open. Without that, edit opens
  // blank and saving would clear the stored rule.
  it('seeds the field when a mounted create dialog is reopened for edit', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <AccountDialog open={false} onOpenChange={vi.fn()} account={null} />
      </QueryClientProvider>,
    );
    rerender(
      <QueryClientProvider client={qc}>
        <AccountDialog
          open
          onOpenChange={vi.fn()}
          account={makeAccount({ defaultRiskPercent: '1.50' })}
        />
      </QueryClientProvider>,
    );

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('IBKR Main');
    expect((screen.getByLabelText('Default risk %') as HTMLInputElement).value).toBe('1.50');

    // Saving an untouched edit must not clear the rule it just displayed.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.defaultRiskPercent).toBe('1.50');
  });

  it('sends the edited percentage on edit', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    renderDialog(vi.fn(), makeAccount({ defaultRiskPercent: '1.50' }));

    fireEvent.change(screen.getByLabelText('Default risk %'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.defaultRiskPercent).toBe('2');
  });
});

// The re-seed on open covers every field, not just the risk rule. Currency and
// timezone carry hardcoded fallbacks ('USD' / 'America/New_York'), so a dialog
// that failed to re-seed would display those over the account's stored values
// and overwrite them on save — silent data corruption, not a cosmetic glitch.
describe('AccountDialog — re-seeding on open', () => {
  beforeEach(() => {
    brokerageData.current = [
      { id: BROKERAGE_A, name: 'Alpha Broker', isSystem: false },
      { id: BROKERAGE_B, name: 'Beta Broker', isSystem: false },
    ];
  });

  it('shows the account currency, timezone and brokerage when a create dialog is reopened for edit', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    const rerender = renderPersistentDialog(false, null);

    rerender({
      open: true,
      account: makeAccount({
        currency: 'GBP',
        timezone: 'Europe/London',
        brokerageId: BROKERAGE_A,
      }),
    });

    expect(fieldValue('Currency')).toBe('GBP');
    expect(fieldValue('Timezone')).toBe('Europe/London');
    expect(fieldValue('Brokerage')).toBe(BROKERAGE_A);

    // The corruption itself: an untouched save must not write the create
    // defaults over what the account actually stores.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      currency: 'GBP',
      timezone: 'Europe/London',
      brokerageId: BROKERAGE_A,
    });
  });

  it('replaces the previous account values when edit is reopened on a different account', () => {
    const first = makeAccount({
      name: 'IBKR Main',
      currency: 'GBP',
      timezone: 'Europe/London',
      brokerageId: BROKERAGE_A,
      defaultRiskPercent: '1.50',
    });
    const second = makeAccount({
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Prop Firm',
      currency: 'JPY',
      timezone: 'Asia/Tokyo',
      brokerageId: BROKERAGE_B,
      defaultRiskPercent: '2.00',
    });
    const rerender = renderPersistentDialog(true, first);

    expect(fieldValue('Currency')).toBe('GBP');

    rerender({ open: false, account: first });
    rerender({ open: true, account: second });

    expect(fieldValue('Currency')).toBe('JPY');
    expect(fieldValue('Timezone')).toBe('Asia/Tokyo');
    expect(fieldValue('Brokerage')).toBe(BROKERAGE_B);
    expect(fieldValue('Name')).toBe('Prop Firm');
    expect(fieldValue('Default risk %')).toBe('2.00');
  });
});
