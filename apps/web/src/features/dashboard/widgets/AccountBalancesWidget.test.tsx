// @vitest-environment jsdom
//
// The Account Balances widget caps its single-currency list at
// ACCOUNT_BALANCES_ROW_CAP rows and, when there are more accounts than the cap,
// links to the full list carrying the total count (Req 4.1–4.3). These tests
// mount the widget with stubbed accounts / totals / missing-rate hooks and a
// stubbed router, so the cap and the counted link are exercised without a query
// client or route context.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '@tradr/shared';

import { useDashboardTotalQuery } from '@/features/accounting/hooks/useDashboardTotal';
import { useMissingRatePrompt } from '@/features/accounting/hooks/useMissingRatePrompt';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: vi.fn(),
}));

vi.mock('@/features/accounting/hooks/useDashboardTotal', () => ({
  useDashboardTotalQuery: vi.fn(),
}));

vi.mock('@/features/accounting/hooks/useMissingRatePrompt', () => ({
  useMissingRatePrompt: vi.fn(),
}));

// Stub TanStack Router: <Link> becomes a plain anchor so href / text are
// inspectable without a router context.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import AccountBalancesWidget from './AccountBalancesWidget';

type AccountsResult = ReturnType<typeof useAccounts>;
type TotalResult = ReturnType<typeof useDashboardTotalQuery>;

// An Account-shaped row carrying just the fields the widget reads; the rest are
// filled to keep the shape plausible and cast at the boundary.
function makeAccount(overrides: Partial<Account>): Account {
  return {
    id: 'id',
    name: 'Account',
    currency: 'USD',
    balance: '10.00',
    ...overrides,
  } as unknown as Account;
}

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

beforeEach(() => {
  // Single-currency USD total, no missing rate — the same baseline for both
  // cases; only the accounts list changes.
  vi.mocked(useDashboardTotalQuery).mockReturnValue({
    data: { displayCurrency: 'USD', total: '100.00' },
    isLoading: false,
  } as unknown as TotalResult);
  vi.mocked(useMissingRatePrompt).mockReturnValue({
    shouldPrompt: false,
    missingPair: null,
    missingPairs: [],
    deeplinkTo: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountBalancesWidget — four-row cap', () => {
  it('renders four of seven single-currency rows, the total and a counted link', () => {
    const accounts = Array.from({ length: 7 }, (_, i) =>
      makeAccount({ id: `id-${i}`, name: `Account ${i}` }),
    );
    vi.mocked(useAccounts).mockReturnValue({
      data: accounts,
      isLoading: false,
    } as unknown as AccountsResult);

    const { container, root } = mountWith(<AccountBalancesWidget />);

    expect(container.querySelectorAll('li')).toHaveLength(4);
    expect(container.textContent).toContain('Total');
    const link = container.querySelector('a[href="/accounts"]');
    expect(link?.textContent).toContain('View all 7 accounts');

    unmount(container, root);
  });

  it('renders no counted link when there are fewer accounts than the cap', () => {
    const accounts = Array.from({ length: 3 }, (_, i) =>
      makeAccount({ id: `id-${i}`, name: `Account ${i}` }),
    );
    vi.mocked(useAccounts).mockReturnValue({
      data: accounts,
      isLoading: false,
    } as unknown as AccountsResult);

    const { container, root } = mountWith(<AccountBalancesWidget />);

    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.querySelector('a[href="/accounts"]')).toBeNull();
    expect(container.textContent).not.toContain('View all');

    unmount(container, root);
  });
});
