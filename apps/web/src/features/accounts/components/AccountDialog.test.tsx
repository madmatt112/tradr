// @vitest-environment jsdom
// AccountDialog — TIER_LIMIT_ACCOUNTS refusal mapping (plan-tiers REQ-6.1/
// 11.5): the create dialog maps the machine-readable CODE (never message text)
// to an inline banner with the upgrade path, and stays open so the remedy is
// in place.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { createMutateAsync, tierData } = vi.hoisted(() => ({
  createMutateAsync: vi.fn(),
  tierData: { current: undefined as unknown },
}));

// Keep the real getAccountErrorCode — the dialog's mapping goes through it.
vi.mock('../hooks/useAccounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAccounts')>();
  return {
    ...actual,
    useCreateAccount: () => ({ mutateAsync: createMutateAsync, isPending: false }),
    useUpdateAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData.current }),
}));

vi.mock('@/features/brokerages/hooks/useBrokerages', () => ({
  useBrokerages: () => ({ data: [] }),
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

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.currentTarget.value)}>
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
}));

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

import { AccountDialog } from './AccountDialog';

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <AccountDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

function submitCreate(): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'IBKR Main' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

beforeEach(() => {
  createMutateAsync.mockReset();
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
