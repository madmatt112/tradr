// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '@tradr/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The reconcile dialog drags in Radix + a mutation hook; this file is about the
// balance card's own rendering, so stub it out entirely.
vi.mock('./ReconcileBalanceDialog', () => ({
  ReconcileBalanceDialog: () => null,
}));

import { AccountBalance } from './AccountBalance';

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
    balance: '5050.0000',
    cash: '4550.0000',
    positionValue: '500.0000',
    ...over,
  } as Account;
}

const mounted: { container: HTMLElement; root: Root }[] = [];
function render(account: Account) {
  const m = mountWith(<AccountBalance account={account} />);
  mounted.push(m);
  return m.container;
}

afterEach(() => {
  while (mounted.length) {
    const m = mounted.pop()!;
    unmount(m.container, m.root);
  }
});

describe('AccountBalance — cash / position split', () => {
  it('renders both halves alongside the balance', () => {
    const container = render(makeAccount());

    expect(container.querySelector('[data-testid="account-balance"]')?.textContent).toContain(
      '5,050.00',
    );
    expect(container.querySelector('[data-testid="account-cash"]')?.textContent).toContain(
      '4,550.00',
    );
    expect(
      container.querySelector('[data-testid="account-position-value"]')?.textContent,
    ).toContain('500.00');
  });

  it('says the position figure is cost basis, so it does not read as a market value', () => {
    const container = render(makeAccount());
    expect(container.textContent).toContain('cost basis');
    expect(container.textContent).toContain('not market value');
  });

  it('shows a negative position value for a shorting account', () => {
    // Short 10 @ $100, covered 5 @ $90: cash sits ABOVE the balance because the
    // proceeds are in hand while the shares are still owed.
    const container = render(
      makeAccount({ balance: '5050.0000', cash: '5550.0000', positionValue: '-500.0000' }),
    );

    const positionValue =
      container.querySelector('[data-testid="account-position-value"]')?.textContent ?? '';
    expect(positionValue).toContain('500.00');
    expect(positionValue).toMatch(/[-−(]/);
    expect(container.querySelector('[data-testid="account-cash"]')?.textContent).toContain(
      '5,550.00',
    );
  });

  it('omits the split entirely when the API did not supply it', () => {
    // The fields are optional on AccountSchema so older fixtures still parse.
    const container = render(
      makeAccount({ cash: undefined, positionValue: undefined } as Partial<Account>),
    );

    expect(container.querySelector('[data-testid="account-balance"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="account-cash"]')).toBeNull();
    expect(container.querySelector('[data-testid="account-position-value"]')).toBeNull();
  });

  it('still renders a zero position value rather than hiding it', () => {
    // A flat account is all cash — but the split is still meaningful, and
    // hiding it would make the card flicker between two layouts as positions
    // open and close.
    const container = render(
      makeAccount({ balance: '5000.0000', cash: '5000.0000', positionValue: '0.0000' }),
    );
    expect(
      container.querySelector('[data-testid="account-position-value"]')?.textContent,
    ).toContain('0.00');
  });
});
