// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Mutable query fixtures (rebound per test) ------------------------------
// The form's ONLY network dependencies are useAccounts / useBrokerages; mock
// just those (NOT the shared calculateTrade — the real function drives every
// results assertion below). Hoisted so the vi.mock factories can read them.
const state = vi.hoisted(() => ({
  accounts: { current: { data: [], isLoading: false, isError: false } as Record<string, unknown> },
  brokerages: {
    current: { data: [], isLoading: false, isError: false } as Record<string, unknown>,
  },
  // Which account figure the buying-power cap sizes against. Mocked rather than
  // left to fall through, so the two bases are both reachable and neither test
  // depends on an unresolved query defaulting.
  buyingPowerBasis: { current: { data: { basis: 'cash' } } as Record<string, unknown> },
}));

vi.mock('@/features/accounts/hooks/useAccounts', () => ({
  useAccounts: () => state.accounts.current,
}));
vi.mock('@/features/brokerages/hooks/useBrokerages', () => ({
  useBrokerages: () => state.brokerages.current,
}));
vi.mock('@/features/calculator/hooks/useBuyingPowerBasis', () => ({
  useBuyingPowerBasisQuery: () => state.buyingPowerBasis.current,
}));

// Stub the shadcn Select primitive as a native <select> so options are clickable
// and onValueChange fires in jsdom (Radix's pointer-capture machinery is
// browser-only). SelectValue → a placeholder <option> (so the loading/error
// placeholder text is assertable); SelectItem → <option>.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <option value="">{placeholder}</option>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// ---- Symbol-search / quote fixtures (Task 13) -------------------------------
// The quote hooks, the SymbolAutocomplete combobox, and the OptionsChainViewer
// are mocked so no network is hit and each test controls configured-ness, the
// mutation outcome, and the chain rows. The OptionsChainViewer stub reproduces
// the Task-11 selectability gate: a "Use" button only for rows with a non-empty
// option_symbol.
const quote = vi.hoisted(() => ({
  config: { current: { data: undefined, isLoading: true } as Record<string, unknown> },
  isPending: { current: false },
  mutate: {
    current: (() => {}) as (
      s: string,
      opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void },
    ) => void,
  },
  contracts: { current: [] as Array<Record<string, unknown>> },
}));

vi.mock('@/hooks/useStockQuoteConfig', () => ({
  useStockQuoteConfig: () => quote.config.current,
}));

vi.mock('@/hooks/useStockQuote', () => ({
  useStockQuote: () => ({
    mutate: (
      s: string,
      opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void },
    ) => quote.mutate.current(s, opts),
    isPending: quote.isPending.current,
  }),
}));

vi.mock('@/components/SymbolAutocomplete', () => ({
  SymbolAutocomplete: ({
    value,
    onChange,
    id,
  }: {
    value: string;
    onChange: (t: string) => void;
    id?: string;
  }) => (
    <input
      id={id}
      aria-label="Symbol"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value.toUpperCase())}
    />
  ),
}));

vi.mock('@/features/options/components/OptionsChainViewer', () => ({
  OptionsChainViewer: ({
    onSelectContract,
  }: {
    onSelectContract?: (c: Record<string, unknown>) => void;
  }) => (
    <div data-slot="options-chain-viewer">
      {quote.contracts.current.map((c, i) =>
        c.option_symbol ? (
          <button key={i} type="button" onClick={() => onSelectContract?.(c)}>
            {`Use ${String(c.option_symbol)}`}
          </button>
        ) : (
          <span key={i} data-testid={`no-symbol-row-${i}`}>
            {String(c.label ?? 'no symbol')}
          </span>
        ),
      )}
    </div>
  ),
}));

import { CalculatorForm } from './CalculatorForm';

// ---- Fixtures ---------------------------------------------------------------

const CAD_ACCOUNT = { id: 'acc-cad', name: 'Maple Margin', currency: 'CAD', balance: '50000' };
// A selected account whose balance is not yet derived (REQ-3.5) — no `balance`.
const NO_BALANCE_ACCOUNT = { id: 'acc-nobal', name: 'Fresh', currency: 'USD' };

// An account carrying its own risk rule (user-onboarding R1.2). The value is the
// numeric(5,2)-NORMALISED string the API returns — a stored 1.5 comes back
// '1.50' — so the prefill assertions expect that form, not what a user typed.
const RULED_ACCOUNT = {
  id: 'acc-ruled',
  name: 'By The Book',
  currency: 'USD',
  balance: '50000',
  defaultRiskPercent: '1.50',
};

// ---- Harness ----------------------------------------------------------------

/** Same Intl call the Numeric primitive uses, so assertions match regardless of locale. */
function fmtMoney(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function setAccounts(q: Record<string, unknown>): void {
  state.accounts.current = { data: [], isLoading: false, isError: false, ...q };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Re-host the form under a fresh router so its <Link>s resolve (the settings
// account test's re-host pattern). Wrapped in a QueryClientProvider per the
// task harness convention (inert here since the hooks are mocked).
async function mount(): Promise<void> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/',
    component: () => <CalculatorForm />,
  });
  const accountsRoute = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/accounts',
    component: () => null,
  });
  const brokeragesRoute = createRoute({
    getParentRoute: () => rootRoute as any,
    path: '/brokerages',
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([indexRoute, accountsRoute, brokeragesRoute] as any);
  const router = createRouter({
    routeTree: routeTree as any,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  // RouterProvider resolves the initial match on a microtask — wait for mount.
  await screen.findByLabelText('Entry price');
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type User = ReturnType<typeof userEvent.setup>;

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function fill(label: string, value: string): void {
  fireEvent.change(input(label), { target: { value } });
}

/**
 * The form validates on blur (never submits), and `isValid` is blur-only. Fill
 * every field first, then blur ONCE — a single resolver pass over the complete
 * form (interleaving blur-per-field races validation snapshots of incomplete
 * inputs, which can leave `isValid` stale-false).
 */
async function results(user: User, name: 'Dollar' | 'Percent', fields: Record<string, string>) {
  await switchBasis(user, name);
  const labels = Object.keys(fields);
  for (const label of labels) fill(label, fields[label]);
  fireEvent.blur(input(labels[labels.length - 1]));
}

async function switchBasis(user: User, name: 'Dollar' | 'Percent'): Promise<void> {
  // Radix Tabs activate on focus+click — userEvent reproduces that (fireEvent.click alone won't).
  await user.click(screen.getByRole('tab', { name }));
}

/** Find the native <select> carrying an option with the given value (the account picker). */
function selectByOptionValue(optionValue: string): HTMLSelectElement {
  const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
  for (const s of selects) {
    if (Array.from(s.options).some((o) => o.value === optionValue)) return s;
  }
  throw new Error(`no <select> with option value="${optionValue}"`);
}

async function fillPercentBasis(
  user: User,
  v: { entry: string; stop: string; balance: string; riskPercent: string },
): Promise<void> {
  await results(user, 'Percent', {
    'Entry price': v.entry,
    'Stop loss': v.stop,
    Balance: v.balance,
    'Risk percent': v.riskPercent,
  });
}

beforeEach(() => {
  setAccounts({ data: [] });
  state.brokerages.current = { data: [], isLoading: false, isError: false };
  state.buyingPowerBasis.current = { data: { basis: 'cash' } };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------

describe('CalculatorForm — risk-basis switching (REQ-1.3)', () => {
  it('clears the inactive basis fields on switch (dollar→percent clears dollarRisk; percent→dollar clears balance/percent)', async () => {
    const user = userEvent.setup();
    await mount();

    // Dollar mode (default) — fill the dollar risk.
    fireEvent.change(input('Dollar risk'), { target: { value: '1000' } });
    expect(input('Dollar risk').value).toBe('1000');

    // → percent: dollarRisk is hidden; the balance + percent inputs appear.
    await switchBasis(user, 'Percent');
    expect(screen.queryByLabelText('Dollar risk')).toBeNull();
    fireEvent.change(input('Balance'), { target: { value: '50000' } });
    fireEvent.change(input('Risk percent'), { target: { value: '2' } });

    // → back to dollar: dollarRisk reappears CLEARED (undefined'd on the percent switch).
    await switchBasis(user, 'Dollar');
    expect(input('Dollar risk').value).toBe('');
    expect(screen.queryByLabelText('Balance')).toBeNull();

    // → percent again: balance + percent are CLEARED (undefined'd on the dollar switch).
    await switchBasis(user, 'Percent');
    expect(input('Balance').value).toBe('');
    expect(input('Risk percent').value).toBe('');
  });
});

describe('CalculatorForm — account sourcing (REQ-3, REQ-5.2)', () => {
  it('selecting a non-USD account fills the balance, shows the currency note, and switches money to that currency', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [CAD_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Percent');

    // Fill the non-balance fields first, then select the account LAST — its
    // setValue(shouldValidate) then runs the final validation over a COMPLETE
    // form (selecting first would race an incomplete validation → stale isValid).
    // The balance is populated by the account, NOT typed (so the association survives).
    fill('Entry price', '50');
    fill('Stop loss', '48');
    fill('Risk percent', '2');
    fireEvent.change(selectByOptionValue(CAD_ACCOUNT.id), { target: { value: CAD_ACCOUNT.id } });
    fireEvent.blur(input('Risk percent'));

    // Balance populated from account.balance (read as-is, REQ-3.2).
    expect(input('Balance').value).toBe('50000');
    // Non-USD currency note (REQ-5.2). Its presence also guards the D8 trap: the
    // account-select setValue does NOT fire the balance register onChange, so the
    // association it just set survives.
    expect(screen.getByText(/Balance is in CAD/)).toBeTruthy();

    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    // derived = 50000 × 2 ÷ 100 = 1000, displayed in CAD (money switched), not USD.
    expect(screen.getAllByText(fmtMoney(1000, 'CAD')).length).toBeGreaterThan(0);
  });

  it('selecting an account with an ABSENT balance yields the neutral incomplete state (REQ-3.5)', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [NO_BALANCE_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Percent');

    fireEvent.change(selectByOptionValue(NO_BALANCE_ACCOUNT.id), {
      target: { value: NO_BALANCE_ACCOUNT.id },
    });
    expect(input('Balance').value).toBe('');

    // A valid percent + prices cannot size against a missing balance.
    fill('Entry price', '50');
    fill('Stop loss', '48');
    fill('Risk percent', '2');
    fireEvent.blur(input('Risk percent'));

    expect(screen.getByText('Enter trade parameters to see results')).toBeTruthy();
    expect(screen.queryByText('Derived Dollar Risk')).toBeNull();
  });

  it('manually editing the balance clears the account association / currency note — but account selection does not (REQ-3.6, D8)', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [CAD_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Percent');

    // Account selection (setValue) sets the association — the register onChange
    // does NOT fire, so the note is shown.
    fireEvent.change(selectByOptionValue(CAD_ACCOUNT.id), { target: { value: CAD_ACCOUNT.id } });
    expect(screen.getByText(/Balance is in CAD/)).toBeTruthy();

    // A user keystroke fires the register onChange → the association is cleared.
    fireEvent.change(input('Balance'), { target: { value: '60000' } });
    expect(screen.queryByText(/Balance is in CAD/)).toBeNull();
  });
});

describe('CalculatorForm — percent results + buying-power flag (REQ-4)', () => {
  it('renders the derived-risk row and the buying-power flag when the cap binds', async () => {
    const user = userEvent.setup();
    await mount();
    // entry 100, stop 99, balance 10000, 50% ⇒ derived 5000 (size 5000) but the
    // balance funds only floor(10000/100)=100 ⇒ cap binds at 100.
    await fillPercentBasis(user, {
      entry: '100',
      stop: '99',
      balance: '10000',
      riskPercent: '50',
    });

    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    expect(screen.getByText('Position size limited by account buying power')).toBeTruthy();
    expect(screen.getAllByText(fmtMoney(5000)).length).toBeGreaterThan(0); // echoed derivedDollarRisk
  });

  it.each([
    {
      name: 'exceeds-maximum',
      entry: '50',
      stop: '48',
      balance: '250000000',
      riskPercent: '100',
      message: /exceeds the calculator/,
      derived: 250000000,
    },
    {
      name: 'buying-power-zero',
      entry: '100',
      stop: '99',
      balance: '50',
      riskPercent: '100',
      message: /cannot fund one share/,
      derived: 50,
    },
    {
      name: 'insufficient-risk-in-percent',
      entry: '50',
      stop: '40',
      balance: '100',
      riskPercent: '1',
      message: /insufficient for one share/,
      derived: 1,
    },
  ])(
    'zero-position state ($name) still shows the echoed derived-risk row (REQ-4.1)',
    async ({ entry, stop, balance, riskPercent, message, derived }) => {
      const user = userEvent.setup();
      await mount();
      await fillPercentBasis(user, { entry, stop, balance, riskPercent });

      await screen.findByText(message, undefined, { timeout: 2000 });
      // The REQ-4.1 fix: the derived-risk row renders even in the zero-position states.
      expect(screen.getByText('Derived Dollar Risk')).toBeTruthy();
      expect(screen.getAllByText(fmtMoney(derived)).length).toBeGreaterThan(0);
    },
  );
});

describe('CalculatorForm — live-clear gate (D4, NFR Usability)', () => {
  it('clearing an active percent field falls back to the neutral placeholder, never a DecimalError', async () => {
    const user = userEvent.setup();
    await mount();
    await fillPercentBasis(user, {
      entry: '50',
      stop: '48',
      balance: '50000',
      riskPercent: '2',
    });

    // Precondition: a complete, blurred percent basis renders results.
    await screen.findByText('Position Sizing', undefined, { timeout: 2000 });

    // Empty the balance via a change event (no blur — isValid stays stale-true);
    // the watch-derived basisComplete gate must still close.
    fireEvent.change(input('Balance'), { target: { value: '' } });

    await screen.findByText('Enter trade parameters to see results');
    expect(screen.queryByText(/DecimalError/i)).toBeNull();
    expect(screen.queryByText(/Invalid argument/i)).toBeNull();
    expect(screen.queryByText('Position Sizing')).toBeNull();
  });

  it('clearing the dollar risk field falls back to the neutral placeholder, never a DecimalError', async () => {
    await mount();
    // Default dollar mode.
    fill('Entry price', '50');
    fill('Stop loss', '48');
    fill('Dollar risk', '1000');
    fireEvent.blur(input('Dollar risk'));

    await screen.findByText('Position Sizing', undefined, { timeout: 2000 });

    fireEvent.change(input('Dollar risk'), { target: { value: '' } });

    await screen.findByText('Enter trade parameters to see results');
    expect(screen.queryByText(/DecimalError/i)).toBeNull();
    expect(screen.queryByText('Position Sizing')).toBeNull();
  });
});

describe('CalculatorForm — account picker async states mirror the brokerage selector (REQ-3.4)', () => {
  it('loading state', async () => {
    const user = userEvent.setup();
    setAccounts({ data: undefined, isLoading: true });
    await mount();
    await switchBasis(user, 'Percent');
    expect(screen.getByText(/Loading accounts/)).toBeTruthy();
  });

  it('error state', async () => {
    const user = userEvent.setup();
    setAccounts({ data: undefined, isError: true });
    await mount();
    await switchBasis(user, 'Percent');
    expect(screen.getAllByText(/Failed to load accounts/).length).toBeGreaterThan(0);
  });

  it('empty state links to account setup', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [] });
    await mount();
    await switchBasis(user, 'Percent');
    expect(screen.getByText(/No accounts configured/)).toBeTruthy();
    expect(screen.getByText('set one up')).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// Task 13 — symbol-search / quote integration
// -----------------------------------------------------------------------------

function resetQuoteFixtures(): void {
  quote.config.current = { data: undefined, isLoading: true };
  quote.isPending.current = false;
  quote.mutate.current = () => {};
  quote.contracts.current = [];
}

describe('CalculatorForm — mode-switch clear (REQ-5.5)', () => {
  beforeEach(resetQuoteFixtures);

  it('clears entry/stop/target on switch, keeps dollar-risk, and never flashes a DecimalError', async () => {
    const user = userEvent.setup();
    await mount();

    // A complete dollar-basis stock calc.
    fill('Entry price', '100');
    fill('Stop loss', '99');
    fill('Target price (optional)', '110');
    fill('Dollar risk', '1000');
    fireEvent.blur(input('Dollar risk'));
    await screen.findByText('Position Sizing', undefined, { timeout: 2000 });

    // Stock → options clears the three mode-scaled per-share inputs.
    await user.click(screen.getByRole('tab', { name: 'Options' }));

    expect(input('Entry price').value).toBe('');
    expect(input('Stop loss').value).toBe('');
    expect(input('Target price (optional)').value).toBe('');
    // Mode-independent input is untouched.
    expect(input('Dollar risk').value).toBe('1000');

    // Gate closed cleanly — neutral placeholder, NEVER a raw DecimalError.
    await screen.findByText('Enter trade parameters to see results');
    expect(screen.queryByText(/DecimalError/i)).toBeNull();
    expect(screen.queryByText(/Invalid argument/i)).toBeNull();
    expect(screen.queryByText('Position Sizing')).toBeNull();
  });
});

describe('CalculatorForm — pull-quote gating + populate (REQ-5.2/5.3/5.4)', () => {
  beforeEach(resetQuoteFixtures);

  it('is absent while the config query is loading, even with a symbol', async () => {
    quote.config.current = { data: undefined, isLoading: true };
    await mount();
    fireEvent.change(input('Symbol'), { target: { value: 'AAPL' } });
    expect(screen.queryByRole('button', { name: 'Pull last price' })).toBeNull();
  });

  it('is absent when configured=false', async () => {
    quote.config.current = { data: { stockQuoteConfigured: false } };
    await mount();
    fireEvent.change(input('Symbol'), { target: { value: 'AAPL' } });
    expect(screen.queryByRole('button', { name: 'Pull last price' })).toBeNull();
  });

  it('is absent when configured but the symbol is empty, and appears once a symbol is entered', async () => {
    quote.config.current = { data: { stockQuoteConfigured: true } };
    await mount();
    expect(screen.queryByRole('button', { name: 'Pull last price' })).toBeNull();
    fireEvent.change(input('Symbol'), { target: { value: 'AAPL' } });
    expect(screen.getByRole('button', { name: 'Pull last price' })).toBeTruthy();
  });

  it('on success populates entry from lastPrice and shows the ~15-min delayed disclaimer', async () => {
    const user = userEvent.setup();
    quote.config.current = { data: { stockQuoteConfigured: true } };
    quote.mutate.current = (_s, opts) =>
      opts?.onSuccess?.({
        configured: true,
        symbol: 'AAPL',
        lastPrice: '187.42',
        change: null,
        delayed: true,
      });
    await mount();
    fireEvent.change(input('Symbol'), { target: { value: 'AAPL' } });
    await user.click(screen.getByRole('button', { name: 'Pull last price' }));

    expect(input('Entry price').value).toBe('187.42');
    expect(screen.getByText(/15 minutes delayed/i)).toBeTruthy();
  });

  it('on error shows the distinct coded message and leaves any existing entry untouched', async () => {
    const user = userEvent.setup();
    quote.config.current = { data: { stockQuoteConfigured: true } };
    quote.mutate.current = (_s, opts) => opts?.onError?.({ error: { code: 'NOT_FOUND' } });
    await mount();
    fireEvent.change(input('Symbol'), { target: { value: 'AAPL' } });
    fill('Entry price', '50');
    await user.click(screen.getByRole('button', { name: 'Pull last price' }));

    expect(screen.getByText('Symbol not found.')).toBeTruthy();
    expect(input('Entry price').value).toBe('50');
  });
});

describe('CalculatorForm — option contract hand-off (REQ-6.3/6.5)', () => {
  beforeEach(resetQuoteFixtures);

  it('populates entry from the contract premium (last_price) and shows the OCC symbol', async () => {
    const user = userEvent.setup();
    quote.contracts.current = [{ option_symbol: 'AAPL  250620C00150000', last_price: 3.25 }];
    await mount();
    await user.click(screen.getByRole('tab', { name: 'Options' }));
    await user.click(screen.getByRole('button', { name: 'Select from options chain' }));
    await user.click(screen.getByRole('button', { name: /Use AAPL/ }));

    expect(input('Entry price').value).toBe('3.25');
    expect(screen.getByText(/Selected contract:/)).toBeTruthy();
  });

  it('leaves entry blank with a manual-entry note when the contract has no last_price', async () => {
    const user = userEvent.setup();
    quote.contracts.current = [{ option_symbol: 'AAPL  250620C00150000' }];
    await mount();
    await user.click(screen.getByRole('tab', { name: 'Options' }));
    await user.click(screen.getByRole('button', { name: 'Select from options chain' }));
    await user.click(screen.getByRole('button', { name: /Use AAPL/ }));

    expect(input('Entry price').value).toBe('');
    expect(screen.getByText(/enter the premium manually/i)).toBeTruthy();
  });

  it('does not render a selection control for rows without an option_symbol', async () => {
    const user = userEvent.setup();
    quote.contracts.current = [{ label: 'no-occ-row' }];
    await mount();
    await user.click(screen.getByRole('tab', { name: 'Options' }));
    await user.click(screen.getByRole('button', { name: 'Select from options chain' }));

    expect(screen.getByText('no-occ-row')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Use/ })).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Buying-power cap basis (calculator-balance-sizing)
//
// The account below is the shape the whole feature exists for: $5,000 of equity
// with $4,000 already deployed, so only $1,000 is actually fundable. Entry $50 /
// stop $48 at 1% risk gives a 25-share budget ($1,250) that the balance would
// happily fund and the cash would not.
// -----------------------------------------------------------------------------

const DEPLOYED_ACCOUNT = {
  id: 'acc-deployed',
  name: 'Mostly Deployed',
  currency: 'USD',
  balance: '5000',
  cash: '1000',
  positionValue: '4000',
};

async function sizeAgainst(user: User, account: Record<string, unknown>): Promise<void> {
  setAccounts({ data: [account] });
  await mount();
  await switchBasis(user, 'Percent');
  fill('Entry price', '50');
  fill('Stop loss', '48');
  fill('Risk percent', '1');
  fireEvent.change(selectByOptionValue(account.id as string), {
    target: { value: account.id as string },
  });
  fireEvent.blur(input('Risk percent'));
}

describe('CalculatorForm — buying-power cap basis', () => {
  it('caps at the account cash under the default basis', async () => {
    const user = userEvent.setup();
    await sizeAgainst(user, DEPLOYED_ACCOUNT);

    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    // 20 shares = floor($1,000 cash / $50), not the 25 the budget alone allows.
    expect(screen.getByText('20')).toBeTruthy();
    expect(screen.getByText(/limited by account buying power/i)).toBeTruthy();
    // The risk budget is untouched — still 1% of the BALANCE, not of cash.
    expect(screen.getAllByText(fmtMoney(50)).length).toBeGreaterThan(0);
  });

  it('caps at the balance under the balance basis, funding more than the cash', async () => {
    const user = userEvent.setup();
    state.buyingPowerBasis.current = { data: { basis: 'balance' } };
    await sizeAgainst(user, DEPLOYED_ACCOUNT);

    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    // The full 25-share budget: $1,250 of stock against $1,000 of cash.
    expect(screen.getByText('25')).toBeTruthy();
    expect(screen.queryByText(/limited by account buying power/i)).toBeNull();
  });

  it('explains the cap on the form so it is not an unexplained smaller number', async () => {
    const user = userEvent.setup();
    await sizeAgainst(user, DEPLOYED_ACCOUNT);

    const note = screen.getByTestId('cap-basis-note');
    expect(note.textContent).toContain(fmtMoney(1000));
    expect(note.textContent).toMatch(/percent of the balance/i);
  });

  it('shows no cap note under the balance basis', async () => {
    const user = userEvent.setup();
    state.buyingPowerBasis.current = { data: { basis: 'balance' } };
    await sizeAgainst(user, DEPLOYED_ACCOUNT);

    expect(screen.queryByTestId('cap-basis-note')).toBeNull();
  });

  it('falls back to the balance for an account with no cash figure', async () => {
    // `cash` is optional on AccountSchema for fixtures predating the split.
    const user = userEvent.setup();
    await sizeAgainst(user, { ...DEPLOYED_ACCOUNT, cash: undefined });

    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    expect(screen.getByText('25')).toBeTruthy();
    expect(screen.queryByTestId('cap-basis-note')).toBeNull();
  });

  it('caps against the typed figure alone when the balance is hand-entered', async () => {
    // No account selected ⇒ no cash figure exists ⇒ the cap is the balance.
    const user = userEvent.setup();
    await mount();
    await fillPercentBasis(user, {
      entry: '50',
      stop: '48',
      balance: '5000',
      riskPercent: '1',
    });

    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    expect(screen.getByText('25')).toBeTruthy();
    expect(screen.queryByTestId('cap-basis-note')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Account picker on the dollar basis
//
// Same DEPLOYED_ACCOUNT: $5,000 equity, $1,000 cash. Entry $50 / stop $48 with a
// $1,000 dollar risk gives a 500-share budget ($25,000) — a direct dollar risk
// overshoots exactly as readily as a percentage one.
// -----------------------------------------------------------------------------

describe('CalculatorForm — dollar basis account sourcing', () => {
  it('offers the account picker on the dollar basis', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [DEPLOYED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Dollar');

    expect(selectByOptionValue(DEPLOYED_ACCOUNT.id)).toBeTruthy();
  });

  it('caps a dollar-basis size at the account cash', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [DEPLOYED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Dollar');

    fill('Entry price', '50');
    fill('Stop loss', '48');
    fill('Dollar risk', '1000');
    fireEvent.change(selectByOptionValue(DEPLOYED_ACCOUNT.id), {
      target: { value: DEPLOYED_ACCOUNT.id },
    });
    fireEvent.blur(input('Dollar risk'));

    // floor($1,000 cash / $50) = 20, not the 500 the risk alone allows.
    expect(await screen.findByText('20', undefined, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByText(/limited by account buying power/i)).toBeTruthy();
  });

  it('stays uncapped on the dollar basis with no account selected', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [DEPLOYED_ACCOUNT] });
    await mount();
    await results(user, 'Dollar', {
      'Entry price': '50',
      'Stop loss': '48',
      'Dollar risk': '1000',
    });

    expect(await screen.findByText('500', undefined, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText(/limited by account buying power/i)).toBeNull();
  });

  it('does NOT put a balance on the form in dollar mode', async () => {
    // A balance here would be a second risk basis. The schema's "exactly one
    // basis" refine would then reject the input the moment a risk percent
    // appeared, so the account must contribute only the cap and the currency.
    const user = userEvent.setup();
    setAccounts({ data: [DEPLOYED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Dollar');

    fireEvent.change(selectByOptionValue(DEPLOYED_ACCOUNT.id), {
      target: { value: DEPLOYED_ACCOUNT.id },
    });
    expect(screen.queryByLabelText('Balance')).toBeNull();

    // And the dollar basis still computes — proof the refine is satisfied.
    fill('Entry price', '50');
    fill('Stop loss', '48');
    fill('Dollar risk', '1000');
    fireEvent.blur(input('Dollar risk'));
    expect(await screen.findByText('20', undefined, { timeout: 2000 })).toBeTruthy();
  });

  it('keeps the account across a basis switch and re-seeds the balance', async () => {
    // Dropping the account on switch would silently remove the cap from someone
    // who only changed how they express risk.
    const user = userEvent.setup();
    setAccounts({ data: [DEPLOYED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Dollar');

    fireEvent.change(selectByOptionValue(DEPLOYED_ACCOUNT.id), {
      target: { value: DEPLOYED_ACCOUNT.id },
    });
    await switchBasis(user, 'Percent');

    // Still selected, and the Balance field is populated rather than left blank
    // next to a visibly-chosen account.
    expect(selectByOptionValue(DEPLOYED_ACCOUNT.id).value).toBe(DEPLOYED_ACCOUNT.id);
    expect(input('Balance').value).toBe('5000');
  });

  it('follows the account currency on the dollar basis', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [{ ...CAD_ACCOUNT, cash: '50000' }] });
    await mount();
    await switchBasis(user, 'Dollar');

    fill('Entry price', '50');
    fill('Stop loss', '48');
    fill('Dollar risk', '1000');
    fireEvent.change(selectByOptionValue(CAD_ACCOUNT.id), { target: { value: CAD_ACCOUNT.id } });
    fireEvent.blur(input('Dollar risk'));

    // Actual dollar risk 2 × 500 = 1000, rendered in CAD — showing a CAD
    // account's figures in USD would misstate them.
    await screen.findByText('Position Sizing', undefined, { timeout: 2000 });
    expect(screen.getAllByText(fmtMoney(1000, 'CAD')).length).toBeGreaterThan(0);
  });

  it('words the cap note for the dollar basis', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [DEPLOYED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Dollar');

    fireEvent.change(selectByOptionValue(DEPLOYED_ACCOUNT.id), {
      target: { value: DEPLOYED_ACCOUNT.id },
    });

    const note = screen.getByTestId('cap-basis-note');
    expect(note.textContent).toContain(fmtMoney(1000));
    // Not the percent-basis reassurance — there is no risk percentage here.
    expect(note.textContent).toMatch(/dollar risk is unchanged/i);
    expect(note.textContent).not.toMatch(/percent of the balance/i);
  });
});

// -----------------------------------------------------------------------------
// Account default risk percentage (user-onboarding R1.2/R1.3/R1.4)
//
// RULED_ACCOUNT: $50,000 balance, a 1.50% rule. Entry $50 / stop $48 is $2 of
// per-share risk, so the rule alone gives a $750 budget → 375 shares, and an
// override to 2% gives $1,000 → 500 shares. Both fund comfortably inside the
// $50,000 cap, so the cap never confounds the prefill assertions.
// -----------------------------------------------------------------------------

describe('CalculatorForm — account default risk prefill', () => {
  it('prefills the risk percent from the account rule and sizes against it (R1.2)', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [RULED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Percent');

    fill('Entry price', '50');
    fill('Stop loss', '48');
    // Neither the balance NOR the percent is typed — both come from the account.
    fireEvent.change(selectByOptionValue(RULED_ACCOUNT.id), {
      target: { value: RULED_ACCOUNT.id },
    });

    expect(input('Balance').value).toBe('50000');
    // The numeric(5,2)-normalised form, not the '1.5' someone typed into the dialog.
    expect(input('Risk percent').value).toBe('1.50');

    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    expect(screen.getAllByText(fmtMoney(750)).length).toBeGreaterThan(0);
    expect(screen.getByText('375')).toBeTruthy();
  });

  it('leaves the risk percent cleared for an account with no rule (R1.4)', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [CAD_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Percent');

    fireEvent.change(selectByOptionValue(CAD_ACCOUNT.id), { target: { value: CAD_ACCOUNT.id } });

    expect(input('Balance').value).toBe('50000');
    expect(input('Risk percent').value).toBe('');
  });

  it('does not disturb a typed risk percent when the account has no rule (R1.4)', async () => {
    // Every account predating the column has no rule, so this is the path every
    // existing user is on: selecting an account must behave exactly as it did.
    const user = userEvent.setup();
    setAccounts({ data: [CAD_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Percent');

    fill('Risk percent', '2');
    fireEvent.change(selectByOptionValue(CAD_ACCOUNT.id), { target: { value: CAD_ACCOUNT.id } });

    expect(input('Risk percent').value).toBe('2');
  });

  it('re-seeds the risk percent alongside the balance on a switch back to percent', async () => {
    const user = userEvent.setup();
    setAccounts({ data: [RULED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Dollar');

    // Selected on the dollar basis, where the account contributes only the cap —
    // no balance and no percent go on the form there.
    fireEvent.change(selectByOptionValue(RULED_ACCOUNT.id), {
      target: { value: RULED_ACCOUNT.id },
    });
    await switchBasis(user, 'Percent');

    expect(input('Balance').value).toBe('50000');
    expect(input('Risk percent').value).toBe('1.50');
  });

  it('overriding the prefilled percent changes only this calculation and issues NO request (R1.3)', async () => {
    // The load-bearing assertion of R1.3: the prefill is a READ path. Every API
    // call in the app goes through lib/api's single `fetch`, so a stubbed global
    // fetch catches a write-back however it were wired.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    setAccounts({ data: [RULED_ACCOUNT] });
    await mount();
    await switchBasis(user, 'Percent');

    fill('Entry price', '50');
    fill('Stop loss', '48');
    fireEvent.change(selectByOptionValue(RULED_ACCOUNT.id), {
      target: { value: RULED_ACCOUNT.id },
    });
    expect(input('Risk percent').value).toBe('1.50');

    // Override the rule for this one calculation.
    fireEvent.change(input('Risk percent'), { target: { value: '2' } });
    fireEvent.blur(input('Risk percent'));

    // Applied to THIS calculation: $1,000 of budget → 500 shares, not the 375 the
    // account's own 1.50% rule would have sized.
    await screen.findByText('Derived Dollar Risk', undefined, { timeout: 2000 });
    expect(screen.getAllByText(fmtMoney(1000)).length).toBeGreaterThan(0);
    expect(screen.getByText('500')).toBeTruthy();
    expect(screen.queryByText('375')).toBeNull();

    // …and NOT written back. No request of any kind left the form, and the
    // account's stored rule is untouched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(RULED_ACCOUNT.defaultRiskPercent).toBe('1.50');
  });
});
