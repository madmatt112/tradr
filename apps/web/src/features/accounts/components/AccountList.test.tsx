// @vitest-environment jsdom
// AccountList — plan-tiers designation UI (D18/REQ-6.6) + the L1 cap-edge
// banner (REQ-6.4/11.6). Badges and the make-writable action appear ONLY while
// the writability restriction is active (over-cap ∧ free ∧ gated); nothing
// tier-related renders when gating is off (self-host parity).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account, TierState } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { accountsData, tierData, setWritableMutate } = vi.hoisted(() => ({
  accountsData: { current: [] as unknown[] },
  tierData: { current: undefined as unknown },
  setWritableMutate: vi.fn(),
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
// hooks would need a QueryClientProvider here otherwise.
vi.mock('./AccountDialog', () => ({ AccountDialog: () => null }));

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
