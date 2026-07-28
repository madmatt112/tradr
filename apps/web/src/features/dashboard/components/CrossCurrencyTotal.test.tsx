// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '@tradr/shared';

import type { DashboardTotalResponse } from '@/features/accounting/hooks/useDashboardTotal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockAccounts: Account[] | undefined;
let mockAccountsLoading = false;
let mockTotal: DashboardTotalResponse | undefined;
let mockTotalLoading = false;

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => ({
    data: mockAccounts,
    isLoading: mockAccountsLoading,
  }),
}));

vi.mock('@/features/accounting/hooks/useDashboardTotal', () => ({
  useDashboardTotalQuery: () => ({
    data: mockTotal,
    isLoading: mockTotalLoading,
  }),
}));

// Mock the shadcn Tooltip primitives so jsdom isn't fighting Radix portals.
// We render trigger + content inline so the missing-pair list is always in
// the DOM and assertable without simulating hover events.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import { CrossCurrencyTotal } from './CrossCurrencyTotal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(over: Partial<Account>): Account {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    userId: '00000000-0000-0000-0000-000000000001',
    name: 'Test Account',
    currency: 'USD',
    timezone: 'America/New_York',
    brokerageId: null,
    brokerageName: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
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
  mockAccounts = undefined;
  mockAccountsLoading = false;
  mockTotal = undefined;
  mockTotalLoading = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossCurrencyTotal — single-currency hidden (Req 4.9)', () => {
  it('renders nothing when the user has accounts in only one currency', () => {
    mockAccounts = [
      makeAccount({ id: 'a1', currency: 'USD' }),
      makeAccount({ id: 'a2', currency: 'USD' }),
    ];
    mockTotal = {
      displayCurrency: 'USD',
      total: '1000.00',
      missingPairs: [],
    };
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-testid="cross-currency-total"]')).toBeNull();
    expect(container.querySelector('[data-testid="cross-currency-total-missing"]')).toBeNull();
    unmount(container, root);
  });

  it('renders nothing when the user has zero accounts', () => {
    mockAccounts = [];
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    expect(container.textContent).toBe('');
    unmount(container, root);
  });

  it('renders nothing while accounts are loading (no flash)', () => {
    mockAccounts = undefined;
    mockAccountsLoading = true;
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    expect(container.textContent).toBe('');
    unmount(container, root);
  });
});

describe('CrossCurrencyTotal — multi-currency visible', () => {
  it('renders the aggregate total line when the user has accounts in 2+ currencies', () => {
    mockAccounts = [
      makeAccount({ id: 'a1', currency: 'USD' }),
      makeAccount({ id: 'a2', currency: 'GBP' }),
    ];
    mockTotal = {
      displayCurrency: 'USD',
      total: '1234.56',
      missingPairs: [],
    };
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    const totalEl = container.querySelector('[data-testid="cross-currency-total"]');
    expect(totalEl).not.toBeNull();
    expect(totalEl!.textContent).toMatch(/1,234/);
    // The missing-rate placeholder must NOT render in the happy path.
    expect(container.querySelector('[data-testid="cross-currency-total-missing"]')).toBeNull();
    unmount(container, root);
  });

  it('renders the aggregate line when there are ≥3 distinct currencies', () => {
    mockAccounts = [
      makeAccount({ id: 'a1', currency: 'USD' }),
      makeAccount({ id: 'a2', currency: 'GBP' }),
      makeAccount({ id: 'a3', currency: 'EUR' }),
    ];
    mockTotal = {
      displayCurrency: 'USD',
      total: '5000.00',
      missingPairs: [],
    };
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    expect(container.querySelector('[data-testid="cross-currency-total"]')).not.toBeNull();
    unmount(container, root);
  });
});

describe('CrossCurrencyTotal — transition 2→1 currencies', () => {
  it('unmounts the widget when the account set drops back to a single currency', () => {
    // Start: two distinct currencies → widget visible.
    mockAccounts = [
      makeAccount({ id: 'a1', currency: 'USD' }),
      makeAccount({ id: 'a2', currency: 'GBP' }),
    ];
    mockTotal = {
      displayCurrency: 'USD',
      total: '1234.56',
      missingPairs: [],
    };
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    expect(container.querySelector('[data-testid="cross-currency-total"]')).not.toBeNull();

    // Transition: user deletes the GBP account → only USD accounts remain.
    mockAccounts = [makeAccount({ id: 'a1', currency: 'USD' })];
    act(() => {
      root.render(<CrossCurrencyTotal />);
    });
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-testid="cross-currency-total"]')).toBeNull();
    unmount(container, root);
  });

  it('re-renders the widget when the account set grows from 1→2 currencies', () => {
    // Inverse of the above transition — guards against an over-eager "hide
    // forever" cache.
    mockAccounts = [makeAccount({ id: 'a1', currency: 'USD' })];
    mockTotal = {
      displayCurrency: 'USD',
      total: '500.00',
      missingPairs: [],
    };
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    expect(container.textContent).toBe('');

    mockAccounts = [
      makeAccount({ id: 'a1', currency: 'USD' }),
      makeAccount({ id: 'a2', currency: 'GBP' }),
    ];
    mockTotal = {
      displayCurrency: 'USD',
      total: '1234.56',
      missingPairs: [],
    };
    act(() => {
      root.render(<CrossCurrencyTotal />);
    });
    expect(container.querySelector('[data-testid="cross-currency-total"]')).not.toBeNull();
    unmount(container, root);
  });
});

describe('CrossCurrencyTotal — missing rate tooltip', () => {
  it('renders "—" with a tooltip listing missing pairs and an Enter rate deeplink', () => {
    mockAccounts = [
      makeAccount({ id: 'a1', currency: 'USD' }),
      makeAccount({ id: 'a2', currency: 'GBP' }),
    ];
    mockTotal = {
      displayCurrency: 'USD',
      total: null,
      missingPairs: [{ baseCurrency: 'USD', quoteCurrency: 'GBP' }],
    };
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    const missingEl = container.querySelector('[data-testid="cross-currency-total-missing"]');
    expect(missingEl).not.toBeNull();
    expect(missingEl!.textContent).toBe('—');

    // Tooltip content includes the missing pair.
    const tooltipContent = container.querySelector('[data-testid="tooltip-content"]');
    expect(tooltipContent).not.toBeNull();
    expect(tooltipContent!.textContent).toMatch(/USD/);
    expect(tooltipContent!.textContent).toMatch(/GBP/);

    // Inline deeplink points to the FX settings tab with the pair prefilled.
    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      (a.getAttribute('href') ?? '').startsWith('/settings'),
    );
    expect(link).toBeDefined();
    expect(link!.getAttribute('href')).toBe('/settings/profile?base=USD&quote=GBP');
    expect(link!.className).toContain('cursor-pointer');

    // The happy-path total element must not render in this state.
    expect(container.querySelector('[data-testid="cross-currency-total"]')).toBeNull();
    unmount(container, root);
  });

  it('lists multiple missing pairs in the tooltip', () => {
    mockAccounts = [
      makeAccount({ id: 'a1', currency: 'USD' }),
      makeAccount({ id: 'a2', currency: 'GBP' }),
      makeAccount({ id: 'a3', currency: 'EUR' }),
    ];
    mockTotal = {
      displayCurrency: 'USD',
      total: null,
      missingPairs: [
        { baseCurrency: 'EUR', quoteCurrency: 'USD' },
        { baseCurrency: 'GBP', quoteCurrency: 'USD' },
      ],
    };
    const { container, root } = mountWith(<CrossCurrencyTotal />);
    const tooltipContent = container.querySelector('[data-testid="tooltip-content"]');
    expect(tooltipContent!.textContent).toMatch(/EUR/);
    expect(tooltipContent!.textContent).toMatch(/GBP/);
    expect(tooltipContent!.textContent).toMatch(/USD/);
    unmount(container, root);
  });
});
