// @vitest-environment jsdom
// AccountList — plan-tiers designation UI (D18/REQ-6.6) + the L1 cap-edge
// banner (REQ-6.4/11.6). Badges and the make-writable action appear ONLY while
// the writability restriction is active (over-cap ∧ free ∧ gated); nothing
// tier-related renders when gating is off (self-host parity).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account, TierState } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { accountsData, tierData, setWritableMutate, demoState, demoTeardown } = vi.hoisted(() => ({
  accountsData: { current: [] as unknown[] },
  tierData: { current: undefined as unknown },
  setWritableMutate: vi.fn(),
  demoState: { isDemoPresent: false, isPending: false },
  demoTeardown: vi.fn(),
}));

vi.mock('../hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accountsData.current, isLoading: false }),
  useDeleteAccount: () => ({ mutate: vi.fn() }),
  useSetWritableAccount: () => ({ mutate: setWritableMutate, isPending: false }),
}));

vi.mock('@/features/billing/useTierState', () => ({
  useTierState: () => ({ data: tierData.current }),
}));

// The create/edit dialog has its own test file (AccountDialog.test.tsx); its
// hooks would need a QueryClientProvider here otherwise. It respects `open` so
// the demo confirm flow can assert WHEN the form appears.
vi.mock('./AccountDialog', () => ({
  AccountDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="account-dialog" /> : null,
}));

// `useDemoAccount` has its own tests; here it is only the answer that matters.
vi.mock('@/features/onboarding/hooks/useDemoAccount', () => ({
  useDemoAccount: () => ({
    isDemoPresent: demoState.isDemoPresent,
    demoAccount: undefined,
    seed: vi.fn(),
    teardown: demoTeardown,
    isPending: demoState.isPending,
  }),
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

import { captureClientEvent } from '@/lib/telemetry/posthog';

import { AccountList } from './AccountList';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';

const ACCOUNTS: Account[] = [
  { id: ACCOUNT_A, name: 'Main', currency: 'USD' } as Account,
  { id: ACCOUNT_B, name: 'Swing', currency: 'EUR' } as Account,
];

const FREE_LIMITS = {
  accounts: 1,
  positions: 1000,
  lookbackMonths: 6,
  platformTurns: 50,
  images: 20,
  csvImports: 3,
};
const PRO_LIMITS = {
  accounts: null,
  positions: null,
  lookbackMonths: null,
  platformTurns: 500,
  images: 200,
  csvImports: null,
};

function tierState(usage: TierState['usage'], overrides: Partial<TierState> = {}): TierState {
  return {
    gatingEnabled: true,
    exempt: false,
    tier: 'free',
    purchasable: true,
    subscription: null,
    limits: { free: FREE_LIMITS, pro: PRO_LIMITS },
    usage,
    ...overrides,
  };
}

beforeEach(() => {
  accountsData.current = ACCOUNTS;
  tierData.current = undefined;
  setWritableMutate.mockReset();
  demoState.isDemoPresent = false;
  demoState.isPending = false;
  demoTeardown.mockReset();
  vi.mocked(captureClientEvent).mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccountList — writability designation (D18)', () => {
  it('badges the writable account and offers make-writable on the rest when over-cap', () => {
    // 2 accounts used > cap 1 ⇒ restriction active; A is the designation.
    tierData.current = tierState({
      accounts: { used: 2, writableAccountId: ACCOUNT_A },
      positions: { used: 0 },
      platformTurns: { allowanceUsed: 0 },
      images: { used: 0 },
      csvImports: { used: 0 },
    });
    render(<AccountList />);

    expect(screen.getByTestId(`writable-badge-${ACCOUNT_A}`)).toBeTruthy();
    expect(screen.getByTestId(`readonly-badge-${ACCOUNT_B}`)).toBeTruthy();
    expect(screen.queryByTestId(`readonly-badge-${ACCOUNT_A}`)).toBeNull();

    // Exactly one make-writable action (the writable row has none); it carries
    // cursor-pointer and fires the designation mutation with the row's id.
    const makeWritable = screen.getByRole('button', { name: 'Make writable' });
    expect(makeWritable.className).toContain('cursor-pointer');
    fireEvent.click(makeWritable);
    expect(setWritableMutate).toHaveBeenCalledTimes(1);
    expect(setWritableMutate).toHaveBeenCalledWith(ACCOUNT_B);
  });

  it('renders no badges or make-writable action at the cap but not over it', () => {
    tierData.current = tierState({
      accounts: { used: 1, writableAccountId: ACCOUNT_A },
      positions: { used: 0 },
      platformTurns: { allowanceUsed: 0 },
      images: { used: 0 },
      csvImports: { used: 0 },
    });
    render(<AccountList />);

    expect(screen.queryByTestId(`writable-badge-${ACCOUNT_A}`)).toBeNull();
    expect(screen.queryByTestId(`readonly-badge-${ACCOUNT_B}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make writable' })).toBeNull();
  });
});

describe('AccountList — L1 cap-edge banner (REQ-6.4/11.6)', () => {
  it('shows the banner with the upgrade CTA at ≥ cap with gating on', () => {
    tierData.current = tierState({
      accounts: { used: 1, writableAccountId: ACCOUNT_A },
      positions: { used: 0 },
      platformTurns: { allowanceUsed: 0 },
      images: { used: 0 },
      csvImports: { used: 0 },
    });
    render(<AccountList />);

    expect(screen.getByTestId('accounts-cap-banner')).toBeTruthy();

    // Upgrade CTA fires the D17 funnel event with this surface's identity.
    const cta = screen.getByTestId('upgrade-cta-accounts');
    fireEvent.click(cta);
    expect(captureClientEvent).toHaveBeenCalledTimes(1);
    expect(captureClientEvent).toHaveBeenCalledWith('upgrade_cta_clicked', {
      surface: 'accounts',
    });
  });

  it('omits the upgrade CTA when the subscription is not purchasable', () => {
    tierData.current = tierState(
      {
        accounts: { used: 1, writableAccountId: ACCOUNT_A },
        positions: { used: 0 },
        platformTurns: { allowanceUsed: 0 },
        images: { used: 0 },
        csvImports: { used: 0 },
      },
      { purchasable: false },
    );
    render(<AccountList />);

    expect(screen.getByTestId('accounts-cap-banner')).toBeTruthy();
    expect(screen.queryByTestId('upgrade-cta-accounts')).toBeNull();
  });

  it('renders no banner below the cap', () => {
    tierData.current = tierState({
      accounts: { used: 0, writableAccountId: null },
      positions: { used: 0 },
      platformTurns: { allowanceUsed: 0 },
      images: { used: 0 },
      csvImports: { used: 0 },
    });
    render(<AccountList />);
    expect(screen.queryByTestId('accounts-cap-banner')).toBeNull();
  });
});

describe('AccountList — creating a real account while sample data is present', () => {
  it('opens the form straight away when there is no sample data', () => {
    render(<AccountList />);

    fireEvent.click(screen.getByRole('button', { name: 'New Account' }));

    expect(screen.getByTestId('account-dialog')).toBeTruthy();
    expect(screen.queryByTestId('demo-teardown-confirm')).toBeNull();
    expect(demoTeardown).not.toHaveBeenCalled();
  });

  it('asks first, and does not open the form on the way', () => {
    demoState.isDemoPresent = true;
    render(<AccountList />);

    fireEvent.click(screen.getByRole('button', { name: 'New Account' }));

    // The server refuses the create outright while sample data is present, so
    // opening the form here would walk the user into a wall.
    expect(screen.getByTestId('demo-teardown-confirm')).toBeTruthy();
    expect(screen.queryByTestId('account-dialog')).toBeNull();
    expect(demoTeardown).not.toHaveBeenCalled();
  });

  it('tears the sample data down and then opens the form, once', () => {
    demoState.isDemoPresent = true;
    render(<AccountList />);

    fireEvent.click(screen.getByRole('button', { name: 'New Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove and continue' }));

    expect(demoTeardown).toHaveBeenCalledTimes(1);
    // The form opens on the teardown's success, not before it: a failed
    // teardown leaves its own toast and no half-started form.
    expect(screen.queryByTestId('account-dialog')).toBeNull();
    const [options] = demoTeardown.mock.calls[0] as [{ onSuccess: () => void }];
    act(() => options.onSuccess());
    expect(screen.getByTestId('account-dialog')).toBeTruthy();
  });

  it('holds the confirmation open until the teardown settles, so it cannot be confirmed twice', () => {
    demoState.isDemoPresent = true;
    const { rerender } = render(<AccountList />);

    fireEvent.click(screen.getByRole('button', { name: 'New Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove and continue' }));

    expect(demoTeardown).toHaveBeenCalledTimes(1);
    // Radix closes an action on activation. That put "New Account" live again
    // underneath a request that was still running, so a second click re-showed
    // this same destructive confirmation and fired a second teardown — the data
    // survives, being idempotent server-side, but the user is asked to confirm
    // one action twice and learns that the first confirmation did not take.
    expect(screen.getByTestId('demo-teardown-confirm')).toBeTruthy();

    demoState.isPending = true;
    rerender(<AccountList />);

    const action = screen.getByRole('button', { name: 'Removing…' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(action);
    expect(demoTeardown).toHaveBeenCalledTimes(1);

    // Nor can it be escaped out of, which would be the other way back to the
    // "New Account" button while the teardown is still in flight.
    fireEvent.keyDown(screen.getByTestId('demo-teardown-confirm'), { key: 'Escape' });
    expect(screen.getByTestId('demo-teardown-confirm')).toBeTruthy();
  });

  it('says so and stays open when the teardown fails, rather than stranding the user', () => {
    demoState.isDemoPresent = true;
    render(<AccountList />);

    fireEvent.click(screen.getByRole('button', { name: 'New Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove and continue' }));

    const [options] = demoTeardown.mock.calls[0] as [{ onError: () => void }];
    act(() => options.onError());

    // A rejection used to leave a closed dialog, no form, and only a toast the
    // user may have missed — the state they started in with no account of the
    // click in it.
    const error = screen.getByTestId('demo-teardown-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('demo-teardown-confirm')).toBeTruthy();
    expect(screen.queryByTestId('account-dialog')).toBeNull();

    // And the same button is the retry, which clears the stale failure.
    fireEvent.click(screen.getByRole('button', { name: 'Remove and continue' }));
    expect(demoTeardown).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('demo-teardown-error')).toBeNull();
  });

  it('leaves everything as it was when the user cancels', () => {
    demoState.isDemoPresent = true;
    render(<AccountList />);

    fireEvent.click(screen.getByRole('button', { name: 'New Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(demoTeardown).not.toHaveBeenCalled();
    expect(screen.queryByTestId('account-dialog')).toBeNull();
  });
});

describe('AccountList — self-host parity (gating off)', () => {
  it('renders no tier UI when usage is null (gating off / exempt)', () => {
    tierData.current = tierState(null);
    render(<AccountList />);

    expect(screen.queryByTestId('accounts-cap-banner')).toBeNull();
    expect(screen.queryByTestId(`writable-badge-${ACCOUNT_A}`)).toBeNull();
    expect(screen.queryByTestId(`readonly-badge-${ACCOUNT_B}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make writable' })).toBeNull();
  });

  it('renders no tier UI while the tier query is in flight', () => {
    tierData.current = undefined;
    render(<AccountList />);

    expect(screen.queryByTestId('accounts-cap-banner')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make writable' })).toBeNull();
  });
});
