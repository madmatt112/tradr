// @vitest-environment jsdom
// AccountDialog — TIER_LIMIT_ACCOUNTS refusal mapping (plan-tiers REQ-6.1/
// 11.5): the create dialog maps the machine-readable CODE (never message text)
// to an inline banner with the upgrade path, and stays open so the remedy is
// in place.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/**
 * A default-risk option button, found by the start of its accessible name. Each
 * carries two lines — the percentage and what ten losing trades cost — so the
 * accessible name is the pair, and anchoring on `^` keeps `1%` from matching a
 * stored `1.50%` option.
 */
function riskOption(label: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name: label }) as HTMLButtonElement;
}

function riskSelected(label: RegExp): boolean {
  return riskOption(label).getAttribute('aria-pressed') === 'true';
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

// Default risk percentage — the optional per-account rule that seeds the
// position-size calculator.
describe('AccountDialog — default risk %', () => {
  it('offers 1/2/3% presets labelled with their cost, 2% selected, and no free-text field', () => {
    renderDialog();

    // The presets ARE the control — there is no percentage to type any more.
    expect(screen.queryByRole('textbox', { name: /default risk/i })).toBeNull();

    expect(riskSelected(/^2%/)).toBe(true);
    expect(riskSelected(/^1%/)).toBe(false);
    expect(riskSelected(/^3%/)).toBe(false);

    // Consequences, not adjectives: 1 − 0.99^10, 0.98^10, 0.97^10.
    expect(riskOption(/^1%/).textContent).toContain('10 losses: -10%');
    expect(riskOption(/^2%/).textContent).toContain('10 losses: -18%');
    expect(riskOption(/^3%/).textContent).toContain('10 losses: -26%');

    expect(
      screen.getByText(/share of this account's balance you risk on a single trade/i),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/conservative/i);
  });

  it('submits the 2% default on create when no preset is touched', async () => {
    createMutateAsync.mockResolvedValue({ id: 'new' });
    renderDialog();

    submitCreate();

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync.mock.calls[0][0]).toMatchObject({ defaultRiskPercent: '2' });
  });

  it('submits the chosen preset on create', async () => {
    createMutateAsync.mockResolvedValue({ id: 'new' });
    renderDialog();

    fireEvent.click(riskOption(/^1%/));
    expect(riskSelected(/^1%/)).toBe(true);
    expect(riskSelected(/^2%/)).toBe(false);
    submitCreate();

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    expect(createMutateAsync.mock.calls[0][0]).toMatchObject({ defaultRiskPercent: '1' });
  });

  it('selects a preset from the keyboard', async () => {
    const user = userEvent.setup();
    renderDialog();

    riskOption(/^3%/).focus();
    await user.keyboard('{Enter}');

    expect(riskSelected(/^3%/)).toBe(true);
    expect(riskSelected(/^2%/)).toBe(false);
  });

  it('submits no rule as undefined, never an empty string', async () => {
    createMutateAsync.mockResolvedValue({ id: 'new' });
    renderDialog();

    fireEvent.click(riskOption(/^No rule/));
    submitCreate();

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const sent = createMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.defaultRiskPercent).toBeUndefined();
    expect(sent).not.toHaveProperty('defaultRiskPercent', '');
  });

  it('selects the matching preset for a stored value in its normalised form', () => {
    renderDialog(vi.fn(), makeAccount({ defaultRiskPercent: '2.00' }));

    // '2.00' is the 2% preset, not a fourth option.
    expect(riskSelected(/^2%/)).toBe(true);
    expect(screen.queryByRole('button', { name: /^2\.00%/ })).toBeNull();
  });

  // Every percentage was typeable before the presets existed, and 3% was the
  // shipped default — so a real account can store something the presets do not
  // offer. It has to be shown as what it is, and survive an untouched save.
  it('keeps a stored non-preset value as its own selected option and writes it back unchanged', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    renderDialog(vi.fn(), makeAccount({ defaultRiskPercent: '1.50' }));

    expect(riskSelected(/^1\.50%/)).toBe(true);
    expect(riskOption(/^1\.50%/).textContent).toContain('current setting');
    expect(riskSelected(/^1%/)).toBe(false);
    expect(riskSelected(/^2%/)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.defaultRiskPercent).toBe('1.50');
  });

  // An account predating the column stores nothing. Seeding the create default
  // here would write a rule the user never chose.
  it('opens an account with no rule on No rule, and saving does not invent one', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    renderDialog(vi.fn(), makeAccount());

    expect(riskSelected(/^No rule/)).toBe(true);
    expect(riskSelected(/^2%/)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.defaultRiskPercent).toBeNull();
  });

  it('sends an explicit null when No rule is chosen on edit, so the rule clears', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    renderDialog(vi.fn(), makeAccount({ defaultRiskPercent: '1.50' }));

    fireEvent.click(riskOption(/^No rule/));
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
    expect(riskSelected(/^1\.50%/)).toBe(true);

    // Saving an untouched edit must not clear the rule it just displayed.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.defaultRiskPercent).toBe('1.50');
  });

  it('sends the newly chosen preset on edit', async () => {
    updateMutateAsync.mockResolvedValue({ id: 'a' });
    renderDialog(vi.fn(), makeAccount({ defaultRiskPercent: '1.50' }));

    fireEvent.click(riskOption(/^2%/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMutateAsync).toHaveBeenCalledTimes(1));
    const { data } = updateMutateAsync.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.defaultRiskPercent).toBe('2');
  });
});

// This dialog is one of only two places both timezones are visible to the same
// user; the settings control is the other, and disclaims this one in return.
describe('AccountDialog — telling the two timezones apart', () => {
  it('names the boundary this field governs and disclaims the reporting zone', () => {
    renderPersistentDialog(true, null);

    // A bare "Timezone" label invites exactly the wrong conclusion: that
    // setting it has set the zone the P&L is bucketed into.
    expect(screen.getByLabelText('Trading-day timezone')).toBeTruthy();
    expect(screen.queryByLabelText('Timezone')).toBeNull();

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/re-entered the same day/i);
    expect(text).toMatch(/not your reporting timezone/i);
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
    expect(fieldValue('Trading-day timezone')).toBe('Europe/London');
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
    expect(fieldValue('Trading-day timezone')).toBe('Asia/Tokyo');
    expect(fieldValue('Brokerage')).toBe(BROKERAGE_B);
    expect(fieldValue('Name')).toBe('Prop Firm');
    expect(riskSelected(/^2%/)).toBe(true);
  });
});
