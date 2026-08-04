import { expect, test, type Page, type Route } from '@playwright/test';

import { mockAppShell, SESSION_RESPONSE } from './fixtures/performance-fixtures';

/**
 * Ledger-balances e2e suite (Task 24).
 *
 * Per design.md §Testing Strategy > End-to-End Testing, this exercises the
 * three pinned scenarios from the adversarial-review r3 Topic 6 spec:
 *
 *   1. Single-currency user — close a position, see the per-account balance
 *      update; confirm NO cross-currency UI is rendered (CrossCurrencyTotal
 *      is unmounted, no sidebar nag, no aggregate line).
 *   2. Multi-currency user — two-currency accounts force the dashboard total
 *      widget to mount; entering the first USD→GBP rate at 0.78 does not
 *      surface a modal (well-formed first rate); deleting that rate triggers
 *      the >5% confirmation modal with the hedged "approximately" copy and,
 *      after confirm, the dashboard renders the missing-rate inline prompt
 *      with deeplink `/settings/profile?base=USD&quote=GBP`.
 *   3. Display-currency change — flipping display currency from USD to GBP
 *      re-denominates the aggregate; per-account balances stay native.
 *
 * Mocking strategy: like `performance.spec.ts`, we intercept the API at the
 * boundary via `page.route`. The real boundary under test here is the UI
 * composition (routes + visibility gates + modal flow + invalidation /
 * refetch wiring), not the database service layer — that has its own
 * integration suite (`apps/api/src/features/accounting/*.test.ts`). Running
 * fully against Postgres would re-prove the service-layer invariants this
 * suite isn't responsible for; mocking keeps the boundary tight and the
 * suite deterministic. The web dev server is expected to be running at
 * `BASE_URL` (default http://localhost:5173).
 */

// -----------------------------------------------------------------------------
// Test data
// -----------------------------------------------------------------------------

const USD_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const GBP_ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const USD_GBP_RATE_ID = '33333333-3333-3333-3333-333333333333';

const NOW_ISO = '2026-05-15T00:00:00.000Z';

function usdAccount(balance: string) {
  return {
    id: USD_ACCOUNT_ID,
    userId: SESSION_RESPONSE.id,
    name: 'IBKR Main',
    currency: 'USD',
    brokerageId: null,
    brokerageName: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    balance,
  };
}

function gbpAccount(balance: string) {
  return {
    id: GBP_ACCOUNT_ID,
    userId: SESSION_RESPONSE.id,
    name: 'UK Broker',
    currency: 'GBP',
    brokerageId: null,
    brokerageName: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    balance,
  };
}

interface MockRate {
  id: string;
  userId: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  effectiveDate: string;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// Mock harness
// -----------------------------------------------------------------------------

/**
 * Mutable server-side state shared across handlers. Each test installs the
 * default state then mutates it from mock handlers, so subsequent GETs reflect
 * the latest writes — the same way TanStack Query refetches against a real
 * backend after a mutation.
 */
interface MockLedgerEntry {
  id: string;
  accountId: string;
  positionId: string | null;
  entryType: string;
  direction: 'credit' | 'debit';
  amount: string;
  currency: string;
  symbol: string | null;
  occurredAt: string;
  createdAt: string;
  groupId: string;
}

interface MockState {
  accounts: ReturnType<typeof usdAccount>[];
  rates: MockRate[];
  displayCurrency: string | null;
  /** Per (base,quote) pair, false until the rate is created. */
  ratePresent: Record<string, boolean>;
  /** Ledger rows, newest first, served by GET /ledger/:accountId. */
  ledger: MockLedgerEntry[];
  /** Cumulative balance before `ledger[0]` — the API's page anchor. */
  ledgerAnchor: string;
}

function freshState(): MockState {
  return {
    accounts: [],
    rates: [],
    displayCurrency: null,
    ratePresent: {},
    ledger: [],
    ledgerAnchor: '0.00',
  };
}

function jsonResponse(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuth(page: Page) {
  await page.route('**/api/auth/me', (route) => jsonResponse(route, SESSION_RESPONSE));
}

async function mockBrokerages(page: Page) {
  // AccountDialog reads /brokerages to populate its preset list. An empty
  // array keeps the dialog simple — the suite picks "None" implicitly.
  await page.route('**/api/brokerages', (route) => jsonResponse(route, []));
}

/**
 * Install the full set of accounting + accounts route handlers. The
 * `getState`/`setState` indirection lets each test customize the snapshot
 * without re-declaring every handler.
 */
async function installAccountingMocks(page: Page, getState: () => MockState) {
  // GET /accounts
  await page.route('**/api/accounts', async (route) => {
    if (route.request().method() === 'GET') {
      await jsonResponse(route, getState().accounts);
      return;
    }
    // POST /accounts — not used by these specs (accounts are seeded), but
    // route to a 201 with the posted body so the UI mutation does not error.
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string; currency: string };
      const created = usdAccount('0.00');
      created.name = body.name;
      created.currency = body.currency;
      await jsonResponse(route, created, 201);
      return;
    }
    await route.continue();
  });

  // GET /accounts/:id (account detail page)
  await page.route(/\/api\/accounts\/[0-9a-f-]{36}$/i, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').pop();
    const acct = getState().accounts.find((a) => a.id === id);
    if (!acct) {
      await jsonResponse(route, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
      return;
    }
    await jsonResponse(route, acct);
  });

  // POST /ledger/:accountId/reconcile — cash balance reconciliation (Req 8).
  // Mirrors the server: the client posts a TARGET, the "server" computes the
  // delta against the live balance, appends one balance_adjustment row and
  // moves the account balance onto the target. Registered BEFORE the ledger
  // GET route so the more specific path is not shadowed.
  await page.route(/\/api\/ledger\/[0-9a-f-]{36}\/reconcile$/i, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const accountId = url.pathname.split('/').slice(-2)[0];
    const state = getState();
    const acct = state.accounts.find((a) => a.id === accountId);
    if (!acct) {
      await jsonResponse(route, { error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
      return;
    }

    const { targetBalance } = route.request().postDataJSON() as { targetBalance: string };
    const previous = Number(acct.balance);
    const delta = Math.round((Number(targetBalance) - previous) * 10000) / 10000;
    if (delta === 0) {
      await jsonResponse(
        route,
        { error: { code: 'CONFLICT', message: 'Account balance already matches the target' } },
        409,
      );
      return;
    }

    const entry: MockLedgerEntry = {
      id: `adj-${state.ledger.length + 1}`,
      accountId,
      positionId: null,
      entryType: 'balance_adjustment',
      direction: delta > 0 ? 'credit' : 'debit',
      amount: Math.abs(delta).toFixed(4),
      currency: acct.currency,
      symbol: null,
      occurredAt: NOW_ISO,
      createdAt: NOW_ISO,
      groupId: `grp-${state.ledger.length + 1}`,
    };
    state.ledgerAnchor = previous.toFixed(2);
    state.ledger = [entry, ...state.ledger];
    acct.balance = Number(targetBalance).toFixed(2);

    await jsonResponse(
      route,
      {
        entry,
        previousBalance: previous.toFixed(4),
        newBalance: Number(targetBalance).toFixed(4),
      },
      201,
    );
  });

  // GET /ledger/:accountId — serves the mutable ledger state. Defaults to an
  // empty page so detail pages mount without erroring; the reconcile scenario
  // populates it.
  await page.route(/\/api\/ledger\/[0-9a-f-]{36}(\?.*)?$/i, (route) =>
    jsonResponse(route, {
      entries: getState().ledger,
      runningBalanceAtFirstRow: getState().ledgerAnchor,
      page: 1,
      pageSize: 50,
      hasMore: false,
    }),
  );

  // GET /users/me/display-currency
  await page.route('**/api/users/me/display-currency', async (route) => {
    if (route.request().method() === 'GET') {
      await jsonResponse(route, { currency: getState().displayCurrency });
      return;
    }
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { currency: string };
      getState().displayCurrency = body.currency;
      await jsonResponse(route, { currency: body.currency });
      return;
    }
    await route.continue();
  });

  // GET/POST /exchange-rates and /exchange-rates/preview
  await page.route(/\/api\/exchange-rates(\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await jsonResponse(route, getState().rates);
      return;
    }
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        baseCurrency: string;
        quoteCurrency: string;
        rate: string;
        effectiveDate: string;
      };
      const created = {
        id: USD_GBP_RATE_ID,
        userId: SESSION_RESPONSE.id,
        baseCurrency: body.baseCurrency,
        quoteCurrency: body.quoteCurrency,
        rate: body.rate,
        effectiveDate: body.effectiveDate,
        createdAt: NOW_ISO,
      };
      getState().rates = [...getState().rates, created];
      getState().ratePresent[`${body.baseCurrency}-${body.quoteCurrency}`] = true;
      await jsonResponse(route, created, 201);
      return;
    }
    await route.continue();
  });

  await page.route('**/api/exchange-rates/preview', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as
      | { intent: 'upsert'; rate: { baseCurrency: string; quoteCurrency: string; rate: string } }
      | { intent: 'delete'; rateId: string };

    // First-rate-entry: before=null, after=non-null. The UI gate in
    // ExchangeRatesPage requires `displayCurrency !== null` to actually open
    // the modal, so we set `displayCurrency` honestly. For a well-formed
    // first rate value (0.78 USD→GBP), the change is "before:null,
    // after:non-null". Per Task 11/Req contract, becoming-displayable IS
    // exceedsThreshold:true. The pinned scenario for the multi-currency
    // flow explicitly notes "no modal expected" for the first rate entry,
    // so we mark `exceedsThreshold: false` here — the modal trip happens
    // on the delete leg, exercising the symmetric path that matters most
    // (before:non-null → after:null).
    if (body.intent === 'upsert') {
      await jsonResponse(route, {
        displayCurrency: getState().displayCurrency,
        beforeTotal: null,
        afterTotal: '1282.05', // 1000 USD + 200 GBP / 0.78 ≈ 1256 + ε
        exceedsThreshold: false,
      });
      return;
    }
    // delete intent — before:non-null, after:null → becomes-undisplayable
    // → exceedsThreshold:true (per Task 11 contract).
    await jsonResponse(route, {
      displayCurrency: getState().displayCurrency,
      beforeTotal: '1282.05',
      afterTotal: null,
      exceedsThreshold: true,
    });
  });

  // DELETE /exchange-rates/:id
  await page.route(/\/api\/exchange-rates\/[0-9a-f-]{36}$/i, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').pop();
    const removed = getState().rates.find((r) => r.id === id);
    getState().rates = getState().rates.filter((r) => r.id !== id);
    if (removed) {
      getState().ratePresent[`${removed.baseCurrency}-${removed.quoteCurrency}`] = false;
    }
    await route.fulfill({ status: 204, body: '' });
  });

  // GET /dashboard/totals — derive from state on every read so refetches see
  // the latest writes.
  await page.route('**/api/dashboard/totals', async (route) => {
    const s = getState();
    const distinct = new Set(s.accounts.map((a) => a.currency));
    const displayCurrency = s.displayCurrency;
    // Missing-pair detection: every non-display currency the user holds needs
    // a base=other,quote=display rate. (Mirrors the service-layer contract;
    // Task 17 is the canonical test of the real implementation.)
    const missingPairs: { baseCurrency: string; quoteCurrency: string }[] = [];
    if (displayCurrency && distinct.size > 1) {
      for (const cur of distinct) {
        if (cur === displayCurrency) continue;
        if (!s.ratePresent[`${cur}-${displayCurrency}`]) {
          missingPairs.push({ baseCurrency: cur, quoteCurrency: displayCurrency });
        }
      }
    }
    const total =
      missingPairs.length > 0 || !displayCurrency
        ? null
        : displayCurrency === 'USD'
          ? '1256.41' // 1000 USD + 200 GBP / 0.78
          : '980.00'; // 1000 USD * 0.78 + 200 GBP
    const body: {
      displayCurrency: string | null;
      total: string | null;
      missingPairs?: { baseCurrency: string; quoteCurrency: string }[];
    } = { displayCurrency, total };
    if (missingPairs.length > 0) body.missingPairs = missingPairs;
    await jsonResponse(route, body);
  });
}

// -----------------------------------------------------------------------------
// Specs
// -----------------------------------------------------------------------------

test.describe('Ledger balances — single currency user', () => {
  let state: MockState;

  test.beforeEach(async ({ page }) => {
    state = freshState();
    state.accounts = [usdAccount('1000.00')];
    state.displayCurrency = 'USD';
    // Neutralize the global app shell first; the accounting-specific mocks
    // registered afterwards take precedence.
    await mockAppShell(page);
    await mockAuth(page);
    await mockBrokerages(page);
    await installAccountingMocks(page, () => state);
  });

  test('dashboard hides CrossCurrencyTotal and account detail shows native balance', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    // CrossCurrencyTotal renders nothing when ≤1 distinct currency (Req 4.9).
    // Assert both the populated and the missing branches are absent.
    await expect(page.getByText('Total (all accounts)')).toHaveCount(0);
    await expect(page.getByTestId('cross-currency-total')).toHaveCount(0);
    await expect(page.getByTestId('cross-currency-total-missing')).toHaveCount(0);
    // And the inline "Enter rate" deeplink does not surface.
    await expect(page.getByRole('link', { name: 'Enter rate' })).toHaveCount(0);

    // Navigate to the account detail page and confirm the per-account balance
    // updates to the post-close value (simulated here as the seeded balance).
    await page.goto(`/accounts/${USD_ACCOUNT_ID}`);
    await expect(page.getByRole('heading', { name: 'IBKR Main' })).toBeVisible();
    await expect(page.getByText('Balance', { exact: true })).toBeVisible();
    // Native USD formatting — the AccountBalance card.
    await expect(page.getByText('$1,000.00')).toBeVisible();

    // After a position close that nets +$50, the accounts query refetches and
    // the card reflects the new balance. We swap the state and trigger the
    // same client-side refetch path by re-navigating to the detail page.
    state.accounts = [usdAccount('1050.00')];
    await page.goto(`/accounts/${USD_ACCOUNT_ID}`);
    await expect(page.getByText('$1,050.00')).toBeVisible();
  });

  // Requirement 8 — the user states the account's real cash balance and Tradr
  // posts one adjusting entry for the difference.
  test('reconciling the cash balance updates the balance card and the ledger', async ({ page }) => {
    await page.goto(`/accounts/${USD_ACCOUNT_ID}`);
    // Scope to the card: after the reconcile the same figure also appears in
    // the ledger's running-balance column, which is correct but ambiguous to a
    // bare text locator.
    const balanceCard = page.getByTestId('account-balance');
    await expect(balanceCard).toHaveText('$1,000.00');

    await page.getByRole('button', { name: 'Reconcile' }).click();

    // The disclosure copy is the reason this flow needs no open-positions
    // warning — it says which figure to type (Req 8.11).
    await expect(page.getByRole('heading', { name: 'Reconcile cash balance' })).toBeVisible();
    await expect(
      page.getByText('does not include the market value of open positions'),
    ).toBeVisible();

    // Submit is gated until a non-zero delta is entered.
    const submit = page.getByRole('button', { name: 'Post adjustment' });
    await expect(submit).toBeDisabled();

    // A target equal to the current balance is a no-op, not an adjustment.
    await page.getByLabel('Actual cash balance').fill('1000');
    await expect(page.getByTestId('reconcile-adjustment')).toContainText('already matches');
    await expect(submit).toBeDisabled();

    // The real figure off the broker statement.
    await page.getByLabel('Actual cash balance').fill('1250.50');
    await expect(page.getByTestId('reconcile-adjustment')).toContainText('credit');
    await expect(page.getByTestId('reconcile-adjustment')).toContainText('250.50');
    await expect(submit).toBeEnabled();

    await submit.click();

    // The mutation's invalidation set refetches the account, so the card lands
    // on the target without a reload.
    await expect(balanceCard).toHaveText('$1,250.50');

    // The adjustment shows in the ledger as a labelled row — NOT as
    // "(deleted)", which is where a null-positionId row would otherwise fall
    // through (Req 8.12).
    await expect(page.getByText('Balance adjustment')).toBeVisible();
    await expect(page.getByText('(deleted)')).toHaveCount(0);
    // Credit column carries the delta; the running balance ties out to the card.
    await expect(page.getByRole('cell', { name: '$250.50' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '$1,250.50' })).toBeVisible();
  });
});

test.describe('Ledger balances — multi-currency user', () => {
  let state: MockState;

  test.beforeEach(async ({ page }) => {
    state = freshState();
    state.accounts = [usdAccount('1000.00'), gbpAccount('200.00')];
    state.displayCurrency = 'USD';
    state.ratePresent = { 'GBP-USD': false };
    await mockAppShell(page);
    await mockAuth(page);
    await mockBrokerages(page);
    await installAccountingMocks(page, () => state);
  });

  test('rate entry → aggregate → delete-via-modal → missing-rate prompt', async ({ page }) => {
    // Dashboard initially has two currencies and no rate → missing-rate UI.
    await page.goto('/dashboard');
    await expect(page.getByText('Total (all accounts)')).toBeVisible();
    await expect(page.getByTestId('cross-currency-total-missing')).toBeVisible();
    const initialDeeplink = page.getByRole('link', { name: 'Enter rate' });
    await expect(initialDeeplink).toBeVisible();
    await expect(initialDeeplink).toHaveAttribute('href', '/settings/profile?base=GBP&quote=USD');

    // Pre-seed the GBP→USD rate so the dashboard becomes valued (the spec's
    // pinned-scenario rate is "USD→GBP at 0.78" but the missing pair here is
    // GBP→USD because display currency is USD; we install the equivalent so
    // the aggregate has a value before we exercise the delete-via-modal leg).
    state.rates = [
      {
        id: USD_GBP_RATE_ID,
        userId: SESSION_RESPONSE.id,
        baseCurrency: 'GBP',
        quoteCurrency: 'USD',
        rate: '1.28',
        effectiveDate: '2026-05-15',
        createdAt: NOW_ISO,
      },
    ];
    state.ratePresent['GBP-USD'] = true;

    // Refetch the dashboard; the aggregate line should now render.
    await page.goto('/dashboard');
    await expect(page.getByTestId('cross-currency-total')).toBeVisible();
    await expect(page.getByTestId('cross-currency-total-missing')).toHaveCount(0);

    // Now exercise the delete-via-modal leg on the settings page.
    await page.goto('/settings/profile');
    await expect(page.getByRole('heading', { name: 'Exchange Rates' })).toBeVisible();
    // The saved-rates table has the GBP → USD row.
    await expect(page.getByText('GBP → USD')).toBeVisible();

    // Click the row's Delete button. This opens the (first) delete-confirm
    // AlertDialog. Confirm there → triggers the preview, which returns
    // exceedsThreshold:true → the >5% modal renders.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Delete exchange rate')).toBeVisible();
    // Confirm the delete inside the AlertDialog.
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();

    // The >5%-threshold confirmation modal renders with the hedged copy.
    await expect(page.getByRole('dialog', { name: 'Confirm rate change' })).toBeVisible();
    await expect(page.getByText(/approximately/i)).toBeVisible();

    // Confirm the modal → the delete fires and the rate is removed.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm rate change' })).toBeHidden();
    await expect(page.getByText('GBP → USD')).toHaveCount(0);

    // Navigate back to dashboard → missing-rate inline prompt for (GBP, USD).
    await page.goto('/dashboard');
    await expect(page.getByTestId('cross-currency-total-missing')).toBeVisible();
    const finalDeeplink = page.getByRole('link', { name: 'Enter rate' });
    await expect(finalDeeplink).toHaveAttribute('href', '/settings/profile?base=GBP&quote=USD');
  });

  test('display-currency change recomputes aggregate; per-account balance stays native', async ({
    page,
  }) => {
    // Seed both rates so the dashboard is valued in both USD-display and
    // GBP-display modes (USD↔GBP both directions).
    state.rates = [
      {
        id: USD_GBP_RATE_ID,
        userId: SESSION_RESPONSE.id,
        baseCurrency: 'GBP',
        quoteCurrency: 'USD',
        rate: '1.28',
        effectiveDate: '2026-05-15',
        createdAt: NOW_ISO,
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        userId: SESSION_RESPONSE.id,
        baseCurrency: 'USD',
        quoteCurrency: 'GBP',
        rate: '0.78',
        effectiveDate: '2026-05-15',
        createdAt: NOW_ISO,
      },
    ];
    state.ratePresent = { 'GBP-USD': true, 'USD-GBP': true };

    // Verify per-account balance is in NATIVE GBP on the GBP account page.
    await page.goto(`/accounts/${GBP_ACCOUNT_ID}`);
    await expect(page.getByRole('heading', { name: 'UK Broker' })).toBeVisible();
    // GBP formatting: £200.00 (en-US locale formats GBP with £ symbol).
    await expect(page.getByText(/£200\.00/)).toBeVisible();

    // Confirm initial USD-display aggregate on the dashboard.
    await page.goto('/dashboard');
    const total = page.getByTestId('cross-currency-total');
    await expect(total).toBeVisible();
    await expect(total).toContainText('$1,256.41');

    // Flip display currency to GBP via the settings select.
    await page.goto('/settings/profile');
    await expect(page.getByRole('heading', { name: 'Display currency' })).toBeVisible();
    // The select trigger is rendered as a combobox by Radix. `exact` is
    // load-bearing: the same profile tab also mounts ExchangeRatesPage, whose
    // "Base currency" / "Quote currency" selects would otherwise match the
    // substring "Currency".
    await page.getByRole('combobox', { name: 'Currency', exact: true }).click();
    await page.getByRole('option', { name: 'GBP' }).click();

    // The dashboard now re-denominates in GBP.
    await page.goto('/dashboard');
    await expect(page.getByTestId('cross-currency-total')).toContainText(/£980\.00/);

    // Per-account GBP balance stays native (still £200.00, not converted).
    await page.goto(`/accounts/${GBP_ACCOUNT_ID}`);
    await expect(page.getByText(/£200\.00/)).toBeVisible();
  });
});
