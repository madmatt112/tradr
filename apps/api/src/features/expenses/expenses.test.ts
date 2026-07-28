import { and, eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

import app, { bootstrap } from '@/app';
import { db } from '@/db';
import { ledgerEntries } from '@/db/schema/accounting.schema';
import { expenses } from '@/db/schema/expenses.schema';
import { positions } from '@/db/schema/positions.schema';
import { sessions, users } from '@/db/schema/users.schema';
import { unregisterCloseHook } from '@/features/positions/positions.service';

// Install the production 'ledger' close hook so position closes emit
// `position_pnl` ledger entries (the tax-summary tests below read those rows).
// Mirrors the bootstrap-and-cleanup pattern in `accounting.test.ts`.
beforeAll(() => {
  // .catch swallows the async advisor-startup tail's rejection: in tests `@/db`
  // is mocked to `undefined` outside the per-test tx window, so the
  // fire-and-forget decrypt-canary would otherwise leak an unhandled rejection
  // and fail `pnpm test`. The synchronous prelude (Decimal pin + ledger hook) —
  // all this file needs — has already run by the time .catch attaches.
  bootstrap().catch(() => {});
});

afterAll(() => {
  unregisterCloseHook('ledger');
});

// ---------------------------------------------------------------------------
// HTTP fixture helpers (mirror accounting.test.ts)
// ---------------------------------------------------------------------------

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `exp-int${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 600;
function uniqueIp() {
  return `10.6.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<{ cookie: string }> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  expect(cookie).toBeDefined();
  return { cookie };
}

function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = {
    Cookie: `session=${cookie}`,
    'X-Forwarded-For': uniqueIp(),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

type CreateExpenseOverrides = Partial<{
  category: string;
  description: string;
  amount: string;
  currency: string;
  occurredAt: string;
  notes: string | null;
}>;

async function createExpense(cookie: string, overrides: CreateExpenseOverrides = {}) {
  const body = {
    category: 'software',
    description: 'Test expense',
    amount: '10.00',
    currency: 'USD',
    occurredAt: '2026-06-15',
    ...overrides,
  };
  const res = await authedRequest('POST', '/api/expenses', cookie, body);
  expect(res.status).toBe(201);
  return res.json();
}

// ---------------------------------------------------------------------------
// Expense CRUD end-to-end
// ---------------------------------------------------------------------------

describe('Expense CRUD end-to-end', () => {
  it('POST /api/expenses returns 201 with the row', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/expenses', cookie, {
      category: 'software',
      description: 'IDE license',
      amount: '99.00',
      currency: 'USD',
      occurredAt: '2026-03-15',
      notes: 'annual',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.category).toBe('software');
    expect(body.description).toBe('IDE license');
    // Postgres numeric(18,4) preserves trailing zeros — the route emits the
    // raw column string, so '99.00' input round-trips as '99.0000'.
    expect(body.amount).toBe('99.0000');
    expect(body.currency).toBe('USD');
    expect(body.occurredAt).toBe('2026-03-15');
    expect(body.notes).toBe('annual');
    expect(typeof body.createdAt).toBe('string');
    expect(typeof body.updatedAt).toBe('string');
  });

  it('GET LIST with ?year= filters correctly', async () => {
    const { cookie } = await registerAndGetCookie();
    // Past dates have no lower bound; future is capped to today + 365d, so use
    // a near-future date for the next-year fixture.
    await createExpense(cookie, { occurredAt: '2025-06-01', description: 'prev year' });
    await createExpense(cookie, { occurredAt: '2026-06-01', description: 'this year' });
    await createExpense(cookie, { occurredAt: '2027-01-15', description: 'next year' });

    const res = await authedRequest('GET', '/api/expenses?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0].description).toBe('this year');
    expect(body.filterTotals.year).toBe(2026);
    expect(body.filterTotals.totalRowCount).toBe(1);
  });

  it('PATCH /api/expenses/:id updates the row', async () => {
    const { cookie } = await registerAndGetCookie();
    const created = await createExpense(cookie, { amount: '10.00', description: 'original' });
    const res = await authedRequest('PATCH', `/api/expenses/${created.id}`, cookie, {
      description: 'updated',
      amount: '25.50',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.description).toBe('updated');
    expect(body.amount).toBe('25.5000');
    // Unchanged fields preserved.
    expect(body.category).toBe(created.category);
    expect(body.currency).toBe(created.currency);
  });

  it('DELETE /api/expenses/:id returns 204; subsequent PATCH returns 404', async () => {
    const { cookie } = await registerAndGetCookie();
    const created = await createExpense(cookie);
    const del = await authedRequest('DELETE', `/api/expenses/${created.id}`, cookie);
    expect(del.status).toBe(204);
    // No GET-single endpoint exists; use a follow-up PATCH which goes through
    // the same userId+id scoping and throws NotFoundError → 404.
    const patch = await authedRequest('PATCH', `/api/expenses/${created.id}`, cookie, {
      description: 'should not exist',
    });
    expect(patch.status).toBe(404);
  });

  it('LIST pagination: 250 expenses → page 0 returns 100 hasMore:true; page 2 returns 50 hasMore:false', async () => {
    const { cookie } = await registerAndGetCookie();

    // 250 expenses across a year window — use rotating dates so occurredAt
    // differs and ordering is deterministic.
    for (let i = 0; i < 250; i++) {
      const day = (i % 28) + 1;
      const month = (Math.floor(i / 28) % 12) + 1;
      const occurredAt = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      await createExpense(cookie, {
        occurredAt,
        description: `row-${i}`,
        amount: '1.00',
      });
    }

    const p0 = await authedRequest('GET', '/api/expenses?page=0&pageSize=100', cookie);
    expect(p0.status).toBe(200);
    const p0Body = await p0.json();
    expect(p0Body.expenses).toHaveLength(100);
    expect(p0Body.hasMore).toBe(true);
    expect(p0Body.page).toBe(0);
    expect(p0Body.pageSize).toBe(100);

    const p2 = await authedRequest('GET', '/api/expenses?page=2&pageSize=100', cookie);
    expect(p2.status).toBe(200);
    const p2Body = await p2.json();
    expect(p2Body.expenses).toHaveLength(50);
    expect(p2Body.hasMore).toBe(false);
    // filterTotals reflects all 250 across all years (no year filter set).
    expect(p2Body.filterTotals.totalRowCount).toBe(250);
  });

  it('LIST ordering: occurredAt DESC, createdAt DESC', async () => {
    const { cookie } = await registerAndGetCookie();
    // Resolve userId via direct DB lookup so we can stamp explicit createdAt
    // values. `now()` is transaction-scoped under the SAVEPOINT-per-test
    // pattern, so HTTP-driven inserts in the same test share createdAt and
    // can't exercise the secondary sort. Direct inserts let us assert the
    // (occurredAt DESC, createdAt DESC) ordering deterministically.
    const probe = await authedRequest('POST', '/api/expenses', cookie, {
      category: 'software',
      description: 'probe',
      amount: '1.00',
      currency: 'USD',
      occurredAt: '2026-01-01',
    });
    const probeBody = await probe.json();
    const userId = probeBody.userId as string;

    await db.insert(expenses).values([
      {
        userId,
        category: 'software',
        description: 'oldest',
        amount: '1.00',
        currency: 'USD',
        occurredAt: '2026-01-15',
        createdAt: new Date('2026-01-15T10:00:00Z'),
        updatedAt: new Date('2026-01-15T10:00:00Z'),
      },
      {
        userId,
        category: 'software',
        description: 'middle',
        amount: '1.00',
        currency: 'USD',
        occurredAt: '2026-06-15',
        createdAt: new Date('2026-06-15T10:00:00Z'),
        updatedAt: new Date('2026-06-15T10:00:00Z'),
      },
      {
        userId,
        category: 'software',
        description: 'newest',
        amount: '1.00',
        currency: 'USD',
        occurredAt: '2026-12-15',
        createdAt: new Date('2026-12-15T10:00:00Z'),
        updatedAt: new Date('2026-12-15T10:00:00Z'),
      },
      // Same occurredAt, distinct createdAt — tests the secondary DESC sort.
      {
        userId,
        category: 'software',
        description: 'tie-a',
        amount: '1.00',
        currency: 'USD',
        occurredAt: '2026-08-15',
        createdAt: new Date('2026-08-15T10:00:00Z'),
        updatedAt: new Date('2026-08-15T10:00:00Z'),
      },
      {
        userId,
        category: 'software',
        description: 'tie-b',
        amount: '1.00',
        currency: 'USD',
        occurredAt: '2026-08-15',
        createdAt: new Date('2026-08-15T11:00:00Z'),
        updatedAt: new Date('2026-08-15T11:00:00Z'),
      },
    ]);

    const res = await authedRequest('GET', '/api/expenses?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    // probe ('2026-01-01') + 5 inserted = 6 rows in 2026.
    expect(body.expenses).toHaveLength(6);
    expect(body.expenses[0].description).toBe('newest'); // 12-15
    expect(body.expenses[1].description).toBe('tie-b'); // 08-15 later createdAt
    expect(body.expenses[2].description).toBe('tie-a'); // 08-15 earlier createdAt
    expect(body.expenses[3].description).toBe('middle'); // 06-15
    expect(body.expenses[4].description).toBe('oldest'); // 01-15
    expect(body.expenses[5].description).toBe('probe'); // 01-01
  });

  it('LIST filterTotals shows FULL year totals (not page-scoped) — post-v2-fix #4', async () => {
    const { cookie } = await registerAndGetCookie();

    // 5 USD expenses ($20 each = $100) + 3 EUR expenses (€10 each = €30) in 2026.
    for (let i = 0; i < 5; i++) {
      await createExpense(cookie, {
        occurredAt: `2026-02-${String(i + 1).padStart(2, '0')}`,
        amount: '20.00',
        currency: 'USD',
        description: `usd-${i}`,
      });
    }
    for (let i = 0; i < 3; i++) {
      await createExpense(cookie, {
        occurredAt: `2026-03-${String(i + 1).padStart(2, '0')}`,
        amount: '10.00',
        currency: 'EUR',
        description: `eur-${i}`,
      });
    }

    const res = await authedRequest('GET', '/api/expenses?year=2026&page=0&pageSize=2', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Page contains only 2 rows — but filterTotals covers the whole year.
    expect(body.expenses).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.filterTotals.totalRowCount).toBe(8);

    const byCurrency = new Map<string, string>(
      body.filterTotals.perCurrency.map((r: { currency: string; total: string }) => [
        r.currency,
        r.total,
      ]),
    );
    expect(byCurrency.get('USD')).toBe('100.0000');
    expect(byCurrency.get('EUR')).toBe('30.0000');
  });

  it('LIST filterTotals.totalRowCount is a TS number (v2-3 ::int cast contract)', async () => {
    const { cookie } = await registerAndGetCookie();
    await createExpense(cookie, { occurredAt: '2026-04-01', description: 'one' });
    await createExpense(cookie, { occurredAt: '2026-04-02', description: 'two' });

    const res = await authedRequest('GET', '/api/expenses?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.filterTotals.totalRowCount).toBe('number');
    expect(body.filterTotals.totalRowCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cross-user isolation
// ---------------------------------------------------------------------------

describe('Cross-user isolation', () => {
  it("User A's expenses don't appear in user B's LIST", async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();

    await createExpense(cookieA, { description: 'A only', amount: '11.00' });
    await createExpense(cookieB, { description: 'B only', amount: '22.00' });

    const resA = await authedRequest('GET', '/api/expenses', cookieA);
    const bodyA = await resA.json();
    expect(bodyA.expenses).toHaveLength(1);
    expect(bodyA.expenses[0].description).toBe('A only');

    const resB = await authedRequest('GET', '/api/expenses', cookieB);
    const bodyB = await resB.json();
    expect(bodyB.expenses).toHaveLength(1);
    expect(bodyB.expenses[0].description).toBe('B only');
  });

  it("User B can't PATCH or DELETE user A's expense (404 each)", async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();
    const aExpense = await createExpense(cookieA, { description: 'A private' });

    // PATCH as B → 404
    const patchRes = await authedRequest('PATCH', `/api/expenses/${aExpense.id}`, cookieB, {
      description: 'hijack',
    });
    expect(patchRes.status).toBe(404);

    // DELETE as B → 404
    const delRes = await authedRequest('DELETE', `/api/expenses/${aExpense.id}`, cookieB);
    expect(delRes.status).toBe(404);

    // Row still belongs to A unchanged.
    const listA = await authedRequest('GET', '/api/expenses', cookieA);
    const bodyA = await listA.json();
    expect(bodyA.expenses).toHaveLength(1);
    expect(bodyA.expenses[0].id).toBe(aExpense.id);
    expect(bodyA.expenses[0].description).toBe('A private');
  });
});

// ---------------------------------------------------------------------------
// Fee-rollup fixture helpers (HTTP-driven where possible; direct DB for
// users.display_currency override since first-account materialization races
// would otherwise pin USD).
// ---------------------------------------------------------------------------

async function getMe(cookie: string): Promise<{ id: string }> {
  const res = await authedRequest('GET', '/api/auth/me', cookie);
  expect(res.status).toBe(200);
  const data = await res.json();
  return data.user ?? data;
}

async function createAccount(cookie: string, name: string, currency: string) {
  const res = await authedRequest('POST', '/api/accounts', cookie, { name, currency });
  expect(res.status).toBe(201);
  return res.json();
}

async function createPositionFor(
  cookie: string,
  accountId: string,
  overrides: { symbol?: string; side?: 'long' | 'short'; assetType?: 'stock' | 'option' } = {},
) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: overrides.symbol ?? 'AAPL',
    side: overrides.side ?? 'long',
    assetType: overrides.assetType ?? 'stock',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function addFillFor(
  cookie: string,
  positionId: string,
  data: { type: 'entry' | 'exit'; price: string; quantity: string; fees: string; filledAt: string },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, data);
  expect(res.status).toBe(201);
  return res.json();
}

async function openPositionFor(cookie: string, positionId: string, openedAt: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {
    openedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function closePositionFor(cookie: string, positionId: string, closedAt: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/close`, cookie, {
    closedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function createExchangeRate(
  cookie: string,
  data: { baseCurrency: string; quoteCurrency: string; rate: string; effectiveDate: string },
) {
  const res = await authedRequest('POST', '/api/exchange-rates', cookie, data);
  expect(res.status).toBe(201);
  return res.json();
}

/**
 * Force the user's display_currency to a known value. The accounts-service
 * materializes display_currency to the first account's currency, so when a
 * test needs a specific display currency that differs from the first account
 * (or wants to set it before creating any account) we update directly.
 */
async function setDisplayCurrency(userId: string, currency: string | null) {
  await db.update(users).set({ displayCurrency: currency }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// GET /api/expenses/fee-rollup
// ---------------------------------------------------------------------------

describe('GET /api/expenses/fee-rollup', () => {
  it('groups across two accounts and two asset types; perCurrencyTotals sum; grandTotal converts via year-end spots', async () => {
    const { cookie } = await registerAndGetCookie();
    const me = await getMe(cookie);

    // First account materializes user.display_currency = USD.
    const acctUsd = await createAccount(cookie, 'USD acct', 'USD');
    const acctEur = await createAccount(cookie, 'EUR acct', 'EUR');

    // Account 1 (USD): one stock position with $5 entry fee + $3 exit fee,
    // and one option position with $7 entry fee.
    const usdStock = await createPositionFor(cookie, acctUsd.id, {
      symbol: 'AAPL',
      assetType: 'stock',
    });
    await addFillFor(cookie, usdStock.id, {
      type: 'entry',
      price: '100',
      quantity: '1',
      fees: '5.00',
      filledAt: '2026-03-01T15:00:00Z',
    });
    await openPositionFor(cookie, usdStock.id, '2026-03-01T15:00:00Z');
    await addFillFor(cookie, usdStock.id, {
      type: 'exit',
      price: '110',
      quantity: '1',
      fees: '3.00',
      filledAt: '2026-04-01T15:00:00Z',
    });
    await closePositionFor(cookie, usdStock.id, '2026-04-01T15:00:00Z');

    const usdOption = await createPositionFor(cookie, acctUsd.id, {
      symbol: 'AAPL260620C100',
      assetType: 'option',
    });
    await addFillFor(cookie, usdOption.id, {
      type: 'entry',
      price: '2.5',
      quantity: '1',
      fees: '7.00',
      filledAt: '2026-05-01T15:00:00Z',
    });
    await openPositionFor(cookie, usdOption.id, '2026-05-01T15:00:00Z');

    // Account 2 (EUR): one stock position with €4 entry fee.
    const eurStock = await createPositionFor(cookie, acctEur.id, {
      symbol: 'SAP',
      assetType: 'stock',
    });
    await addFillFor(cookie, eurStock.id, {
      type: 'entry',
      price: '100',
      quantity: '1',
      fees: '4.00',
      filledAt: '2026-06-01T15:00:00Z',
    });
    await openPositionFor(cookie, eurStock.id, '2026-06-01T15:00:00Z');

    // EUR → USD spot rate for grand-total conversion. `findSpotRate` uses
    // `min(now, year-12-31)` as the upper bound; pick a date <= today so the
    // rate is picked up in a current-year query.
    await createExchangeRate(cookie, {
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.10',
      effectiveDate: '2026-01-01',
    });

    // displayCurrency was materialized to USD by createAccount above.
    expect(me.id).toBeDefined();

    const res = await authedRequest('GET', '/api/expenses/fee-rollup?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.year).toBe(2026);

    // totalsByAccount: one row per account (currency is account-scoped, asset
    // types are bucketed into stockFees / optionsFees on the same row).
    expect(body.totalsByAccount).toHaveLength(2);
    const byAccountName = new Map<string, (typeof body.totalsByAccount)[number]>(
      body.totalsByAccount.map((r: { accountName: string }) => [r.accountName, r]),
    );

    const usdRow = byAccountName.get('USD acct')!;
    expect(usdRow.accountId).toBe(acctUsd.id);
    expect(usdRow.currency).toBe('USD');
    expect(usdRow.stockFees).toBe('8.00'); // 5 + 3
    expect(usdRow.optionsFees).toBe('7.00');
    expect(usdRow.totalFees).toBe('15.00');

    const eurRow = byAccountName.get('EUR acct')!;
    expect(eurRow.accountId).toBe(acctEur.id);
    expect(eurRow.currency).toBe('EUR');
    expect(eurRow.stockFees).toBe('4.00');
    expect(eurRow.optionsFees).toBe('0.00');
    expect(eurRow.totalFees).toBe('4.00');

    // perCurrencyTotals: USD = 15, EUR = 4.
    const perCurrency = new Map<string, string>(
      body.perCurrencyTotals.map((r: { currency: string; totalFees: string }) => [
        r.currency,
        r.totalFees,
      ]),
    );
    expect(perCurrency.get('USD')).toBe('15.00');
    expect(perCurrency.get('EUR')).toBe('4.00');

    // grandTotal in USD: 15 + 4 * 1.10 = 19.40.
    expect(body.grandTotal).not.toBeNull();
    expect(body.grandTotal.displayCurrency).toBe('USD');
    expect(body.grandTotal.totalFees).toBe('19.40');
    expect(body.grandTotal.convertedCurrencies).toEqual(['EUR']);
    expect(body.grandTotal.excludedCurrencies).toEqual([]);

    // usedRates carries the EUR→USD rate; missingRates empty.
    expect(body.usedRates).toHaveLength(1);
    expect(body.usedRates[0]).toMatchObject({
      base: 'EUR',
      quote: 'USD',
      effectiveDate: '2026-01-01',
    });
    expect(body.missingRates).toEqual([]);
    expect(typeof body.ratesAsOf).toBe('string');
    expect(typeof body.disclaimer).toBe('string');
    expect(body.disclaimer.length).toBeGreaterThan(0);
  });

  it('returns empty-shape on no fills (Req 3.3)', async () => {
    const { cookie } = await registerAndGetCookie();
    // No account, no positions, no fills.
    const res = await authedRequest('GET', '/api/expenses/fee-rollup?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.year).toBe(2026);
    expect(body.totalsByAccount).toEqual([]);
    expect(body.perCurrencyTotals).toEqual([]);
    expect(body.usedRates).toEqual([]);
    expect(body.missingRates).toEqual([]);
    expect(body.grandTotal).toBeNull();
    expect(body.ratesAsOf).toBeNull();
    expect(typeof body.disclaimer).toBe('string');
    expect(body.disclaimer.length).toBeGreaterThan(0);
  });

  it('includes fills from both open and closed positions (Req 3.2)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'Mixed acct', 'USD');

    // Closed position: entry fee $2, exit fee $1.
    const closed = await createPositionFor(cookie, acct.id, {
      symbol: 'CLOSED',
      assetType: 'stock',
    });
    await addFillFor(cookie, closed.id, {
      type: 'entry',
      price: '50',
      quantity: '1',
      fees: '2.00',
      filledAt: '2026-02-01T15:00:00Z',
    });
    await openPositionFor(cookie, closed.id, '2026-02-01T15:00:00Z');
    await addFillFor(cookie, closed.id, {
      type: 'exit',
      price: '60',
      quantity: '1',
      fees: '1.00',
      filledAt: '2026-03-01T15:00:00Z',
    });
    await closePositionFor(cookie, closed.id, '2026-03-01T15:00:00Z');

    // Open position: entry fee $10, never closed.
    const open = await createPositionFor(cookie, acct.id, {
      symbol: 'OPEN',
      assetType: 'stock',
    });
    await addFillFor(cookie, open.id, {
      type: 'entry',
      price: '50',
      quantity: '1',
      fees: '10.00',
      filledAt: '2026-04-01T15:00:00Z',
    });
    await openPositionFor(cookie, open.id, '2026-04-01T15:00:00Z');

    const res = await authedRequest('GET', '/api/expenses/fee-rollup?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.totalsByAccount).toHaveLength(1);
    const row = body.totalsByAccount[0];
    expect(row.accountId).toBe(acct.id);
    // Both open and closed positions' fills contribute: 2 + 1 + 10 = 13.
    expect(row.stockFees).toBe('13.00');
    expect(row.optionsFees).toBe('0.00');
    expect(row.totalFees).toBe('13.00');

    const perCurrency = new Map<string, string>(
      body.perCurrencyTotals.map((r: { currency: string; totalFees: string }) => [
        r.currency,
        r.totalFees,
      ]),
    );
    expect(perCurrency.get('USD')).toBe('13.00');
  });

  it('missing-rate partial degradation: excludedCurrencies + missingRates populated; grandTotal excludes that currency', async () => {
    const { cookie } = await registerAndGetCookie();
    const me = await getMe(cookie);

    // Pin displayCurrency = USD up-front so it does NOT get materialized to
    // GBP (the first account currency below).
    await setDisplayCurrency(me.id, 'USD');

    const acctGbp = await createAccount(cookie, 'GBP acct', 'GBP');
    const acctUsd = await createAccount(cookie, 'USD acct', 'USD');

    // GBP fees — no GBP→USD rate exists, this currency must be excluded.
    const gbpPos = await createPositionFor(cookie, acctGbp.id, {
      symbol: 'LON',
      assetType: 'stock',
    });
    await addFillFor(cookie, gbpPos.id, {
      type: 'entry',
      price: '100',
      quantity: '1',
      fees: '9.00',
      filledAt: '2026-02-15T15:00:00Z',
    });
    await openPositionFor(cookie, gbpPos.id, '2026-02-15T15:00:00Z');

    // USD fees — same display currency, no rate needed.
    const usdPos = await createPositionFor(cookie, acctUsd.id, {
      symbol: 'AAPL',
      assetType: 'stock',
    });
    await addFillFor(cookie, usdPos.id, {
      type: 'entry',
      price: '100',
      quantity: '1',
      fees: '6.00',
      filledAt: '2026-02-20T15:00:00Z',
    });
    await openPositionFor(cookie, usdPos.id, '2026-02-20T15:00:00Z');

    const res = await authedRequest('GET', '/api/expenses/fee-rollup?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    // perCurrencyTotals still surfaces both currencies even when GBP can't
    // convert.
    const perCurrency = new Map<string, string>(
      body.perCurrencyTotals.map((r: { currency: string; totalFees: string }) => [
        r.currency,
        r.totalFees,
      ]),
    );
    expect(perCurrency.get('GBP')).toBe('9.00');
    expect(perCurrency.get('USD')).toBe('6.00');

    // grandTotal: USD piece contributes ($6), GBP excluded.
    expect(body.grandTotal).not.toBeNull();
    expect(body.grandTotal.displayCurrency).toBe('USD');
    expect(body.grandTotal.totalFees).toBe('6.00');
    expect(body.grandTotal.convertedCurrencies).toEqual([]);
    expect(body.grandTotal.excludedCurrencies).toEqual(['GBP']);

    expect(body.missingRates).toEqual([{ base: 'GBP', quote: 'USD' }]);
    expect(body.usedRates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tax-summary fixture helpers
// ---------------------------------------------------------------------------

/**
 * Open a position, add an entry fill, open it, add an exit fill, then close it
 * so the auto-registered close hook (`insertPositionCloseLedgerEntries`)
 * materialises a `position_pnl` row in `ledger_entries`. The sign of the entry
 * is derived from entry vs exit price + side (the realised P&L the service
 * computes from the fills).
 */
async function openAndClose(
  cookie: string,
  accountId: string,
  args: {
    symbol: string;
    side?: 'long' | 'short';
    assetType?: 'stock' | 'option';
    entryPrice: string;
    exitPrice: string;
    quantity?: string;
    openedAt: string;
    closedAt: string;
  },
): Promise<{ id: string }> {
  const position = await createPositionFor(cookie, accountId, {
    symbol: args.symbol,
    side: args.side ?? 'long',
    assetType: args.assetType ?? 'stock',
  });
  const qty = args.quantity ?? '1';
  await addFillFor(cookie, position.id, {
    type: 'entry',
    price: args.entryPrice,
    quantity: qty,
    fees: '0.00',
    filledAt: args.openedAt,
  });
  await openPositionFor(cookie, position.id, args.openedAt);
  await addFillFor(cookie, position.id, {
    type: 'exit',
    price: args.exitPrice,
    quantity: qty,
    fees: '0.00',
    filledAt: args.closedAt,
  });
  await closePositionFor(cookie, position.id, args.closedAt);
  return position;
}

async function patchJurisdiction(cookie: string, value: 'US' | 'CA' | 'other' | null) {
  const res = await authedRequest('PATCH', '/api/users/me/tax-jurisdiction', cookie, {
    taxJurisdiction: value,
  });
  return res;
}

// ---------------------------------------------------------------------------
// GET /api/expenses/tax-summary
// ---------------------------------------------------------------------------

describe('GET /api/expenses/tax-summary', () => {
  it('US jurisdiction: hold-period classifies into shortTerm/longTerm; total = shortTerm + longTerm', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    await patchJurisdiction(cookie, 'US');

    // Short-term: ~200 days held, $10 profit.
    await openAndClose(cookie, acct.id, {
      symbol: 'SHRT',
      entryPrice: '100',
      exitPrice: '110',
      openedAt: '2026-01-10T15:00:00Z',
      closedAt: '2026-07-29T15:00:00Z', // ~200d after open
    });

    // Long-term: ~400 days held, $50 profit. Open in prior year so it's a
    // realised-in-2026 close with >365d hold.
    await openAndClose(cookie, acct.id, {
      symbol: 'LONG',
      entryPrice: '100',
      exitPrice: '150',
      openedAt: '2025-08-20T15:00:00Z',
      closedAt: '2026-09-24T15:00:00Z', // ~400d after open
    });

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.jurisdiction).toBe('US');
    expect(body.displayCurrency).toBe('USD');
    expect(body.realisedPnl.shortTerm).toBe('10.00');
    expect(body.realisedPnl.longTerm).toBe('50.00');
    expect(body.realisedPnl.total).toBe('60.00');
  });

  it('CA jurisdiction: shortTerm and longTerm are null; total populated', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    await patchJurisdiction(cookie, 'CA');

    await openAndClose(cookie, acct.id, {
      symbol: 'AAPL',
      entryPrice: '100',
      exitPrice: '120',
      openedAt: '2026-03-01T15:00:00Z',
      closedAt: '2026-09-15T15:00:00Z',
    });

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.jurisdiction).toBe('CA');
    expect(body.realisedPnl.shortTerm).toBeNull();
    expect(body.realisedPnl.longTerm).toBeNull();
    expect(body.realisedPnl.total).toBe('20.00');
  });

  it("'other' jurisdiction: flags === { washSales: [], superficialLosses: [] }", async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    // Default jurisdiction is NULL → materialises as 'other'.

    // Set up the conditions that WOULD trigger a wash-sale flag under 'US' —
    // a loss followed by a same-symbol repurchase inside 30d — and assert the
    // 'other' path short-circuits both flag arrays.
    await openAndClose(cookie, acct.id, {
      symbol: 'AAPL',
      entryPrice: '100',
      exitPrice: '90',
      openedAt: '2026-04-01T15:00:00Z',
      closedAt: '2026-07-01T15:00:00Z',
    });
    // Same-symbol re-open within 30d (would be a wash-sale candidate under US).
    const reopened = await createPositionFor(cookie, acct.id, {
      symbol: 'AAPL',
      assetType: 'stock',
    });
    await addFillFor(cookie, reopened.id, {
      type: 'entry',
      price: '95',
      quantity: '1',
      fees: '0.00',
      filledAt: '2026-07-15T15:00:00Z',
    });
    await openPositionFor(cookie, reopened.id, '2026-07-15T15:00:00Z');

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.jurisdiction).toBe('other');
    expect(body.flags).toEqual({ washSales: [], superficialLosses: [] });
  });

  it('US wash-sale end-to-end: loss + same-symbol re-open within 30d produces one washSales entry', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    await patchJurisdiction(cookie, 'US');

    // Loss: buy 100, sell 90 → -10. Long stock AAPL.
    const lossPos = await openAndClose(cookie, acct.id, {
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      entryPrice: '100',
      exitPrice: '90',
      openedAt: '2026-04-01T15:00:00Z',
      closedAt: '2026-07-01T15:00:00Z',
    });

    // Re-open AAPL long within 30 days (different UTC date than close date so
    // the same-day-reopen exclusion does not strip the candidate).
    const reopened = await createPositionFor(cookie, acct.id, {
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, reopened.id, {
      type: 'entry',
      price: '95',
      quantity: '1',
      fees: '0.00',
      filledAt: '2026-07-15T15:00:00Z',
    });
    await openPositionFor(cookie, reopened.id, '2026-07-15T15:00:00Z');

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.flags.washSales).toHaveLength(1);
    const flag = body.flags.washSales[0];
    expect(flag.positionId).toBe(lossPos.id);
    expect(flag.symbol).toBe('AAPL');
    expect(flag.side).toBe('long');
    expect(flag.reason).toBe('repurchase_within_30_days');
    // realisedLoss is the signed P&L from the SUM query — debit $10 → '-10.0000'.
    expect(flag.realisedLoss).toBe('-10.0000');
    expect(flag.counterpartyPositionIds).toEqual([reopened.id]);
    expect(body.flags.superficialLosses).toEqual([]);
  });

  it('forward-compat: NULL position_id rows are excluded by the join (Req 7.6)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    // Two profit positions so we can null out one and observe the SUM drop.
    await openAndClose(cookie, acct.id, {
      symbol: 'KEEP',
      entryPrice: '100',
      exitPrice: '110',
      openedAt: '2026-03-01T15:00:00Z',
      closedAt: '2026-05-01T15:00:00Z',
    });
    const toOrphan = await openAndClose(cookie, acct.id, {
      symbol: 'NULL',
      entryPrice: '100',
      exitPrice: '125',
      openedAt: '2026-03-10T15:00:00Z',
      closedAt: '2026-05-10T15:00:00Z',
    });

    // Sanity: both positions contribute to the total before the NULL probe.
    const before = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    const beforeBody = await before.json();
    expect(beforeBody.realisedPnl.total).toBe('35.00'); // 10 + 25

    // Direct-update one ledger entry's position_id to NULL. The realised-PnL
    // query INNER-JOINs ledger → positions on position_id, so the null row
    // drops from the result set entirely.
    await db
      .update(ledgerEntries)
      .set({ positionId: null })
      .where(eq(ledgerEntries.positionId, toOrphan.id));

    const after = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    // Only the surviving $10 profit remains; the orphaned $25 is excluded.
    expect(afterBody.realisedPnl.total).toBe('10.00');
    const usd = afterBody.realisedPnl.perCurrency.find(
      (r: { currency: string }) => r.currency === 'USD',
    );
    // USD has 2 minor units; per-currency amounts are emitted at that precision.
    expect(usd.amount).toBe('10.00');
  });
});

// ---------------------------------------------------------------------------
// GET /api/expenses/tax-summary — closed-delete via the REAL removePosition path
// ---------------------------------------------------------------------------
//
// ledger-balances Req 7.7 / 7.11, task 27. The forward-compat test above nulls
// a single position_id by hand; these drive `DELETE /api/positions/:id`, which
// posts a `position_pnl_reversal` FIRST and then hard-deletes the position — so
// BOTH the original close row and its reversal leave the `positions` inner-join
// (positionId → NULL via ON DELETE SET NULL). They are excluded, not netted.

describe('GET /api/expenses/tax-summary — closed-delete via the real removePosition path', () => {
  async function taxTotal(cookie: string, year: number): Promise<string> {
    const res = await authedRequest('GET', `/api/expenses/tax-summary?year=${year}`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()).realisedPnl.total;
  }

  // Item 2: close + delete within one tax year → the netted pair contributes 0
  // to that year's realised-P&L summary (the whole pair drops from the join).
  it('same-year: deleting a position closed this year drops its P&L from the year total', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    await openAndClose(cookie, acct.id, {
      symbol: 'KEEP',
      entryPrice: '100',
      exitPrice: '110', // +10
      openedAt: '2026-03-01T15:00:00Z',
      closedAt: '2026-05-01T15:00:00Z',
    });
    const drop = await openAndClose(cookie, acct.id, {
      symbol: 'DROP',
      entryPrice: '100',
      exitPrice: '125', // +25
      openedAt: '2026-03-10T15:00:00Z',
      closedAt: '2026-05-10T15:00:00Z',
    });

    expect(await taxTotal(cookie, 2026)).toBe('35.00'); // 10 + 25

    const del = await authedRequest('DELETE', `/api/positions/${drop.id}`, cookie);
    expect(del.status).toBe(204);

    // Both the original close and its reversal leave the inner-join (positionId
    // NULL), so the deleted position nets to 0 within the year — only KEEP left.
    expect(await taxTotal(cookie, 2026)).toBe('10.00');
  });

  // Item 3: cross-year delete pin (adversarial finding 1). Deleting THIS year a
  // position CLOSED in a PRIOR tax year retroactively drops that prior year's
  // realised-P&L by the position's amount, with NO offsetting reversal in that
  // year — the reversal's occurredAt is now() (the delete date), which lands in
  // the current year. This is the documented, intended-but-sharp full-hard-
  // delete behaviour (ledger-balances requirements.md Req 7.7 + design.md
  // "⚠️ Cross-year caveat"). Pinned here so it can never change silently: a
  // future change that makes prior-year figures stable would break this test on
  // purpose. The 2025 positions are in the past regardless of the run date, so
  // the delete always lands after 2025 (assertion is stable year over year).
  it('cross-year: deleting this year a position closed last year drops last year total by its amount', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    // Both positions CLOSED in the prior tax year (2025).
    await openAndClose(cookie, acct.id, {
      symbol: 'KEEP',
      entryPrice: '100',
      exitPrice: '110', // +10
      openedAt: '2025-03-01T15:00:00Z',
      closedAt: '2025-05-01T15:00:00Z',
    });
    const drop = await openAndClose(cookie, acct.id, {
      symbol: 'DROP',
      entryPrice: '100',
      exitPrice: '125', // +25
      openedAt: '2025-03-10T15:00:00Z',
      closedAt: '2025-05-10T15:00:00Z',
    });

    // Prior year starts at 10 + 25 = 35.
    expect(await taxTotal(cookie, 2025)).toBe('35.00');

    // Delete happens now (a later year); the reversal's occurredAt is now(), so
    // it lands OUTSIDE 2025 — no offsetting entry in the prior year.
    const del = await authedRequest('DELETE', `/api/positions/${drop.id}`, cookie);
    expect(del.status).toBe(204);

    // The prior year drops by exactly the deleted position's amount (25). The
    // sharp edge: 2025 realised-P&L retroactively changes with nothing in 2025
    // to offset it.
    expect(await taxTotal(cookie, 2025)).toBe('10.00');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/users/me/tax-jurisdiction
// ---------------------------------------------------------------------------

describe('PATCH /api/users/me/tax-jurisdiction', () => {
  it("PATCH 'CA' is reflected in subsequent GET tax-summary", async () => {
    const { cookie } = await registerAndGetCookie();
    // Need an account so the response can serialise the displayCurrency path
    // without surprises; the assertion here is on jurisdiction only.
    await createAccount(cookie, 'USD acct', 'USD');

    const patchRes = await patchJurisdiction(cookie, 'CA');
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.taxJurisdiction).toBe('CA');

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jurisdiction).toBe('CA');
  });

  it("PATCH null → GET tax-summary returns jurisdiction: 'other' (NULL materialisation)", async () => {
    const { cookie } = await registerAndGetCookie();
    await createAccount(cookie, 'USD acct', 'USD');

    // Set to 'US' first, then clear it.
    await patchJurisdiction(cookie, 'US');
    const patchRes = await patchJurisdiction(cookie, null);
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.taxJurisdiction).toBeNull();

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jurisdiction).toBe('other');
  });

  it("PATCH 'FR' returns 400 with details.taxJurisdiction", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('PATCH', '/api/users/me/tax-jurisdiction', cookie, {
      taxJurisdiction: 'FR',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    // Error envelope: `{ error: { code, message, details: {...} } }`.
    expect(body.error?.details?.taxJurisdiction).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants — MUST be the LAST describe block in this file.
// `vi.useFakeTimers()` is scoped here only (beforeEach/afterEach) so the
// frozen clock cannot leak into the disclaimer wording assertions in earlier
// describes (the `year < new Date().getUTCFullYear()` branch in
// `getTaxSummary` would silently misbehave under a frozen clock).
// ---------------------------------------------------------------------------

describe('boundary-year transition + invariants', () => {
  beforeEach(() => {
    // toFake: ['Date'] — only swap Date, NOT timers; postgres-js / Hono I/O
    // rely on setTimeout/setImmediate for connection handling and would stall
    // under the default `vi.useFakeTimers()` behaviour.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // auth.middleware enforces (a) absolute timeout: now - createdAt > 24h, and
  // (b) idle timeout: now - lastAccessed > 30min, both via JS Date.now(). When
  // a test jumps the system clock months into the future, the (real-time)
  // session timestamps become stale relative to the faked clock. Forward-
  // backdate every active session's createdAt + lastAccessed to a sentinel in
  // the far future so the middleware's `now - sessionTs` deltas are negative
  // (well under both thresholds), and push expiresAt past every boundary.
  async function extendSessions(forwardedNow: Date) {
    await db.update(sessions).set({
      createdAt: forwardedNow,
      lastAccessed: forwardedNow,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    });
  }

  it('boundary-year transition: position closed at 2026-12-31T21:00 ET (=2027-01-01T02:00 UTC) is excluded from 2026, included in 2027 (post-v2-fix #5)', async () => {
    // Fixture setup runs against real time so HTTP-driven inserts behave
    // normally; assertions then jump the system clock with `setSystemTime`.
    vi.useRealTimers();

    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    // Position closed at 2026-12-31T21:00 ET == 2027-01-01T02:00 UTC. The
    // close hook materialises a `position_pnl` ledger row with the same
    // occurredAt as the position's closedAt.
    await openAndClose(cookie, acct.id, {
      symbol: 'BNDY',
      entryPrice: '100',
      exitPrice: '110',
      openedAt: '2026-06-01T15:00:00Z',
      closedAt: '2027-01-01T02:00:00Z',
    });

    // Re-engage fake timers for the assertion phase.
    vi.useFakeTimers({ toFake: ['Date'] });

    // -------- (a) At 2026-12-31T23:00 UTC: 2026 is the current year. --------
    vi.setSystemTime(new Date('2026-12-31T23:00:00Z'));
    await extendSessions(new Date('2026-12-31T22:30:00Z'));

    const res2026 = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res2026.status).toBe(200);
    const body2026 = await res2026.json();
    // Window for year=2026 is [2026-01-01, 2027-01-01); the boundary close at
    // 2027-01-01T02:00Z is OUTSIDE — realised P&L total is zero (no rows).
    expect(body2026.realisedPnl.total).toBe('0.00');
    // 2026 is the CURRENT year at this clock — current-year stability wording.
    expect(body2026.disclaimer).toContain('most recent rates available');

    // -------- (b) At 2027-01-01T01:00 UTC: 2027 is the current year. --------
    vi.setSystemTime(new Date('2027-01-01T01:00:00Z'));
    await extendSessions(new Date('2027-01-01T00:45:00Z'));

    const res2027 = await authedRequest('GET', '/api/expenses/tax-summary?year=2027', cookie);
    expect(res2027.status).toBe(200);
    const body2027 = await res2027.json();
    // Window for year=2027 is [2027-01-01, 2028-01-01); the boundary close at
    // 2027-01-01T02:00Z is INSIDE — realised P&L = +$10.
    expect(body2027.realisedPnl.total).toBe('10.00');
    // 2027 is the current year at this clock — current-year stability wording.
    expect(body2027.disclaimer).toContain('most recent rates available');

    // The same 2026 query, now AT a 2027 clock, is a past-year request.
    const res2026Past = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res2026Past.status).toBe(200);
    const body2026Past = await res2026Past.json();
    expect(body2026Past.disclaimer).toContain('Reloading does not change the numbers');
  });

  it('reopen contract: a second position_pnl for the same position is now ACCEPTED — ledger_position_pnl_unique_idx dropped (d-536e8750)', async () => {
    // Set up real-time fixture (a user, account, closed position) so we have a
    // positionId for the probe.
    vi.useRealTimers();
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    const me = await getMe(cookie);
    const closed = await openAndClose(cookie, acct.id, {
      symbol: 'UNIQ',
      entryPrice: '100',
      exitPrice: '110',
      openedAt: '2026-03-01T15:00:00Z',
      closedAt: '2026-04-01T15:00:00Z',
    });
    vi.useFakeTimers({ toFake: ['Date'] });

    // The close hook already inserted one position_pnl row for `closed.id`.
    // Since the reversal amendment dropped `ledger_position_pnl_unique_idx`, a
    // reopen→re-close legitimately writes a SECOND position_pnl row for the
    // same position (multiple position_pnl rows per position are now legal —
    // the state machine + reverse-hook co-registration replace the old index).
    // Assert the second insert now succeeds (no 23505 unique-violation).
    await expect(
      db.insert(ledgerEntries).values({
        userId: me.id,
        accountId: acct.id,
        positionId: closed.id,
        entryType: 'position_pnl',
        direction: 'credit',
        amount: '5.0000',
        currency: 'USD',
        occurredAt: new Date('2026-04-01T15:00:00Z'),
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      }),
    ).resolves.toBeDefined();

    // Both position_pnl rows now coexist for the same position.
    const rows = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.positionId, closed.id), eq(ledgerEntries.entryType, 'position_pnl')),
      );
    expect(rows.length).toBe(2);
  });

  it('reversal-cancellation: paired (position_pnl debit, position_pnl_reversal credit) cancel to zero — both rows have positive amount (post-v3-fix #1)', async () => {
    vi.useRealTimers();
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    const me = await getMe(cookie);

    // Set up a fresh closed position. We will drop the auto-emitted
    // position_pnl row and replace it with our own paired (debit, credit)
    // fixture — that way the SUM-with-direction-flip evaluates to zero AND
    // the assertion phase exercises the wash-sale short-circuit when sum=0.
    // We use direct DB inserts so the close hook does NOT auto-create a row.
    // eslint-disable-next-line no-restricted-syntax
    const [pos] = await db
      .insert(positions)
      .values({
        userId: me.id,
        accountId: acct.id,
        symbol: 'RVRS',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-04-01T15:00:00Z'),
        closedAt: new Date('2026-07-01T15:00:00Z'),
      })
      .returning();

    // Set up a second loss position with a same-symbol re-open inside 30d so
    // the wash-sale heuristic would normally flag it — assertion: the
    // cancelled (sum=0) position is NOT classified as a loss and thus NOT
    // flagged.
    await db.insert(ledgerEntries).values([
      {
        userId: me.id,
        accountId: acct.id,
        positionId: pos!.id,
        entryType: 'position_pnl',
        direction: 'debit',
        amount: '100.0000',
        currency: 'USD',
        occurredAt: new Date('2026-07-01T15:00:00Z'),
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      },
      {
        userId: me.id,
        accountId: acct.id,
        positionId: pos!.id,
        entryType: 'position_pnl_reversal',
        direction: 'credit',
        amount: '100.0000',
        currency: 'USD',
        occurredAt: new Date('2026-07-02T15:00:00Z'),
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      },
    ]);

    // Same-symbol re-open within 30d (would be a wash-sale counterparty for a
    // real loss). The cancellation must short-circuit the loss classification.
    await patchJurisdiction(cookie, 'US');
    const reopened = await createPositionFor(cookie, acct.id, {
      symbol: 'RVRS',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, reopened.id, {
      type: 'entry',
      price: '95',
      quantity: '1',
      fees: '0.00',
      filledAt: '2026-07-15T15:00:00Z',
    });
    await openPositionFor(cookie, reopened.id, '2026-07-15T15:00:00Z');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
    await extendSessions(new Date('2026-12-15T11:45:00Z'));

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    // SUM(CASE WHEN credit THEN +amount ELSE -amount END) = -100 + 100 = 0.
    expect(body.realisedPnl.total).toBe('0.00');
    const usd = body.realisedPnl.perCurrency.find(
      (r: { currency: string }) => r.currency === 'USD',
    );
    expect(usd?.amount).toBe('0.00');
    // The cancelled position must NOT appear in washSales even though a
    // same-symbol re-open exists within 30d.
    const flagged = body.flags.washSales.find(
      (f: { positionId: string }) => f.positionId === pos!.id,
    );
    expect(flagged).toBeUndefined();
  });

  it('orphaned reversal forward-compat probe: standalone position_pnl_reversal credit contributes +amount to the SUM (v2-8, fixture pinned by v3-7)', async () => {
    vi.useRealTimers();
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    const me = await getMe(cookie);

    // Fixture (a): a closed position with explicit closedAt inside 2026 (the
    // non-null closedAt keeps the wash-sale window `loss.closedAt ± 30d`
    // well-defined per v3-7).
    // eslint-disable-next-line no-restricted-syntax
    const [pos] = await db
      .insert(positions)
      .values({
        userId: me.id,
        accountId: acct.id,
        symbol: 'XYZ',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-05-15T12:00:00Z'),
        closedAt: new Date('2026-06-15T12:00:00Z'),
      })
      .returning();

    // Fixture (b): ONE position_pnl_reversal row, NO paired position_pnl.
    await db.insert(ledgerEntries).values({
      userId: me.id,
      accountId: acct.id,
      positionId: pos!.id,
      entryType: 'position_pnl_reversal',
      direction: 'credit',
      amount: '100.0000',
      currency: 'USD',
      occurredAt: new Date('2026-06-15T12:00:00Z'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
    await extendSessions(new Date('2026-12-15T11:45:00Z'));

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    // SUM(CASE WHEN credit THEN +amount ELSE -amount END) on a single credit
    // row of 100 → +100. Per-currency emit is at USD's minor units (2).
    const usd = body.realisedPnl.perCurrency.find(
      (r: { currency: string }) => r.currency === 'USD',
    );
    expect(usd?.amount).toBe('100.00');
    // This documents the current behaviour. If the future reversal-emission
    // spec (d-536e8750) wants orphans excluded, it must extend the WHERE
    // clause or join the originals — this test will then need to be updated.
  });
});

// DO NOT add describe() blocks below this line — see Task 17.4 (boundary-year vi.useFakeTimers scoping).
