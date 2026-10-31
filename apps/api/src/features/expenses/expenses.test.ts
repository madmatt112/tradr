import { and, eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

import app, { bootstrap } from '@/app';
import { db } from '@/db';
import { ledgerEntries } from '@/db/schema/accounting.schema';
import { expenses } from '@/db/schema/expenses.schema';
import { fillTransferLinks, positions } from '@/db/schema/positions.schema';
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
  data: {
    type: 'entry' | 'exit';
    price: string;
    quantity: string;
    fees: string;
    filledAt: string;
    lotSelection?: Array<{ entryFillId: string; quantity: string }>;
  },
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

/**
 * Ensures the position is closed at `closedAt`.
 *
 * A balancing exit auto-closes at that fill's own timestamp (R7 amendment), and
 * every caller here gives the exit the same timestamp it wants the close at —
 * so the position is normally already closed, correctly. Asserting that here
 * keeps these tax-year-boundary tests honest: they depend on the exact closedAt,
 * so a drift between the fill time and the close time must fail loudly rather
 * than silently shifting a position into another tax year.
 */
async function closePositionFor(cookie: string, positionId: string, closedAt: string) {
  const existing = await authedRequest('GET', `/api/positions/${positionId}`, cookie);
  expect(existing.status).toBe(200);
  const position = await existing.json();
  if (position.status === 'closed') {
    expect(new Date(position.closedAt).toISOString()).toBe(new Date(closedAt).toISOString());
    return position;
  }

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
    // US carries every pre-feature value, plus the two new fields empty (AC 8.1).
    expect(body.acbDispositions).toEqual([]);
    expect(body.acbMissingRates).toEqual([]);
  });

  it('CA jurisdiction (pooled ACB): shortTerm and longTerm are null; total reflects the pooled disposition', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'CAD acct', 'CAD');

    await patchJurisdiction(cookie, 'CA');

    const position = await createPositionFor(cookie, acct.id, {
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '50',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-03-01T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-03-01T15:00:00Z');
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '60',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-09-15T15:00:00Z',
    });
    await closePositionFor(cookie, position.id, '2026-09-15T15:00:00Z');

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.jurisdiction).toBe('CA');
    expect(body.lotMethod).toBe('acb');
    expect(body.realisedPnl.shortTerm).toBeNull();
    expect(body.realisedPnl.longTerm).toBeNull();
    // proceeds 60*10=600.00; acb 50*10+1=501.00; outlays (exit fee)=1.00;
    // gain 600-1-501=98.00 (design C5, AC 3.11/5.1).
    expect(body.realisedPnl.total).toBe('98.00');
    expect(body.acbDispositions).toHaveLength(1);
    expect(body.acbDispositions[0]).toMatchObject({
      proceeds: '600.00',
      outlays: '1.00',
      acb: '501.00',
      gain: '98.00',
      unpricedReason: null,
    });
    expect(body.acbMissingRates).toEqual([]);
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
    // 'other' carries every pre-feature value, plus the two new fields empty (AC 8.1).
    expect(body.acbDispositions).toEqual([]);
    expect(body.acbMissingRates).toEqual([]);
  });

  it('CA ACB pool: two taxable accounts pool one disposition; a registered holding changes nothing (AC 3.11)', async () => {
    const { cookie } = await registerAndGetCookie();

    // Account A — CAD, entry 100 @ 10.00, no fees.
    const acctA = await createAccount(cookie, 'CAD acct', 'CAD');
    // Account B — USD, entry 100 @ 8.00, no fees; needs its own trade-date rate.
    const acctB = await createAccount(cookie, 'USD acct', 'USD');
    // Registered account holding the same symbol/side — must change nothing.
    const registeredRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'TFSA',
      currency: 'CAD',
      taxTreatment: 'registered',
    });
    expect(registeredRes.status).toBe(201);
    const acctR = await registeredRes.json();

    await patchJurisdiction(cookie, 'CA');

    const positionA = await createPositionFor(cookie, acctA.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, positionA.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      fees: '0.00',
      filledAt: '2026-02-01T14:00:00Z',
    });
    await openPositionFor(cookie, positionA.id, '2026-02-01T14:00:00Z');

    const positionB = await createPositionFor(cookie, acctB.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, positionB.id, {
      type: 'entry',
      price: '8.00',
      quantity: '100',
      fees: '0.00',
      filledAt: '2026-02-01T15:00:00Z',
    });
    await openPositionFor(cookie, positionB.id, '2026-02-01T15:00:00Z');
    await createExchangeRate(cookie, {
      baseCurrency: 'USD',
      quoteCurrency: 'CAD',
      rate: '1.35',
      effectiveDate: '2026-02-01',
    });

    const positionR = await createPositionFor(cookie, acctR.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, positionR.id, {
      type: 'entry',
      price: '1000.00',
      quantity: '50',
      fees: '0.00',
      filledAt: '2026-02-01T14:00:00Z',
    });
    await openPositionFor(cookie, positionR.id, '2026-02-01T14:00:00Z');

    // Sell 50 of A's 100 shares — a partial exit; A stays open.
    const exitFill = await addFillFor(cookie, positionA.id, {
      type: 'exit',
      price: '12.00',
      quantity: '50',
      fees: '0.00',
      filledAt: '2026-03-01T15:00:00Z',
    });

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Pool: A (CAD 100@10=1000) + B (USD 100@8 * 1.35 = 1080 CAD) = 2080 CAD
    // over 200 shares. ACB share for 50 = 2080*50/200 = 520.00; proceeds =
    // 12*50 = 600.00; gain = 600 - 520 = 80.00. The registered holding (also
    // XYZ/long) never joins the pool, so it changes none of these figures.
    expect(body.acbDispositions).toHaveLength(1);
    expect(body.acbDispositions[0]).toMatchObject({
      exitFillId: exitFill.id,
      positionId: positionA.id,
      accountId: acctA.id,
      symbol: 'XYZ',
      currency: 'CAD',
      tradeDate: '2026-03-01',
      cadRate: null,
      proceeds: '600.00',
      outlays: '0.00',
      acb: '520.00',
      gain: '80.00',
      unpricedReason: null,
    });
    expect(body.realisedPnl.perCurrency).toEqual([{ currency: 'CAD', amount: '80.00' }]);
    expect(body.realisedPnl.total).toBe('80.00');
  });

  it('a USD exit with no rate is missing_rate, excluded from the total, and lists only in acbMissingRates (AC 4.6, AC 4.7, AC 5.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    await patchJurisdiction(cookie, 'CA');

    const position = await createPositionFor(cookie, acct.id, {
      symbol: 'NRTE',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '8.00',
      quantity: '100',
      fees: '0.00',
      filledAt: '2026-02-01T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-02-01T15:00:00Z');
    await createExchangeRate(cookie, {
      baseCurrency: 'USD',
      quoteCurrency: 'CAD',
      rate: '1.30',
      effectiveDate: '2026-02-01',
    });

    // Exit on a date with no rate entered — the pool is priced, so only this
    // row is unpriced (AC 4.5); it stays out of acbMissingRates's sibling.
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '12.00',
      quantity: '50',
      fees: '0.00',
      filledAt: '2026-04-01T15:00:00Z',
    });

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.acbDispositions).toHaveLength(1);
    expect(body.acbDispositions[0]).toMatchObject({
      unpricedReason: 'missing_rate',
      cadRate: null,
      proceeds: null,
      outlays: null,
      acb: null,
      gain: null,
    });
    expect(body.acbMissingRates).toEqual([{ currency: 'USD', tradeDate: '2026-04-01' }]);
    // The old dateless field never carries an acb pair (AC 5.1).
    expect(body.missingRates).toEqual([]);
    expect(body.realisedPnl.perCurrency).toEqual([{ currency: 'CAD', amount: '0.00' }]);
    expect(body.realisedPnl.total).toBe('0.00');
  });

  it('after the user enters the missing rate, the next read prices the previously unpriced row (AC 4.9)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    await patchJurisdiction(cookie, 'CA');

    const position = await createPositionFor(cookie, acct.id, {
      symbol: 'NRTE',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '8.00',
      quantity: '100',
      fees: '0.00',
      filledAt: '2026-02-01T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-02-01T15:00:00Z');
    await createExchangeRate(cookie, {
      baseCurrency: 'USD',
      quoteCurrency: 'CAD',
      rate: '1.30',
      effectiveDate: '2026-02-01',
    });
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '12.00',
      quantity: '50',
      fees: '0.00',
      filledAt: '2026-04-01T15:00:00Z',
    });

    const before = await (
      await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie)
    ).json();
    expect(before.acbDispositions[0].unpricedReason).toBe('missing_rate');

    await createExchangeRate(cookie, {
      baseCurrency: 'USD',
      quoteCurrency: 'CAD',
      rate: '1.25',
      effectiveDate: '2026-04-01',
    });

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Entry: 8*100*1.30 = 1040.00 CAD. ACB share for 50 of 100 = 520.00.
    // Proceeds: 12*50*1.25 = 750.00. Gain: 750 - 520 = 230.00.
    expect(body.acbDispositions).toHaveLength(1);
    expect(body.acbDispositions[0]).toMatchObject({
      unpricedReason: null,
      proceeds: '750.00',
      outlays: '0.00',
      acb: '520.00',
      gain: '230.00',
    });
    expect(body.acbMissingRates).toEqual([]);
    expect(body.realisedPnl.perCurrency).toEqual([{ currency: 'CAD', amount: '230.00' }]);
  });

  it('a non-CAD display currency converts the CAD realised total at the year-end rate; CAD applies no conversion (AC 5.2)', async () => {
    const { cookie } = await registerAndGetCookie();
    const me = await getMe(cookie);
    const acct = await createAccount(cookie, 'CAD acct', 'CAD'); // materializes displayCurrency CAD
    await patchJurisdiction(cookie, 'CA');

    const position = await createPositionFor(cookie, acct.id, {
      symbol: 'FXCV',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '50',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-02-01T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-02-01T15:00:00Z');
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '60',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-03-01T15:00:00Z',
    });

    const resCad = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(resCad.status).toBe(200);
    const bodyCad = await resCad.json();
    expect(bodyCad.displayCurrency).toBe('CAD');
    expect(bodyCad.realisedPnl.total).toBe('100.00');
    expect(bodyCad.usedRates).toEqual([]);
    expect(bodyCad.acbDispositions).toHaveLength(1);
    expect(bodyCad.acbDispositions[0].gain).toBe('100.00');

    await setDisplayCurrency(me.id, 'USD');
    await createExchangeRate(cookie, {
      baseCurrency: 'CAD',
      quoteCurrency: 'USD',
      rate: '0.50',
      effectiveDate: '2026-01-01',
    });

    const resUsd = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(resUsd.status).toBe(200);
    const bodyUsd = await resUsd.json();
    expect(bodyUsd.displayCurrency).toBe('USD');
    expect(bodyUsd.realisedPnl.total).toBe('50.00');
  });

  it('the CA disclaimer states the pooled ACB, excludes registered accounts, and drops the held-through-the-window clause (AC 5.5)', async () => {
    const { cookie } = await registerAndGetCookie();
    await createAccount(cookie, 'CAD acct', 'CAD');
    await patchJurisdiction(cookie, 'CA');

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.disclaimer).toContain('pooled per security across your taxable accounts');
    expect(body.disclaimer).toContain(
      'registered accounts (TFSA, RRSP, FHSA and similar) are excluded',
    );
    expect(body.disclaimer).not.toContain('held through that window');
  });

  it('acb superficial-loss end-to-end: a repurchase in a registered account flags, with lossRowId the exit fill id and null lot fields; an unpriced row raises none of its own (AC 7.1, 7.2, 7.3, 7.6)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'CAD acct', 'CAD');
    const registeredRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'TFSA',
      currency: 'CAD',
      taxTreatment: 'registered',
    });
    expect(registeredRes.status).toBe(201);
    const acctR = await registeredRes.json();
    await patchJurisdiction(cookie, 'CA');

    // Taxable loss: entry 100@10, partial exit 50@8 -> gain 400-500=-100.00.
    // Entry is >30 days before the exit so the position's own opening fill
    // (same match key/side/position as the loss) is outside the matching
    // window and cannot itself count as a repurchase candidate.
    const position = await createPositionFor(cookie, acct.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      fees: '0.00',
      filledAt: '2026-01-01T14:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-01-01T14:00:00Z');
    const exitFill = await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '8.00',
      quantity: '50',
      fees: '0.00',
      filledAt: '2026-03-01T15:00:00Z',
    });

    // Repurchase in the TFSA, 9 days later, still held past +30d — the
    // candidate the registered account's lack of a filter (AC 7.2) must
    // still reach.
    const positionR = await createPositionFor(cookie, acctR.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    const entryR = await addFillFor(cookie, positionR.id, {
      type: 'entry',
      price: '9.00',
      quantity: '20',
      fees: '0.00',
      filledAt: '2026-03-10T14:00:00Z',
    });
    await openPositionFor(cookie, positionR.id, '2026-03-10T14:00:00Z');

    // An unpriced taxable disposition (no USD->CAD rate entered) — its gain
    // is null, so it must never become a loss row of its own (AC 7.6).
    const acctUsd = await createAccount(cookie, 'USD acct', 'USD');
    const positionUsd = await createPositionFor(cookie, acctUsd.id, {
      symbol: 'UNPRICED',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, positionUsd.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-03-01T14:00:00Z',
    });
    await openPositionFor(cookie, positionUsd.id, '2026-03-01T14:00:00Z');
    await addFillFor(cookie, positionUsd.id, {
      type: 'exit',
      price: '5.00',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-03-05T14:00:00Z',
    });

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lotMethod).toBe('acb');
    expect(body.flags.superficialLosses).toHaveLength(1);
    const flag = body.flags.superficialLosses[0];
    expect(flag.lossRowId).toBe(exitFill.id);
    expect(flag.lotEntryFillId).toBeNull();
    expect(flag.lotOpenedAt).toBeNull();
    expect(flag.reason).toBe('repurchase_within_30_days');
    expect(flag.counterpartyLotIds).toEqual([entryR.id]);
  });

  it('acb superficial-loss end-to-end: a repurchase in the losing position itself flags (AC 7.3); the entry side of a taxable-to-taxable transfer link is not a repurchase candidate (D7)', async () => {
    const { cookie } = await registerAndGetCookie();
    const me = await getMe(cookie);
    const acctA = await createAccount(cookie, 'CAD acct A', 'CAD');
    const acctB = await createAccount(cookie, 'CAD acct B', 'CAD');
    const acctC = await createAccount(cookie, 'CAD acct C', 'CAD');
    await patchJurisdiction(cookie, 'CA');

    // Account A: entry 100@10, partial exit 50@8 -> loss -100.00; position
    // stays open. Entry is >30 days before the exit so the position's own
    // opening fill does not itself double as a repurchase candidate.
    const positionA = await createPositionFor(cookie, acctA.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, positionA.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      fees: '0.00',
      filledAt: '2026-01-01T14:00:00Z',
    });
    await openPositionFor(cookie, positionA.id, '2026-01-01T14:00:00Z');
    const exitFillA = await addFillFor(cookie, positionA.id, {
      type: 'exit',
      price: '8.00',
      quantity: '50',
      fees: '0.00',
      filledAt: '2026-03-01T15:00:00Z',
    });

    // A second entry into the SAME losing position, 9 days later — on acb
    // the same-position skip (which applies under average) does not apply.
    const reEntryA = await addFillFor(cookie, positionA.id, {
      type: 'entry',
      price: '9.00',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-03-10T14:00:00Z',
    });

    // Account B -> Account C: an in-kind transfer of the same symbol/side.
    // Without D7's exclusion the entry side would also match as a
    // repurchase, 9 days after the loss too.
    const positionB = await createPositionFor(cookie, acctB.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, positionB.id, {
      type: 'entry',
      price: '10.00',
      quantity: '20',
      fees: '0.00',
      filledAt: '2026-01-01T14:00:00Z',
    });
    await openPositionFor(cookie, positionB.id, '2026-01-01T14:00:00Z');
    const exitFillB = await addFillFor(cookie, positionB.id, {
      type: 'exit',
      price: '10.00',
      quantity: '20',
      fees: '0.00',
      filledAt: '2026-03-10T13:00:00Z',
    });

    const positionC = await createPositionFor(cookie, acctC.id, {
      symbol: 'XYZ',
      side: 'long',
      assetType: 'stock',
    });
    const entryFillC = await addFillFor(cookie, positionC.id, {
      type: 'entry',
      price: '10.00',
      quantity: '20',
      fees: '0.00',
      filledAt: '2026-03-10T14:00:00Z',
    });
    await openPositionFor(cookie, positionC.id, '2026-03-10T14:00:00Z');

    await db.insert(fillTransferLinks).values({
      userId: me.id,
      exitFillId: exitFillB.id,
      entryFillId: entryFillC.id,
    });

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.flags.superficialLosses).toHaveLength(1);
    const flag = body.flags.superficialLosses[0];
    expect(flag.lossRowId).toBe(exitFillA.id);
    expect(flag.counterpartyLotIds).toHaveLength(1);
    expect(flag.counterpartyLotIds).toContain(reEntryA.id);
    expect(flag.counterpartyLotIds).not.toContain(entryFillC.id);
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
    // Default jurisdiction=US → FIFO: realisedLoss is the lot row's `net` at
    // USD minor units, not the raw ledger SUM (task 10, design C9).
    expect(flag.realisedLoss).toBe('-10.00');
    expect(flag.counterpartyPositionIds).toEqual([reopened.id]);
    expect(body.flags.superficialLosses).toEqual([]);
  });

  it('FIFO: a flag carries its lot fields and a null closedAt for a loss realised on a still-open position (AC 7.1, AC 7.8)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    await patchJurisdiction(cookie, 'US');

    // Loss lot: buy 10 @ 100, partially exit 5 @ 90 → the position stays
    // open (5 remain), so its `closedAt` is null.
    const position = await createPositionFor(cookie, acct.id, { symbol: 'LOTF' });
    const entry = await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-04-01T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-04-01T15:00:00Z');
    const exit = await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '90',
      quantity: '5',
      fees: '0.00',
      filledAt: '2026-07-01T15:00:00Z',
    });

    // Same-symbol re-open within 30d of the realisation.
    const reopened = await createPositionFor(cookie, acct.id, { symbol: 'LOTF' });
    const reopenedEntry = await addFillFor(cookie, reopened.id, {
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
    expect(flag.positionId).toBe(position.id);
    expect(flag.lossRowId).toBe(`${exit.id}:${entry.id}`);
    expect(flag.lotEntryFillId).toBe(entry.id);
    expect(new Date(flag.lotOpenedAt).toISOString()).toBe('2026-04-01T15:00:00.000Z');
    expect(flag.closedAt).toBeNull();
    expect(new Date(flag.realisedAt).toISOString()).toBe('2026-07-01T15:00:00.000Z');
    expect(flag.realisedLoss).toBe('-50.00');
    expect(flag.counterpartyPositionIds).toEqual([reopened.id]);
    expect(flag.counterpartyLotIds).toEqual([reopenedEntry.id]);
  });

  it('forward-compat: NULL position_id rows are excluded by the join (Req 7.6)', async () => {
    const { cookie } = await registerAndGetCookie();
    // This test probes the ledger-based SUM directly; force average cost so
    // the FIFO default (which reads fills, not ledger_entries) doesn't mask it.
    await patchLotMethod(cookie, 'average');
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
// GET /api/expenses/tax-summary — FIFO lot realisations (design C8)
// ---------------------------------------------------------------------------

describe('GET /api/expenses/tax-summary — FIFO lot realisations', () => {
  async function taxSummary(cookie: string, year: number) {
    const res = await authedRequest('GET', `/api/expenses/tax-summary?year=${year}`, cookie);
    expect(res.status).toBe(200);
    return res.json();
  }

  function expectTermsSumToTotal(body: {
    realisedPnl: { total: string | null; shortTerm: string | null; longTerm: string | null };
  }) {
    const short = Number(body.realisedPnl.shortTerm ?? 0);
    const long = Number(body.realisedPnl.longTerm ?? 0);
    expect(short + long).toBeCloseTo(Number(body.realisedPnl.total), 2);
  }

  // Two entry lots at different dates and prices, opened as one position.
  async function twoLotPosition(cookie: string, accountId: string, symbol: string) {
    const position = await createPositionFor(cookie, accountId, { symbol });
    const lot1 = await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '0.00',
      filledAt: '2025-01-10T15:00:00Z',
    });
    const lot2 = await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '120',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-03-01T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2025-01-10T15:00:00Z');
    return { position, lot1, lot2 };
  }

  it('US partial exit takes the first lot: one row with its basis and term; counts in the exit year only', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    await patchJurisdiction(cookie, 'US');

    const { position, lot1 } = await twoLotPosition(cookie, acct.id, 'FIFO');
    const exit = await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '150',
      quantity: '5',
      fees: '0.00',
      filledAt: '2026-06-01T15:00:00Z',
    });

    const body = await taxSummary(cookie, 2026);
    expect(body.lotMethod).toBe('fifo');
    expect(body.lotRealisations).toHaveLength(1);
    const row = body.lotRealisations[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        'accountId',
        'basis',
        'currency',
        'entryFillId',
        'exitFillId',
        'fees',
        'lotOpenedAt',
        'net',
        'positionId',
        'proceeds',
        'quantity',
        'realisedAt',
        'symbol',
        'term',
      ].sort(),
    );
    expect(row.exitFillId).toBe(exit.id);
    expect(row.entryFillId).toBe(lot1.id);
    expect(row.positionId).toBe(position.id);
    expect(row.accountId).toBe(acct.id);
    expect(row.symbol).toBe('FIFO');
    expect(row.currency).toBe('USD');
    expect(new Date(row.lotOpenedAt).toISOString()).toBe('2025-01-10T15:00:00.000Z');
    expect(new Date(row.realisedAt).toISOString()).toBe('2026-06-01T15:00:00.000Z');
    expect(Number(row.quantity)).toBe(5);
    expect(row.proceeds).toBe('750.00');
    expect(row.basis).toBe('500.00');
    expect(row.net).toBe('250.00');
    expect(row.term).toBe('long');
    expect(body.realisedPnl.total).toBe('250.00');
    expect(body.realisedPnl.longTerm).toBe('250.00');
    expectTermsSumToTotal(body);

    // The lot was opened in 2025 but realised in 2026: 2025 shows nothing.
    const prior = await taxSummary(cookie, 2025);
    expect(prior.lotRealisations).toEqual([]);
  });

  it('US exit over two lots gives two rows, each with its own basis and term (AC 5.9)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    await patchJurisdiction(cookie, 'US');

    const { position, lot1, lot2 } = await twoLotPosition(cookie, acct.id, 'SPLT');
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '150',
      quantity: '15',
      fees: '0.00',
      filledAt: '2026-06-01T15:00:00Z',
    });

    const body = await taxSummary(cookie, 2026);
    expect(body.lotRealisations).toHaveLength(2);
    const byLot = new Map(
      body.lotRealisations.map((r: { entryFillId: string }) => [r.entryFillId, r]),
    );
    expect(byLot.get(lot1.id)).toMatchObject({ basis: '1000.00', net: '500.00', term: 'long' });
    expect(byLot.get(lot2.id)).toMatchObject({ basis: '600.00', net: '150.00', term: 'short' });
    expect(body.realisedPnl.total).toBe('650.00');
    expect(body.realisedPnl.shortTerm).toBe('150.00');
    expect(body.realisedPnl.longTerm).toBe('500.00');
    expectTermsSumToTotal(body);
  });

  it('US rows at 365 and 366 days held are short and long', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    await patchJurisdiction(cookie, 'US');

    // 2025 is not a leap year: 2025-03-01 → 2026-03-01 is exactly 365 days.
    await openAndClose(cookie, acct.id, {
      symbol: 'D365',
      entryPrice: '100',
      exitPrice: '110',
      openedAt: '2025-03-01T15:00:00Z',
      closedAt: '2026-03-01T15:00:00Z',
    });
    await openAndClose(cookie, acct.id, {
      symbol: 'D366',
      entryPrice: '100',
      exitPrice: '130',
      openedAt: '2025-02-28T15:00:00Z',
      closedAt: '2026-03-01T15:00:00Z',
    });

    const body = await taxSummary(cookie, 2026);
    const bySymbol = new Map(
      body.lotRealisations.map((r: { symbol: string; term: string }) => [r.symbol, r.term]),
    );
    expect(bySymbol.get('D365')).toBe('short');
    expect(bySymbol.get('D366')).toBe('long');
    expect(body.realisedPnl.shortTerm).toBe('10.00');
    expect(body.realisedPnl.longTerm).toBe('30.00');
    expectTermsSumToTotal(body);
  });

  it('a fully exited position: FIFO rows net to the ledger (average cost) figure', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    const position = await createPositionFor(cookie, acct.id, { symbol: 'FULL' });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-01-10T15:00:00Z',
    });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '120',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-02-10T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-01-10T15:00:00Z');
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '130',
      quantity: '15',
      fees: '1.00',
      filledAt: '2026-04-01T15:00:00Z',
    });
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '140',
      quantity: '5',
      fees: '1.00',
      filledAt: '2026-05-01T15:00:00Z',
    });
    await closePositionFor(cookie, position.id, '2026-05-01T15:00:00Z');

    const fifo = await taxSummary(cookie, 2026);
    expect(fifo.lotMethod).toBe('fifo');
    const rowNet = fifo.lotRealisations.reduce(
      (sum: number, r: { net: string }) => sum + Number(r.net),
      0,
    );
    expect(rowNet).toBeCloseTo(Number(fifo.realisedPnl.total), 2);

    expect((await patchLotMethod(cookie, 'average')).status).toBe(200);
    const average = await taxSummary(cookie, 2026);
    expect(average.lotMethod).toBe('average');
    expect(fifo.realisedPnl.total).toBe(average.realisedPnl.total);
  });

  it('a CA user with no stored method gets acb reported, pooled ACB figures and no lot rows (AC 2.3)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'CAD acct', 'CAD');
    await patchJurisdiction(cookie, 'CA');

    const position = await createPositionFor(cookie, acct.id, {
      symbol: 'CAAV',
      side: 'long',
      assetType: 'stock',
    });
    await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '50',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-03-01T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-03-01T15:00:00Z');
    await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '60',
      quantity: '10',
      fees: '1.00',
      filledAt: '2026-09-15T15:00:00Z',
    });
    await closePositionFor(cookie, position.id, '2026-09-15T15:00:00Z');

    const body = await taxSummary(cookie, 2026);
    expect(body.lotMethod).toBe('acb');
    expect(body.lotRealisations).toEqual([]);
    expect(body.realisedPnl.total).toBe('98.00');
    expect(body.realisedPnl.shortTerm).toBeNull();
    expect(body.realisedPnl.longTerm).toBeNull();
    expect(body.acbDispositions).toHaveLength(1);
  });

  it('a stored lot selection is ignored under average cost and re-derived under FIFO (AC 3.12)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');

    const position = await createPositionFor(cookie, acct.id, { symbol: 'PICK' });
    const lot1 = await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-01-10T15:00:00Z',
    });
    const lot2 = await addFillFor(cookie, position.id, {
      type: 'entry',
      price: '120',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-02-10T15:00:00Z',
    });
    await openPositionFor(cookie, position.id, '2026-01-10T15:00:00Z');
    // The first exit picks the later lot instead of the FIFO lot.
    const pickedExit = await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '150',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-04-01T15:00:00Z',
      lotSelection: [{ entryFillId: lot2.id, quantity: '10' }],
    });
    const lastExit = await addFillFor(cookie, position.id, {
      type: 'exit',
      price: '150',
      quantity: '10',
      fees: '0.00',
      filledAt: '2026-05-01T15:00:00Z',
    });
    await closePositionFor(cookie, position.id, '2026-05-01T15:00:00Z');

    expect((await patchLotMethod(cookie, 'average')).status).toBe(200);
    const average = await taxSummary(cookie, 2026);
    expect(average.lotMethod).toBe('average');
    expect(average.lotRealisations).toEqual([]);
    expect(average.realisedPnl.total).toBe('800.00'); // 20 × 150 − (1000 + 1200)

    expect((await patchLotMethod(cookie, 'fifo')).status).toBe(200);
    const fifo = await taxSummary(cookie, 2026);
    expect(fifo.lotMethod).toBe('fifo');
    const rows = fifo.lotRealisations as Array<{
      exitFillId: string;
      entryFillId: string;
      basis: string;
      net: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.exitFillId === pickedExit.id)).toMatchObject({
      entryFillId: lot2.id,
      basis: '1200.00',
      net: '300.00',
    });
    expect(rows.find((r) => r.exitFillId === lastExit.id)).toMatchObject({
      entryFillId: lot1.id,
      basis: '1000.00',
      net: '500.00',
    });
    expect(fifo.realisedPnl.total).toBe('800.00');
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
    // This test probes the ledger-based SUM directly (hand-inserted rows, no
    // fills); force average cost so the FIFO default doesn't read empty lots.
    await patchLotMethod(cookie, 'average');
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
    // This test probes the ledger-based SUM directly (hand-inserted rows, no
    // fills); force average cost so the FIFO default doesn't read empty lots.
    await patchLotMethod(cookie, 'average');
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

  it('balance_adjustment rows are excluded from realised P&L (ledger-balances Req 8.10)', async () => {
    vi.useRealTimers();
    const { cookie } = await registerAndGetCookie();
    // This test probes the ledger-based SUM directly (hand-inserted rows, no
    // fills); force average cost so the FIFO default doesn't read empty lots.
    await patchLotMethod(cookie, 'average');
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    const me = await getMe(cookie);

    // Fixture (a): a closed position with a real +100 realised P&L row, so the
    // summary has a non-zero baseline to move away from if the exclusion broke.
    // eslint-disable-next-line no-restricted-syntax
    const [pos] = await db
      .insert(positions)
      .values({
        userId: me.id,
        accountId: acct.id,
        symbol: 'ADJ',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-05-15T12:00:00Z'),
        closedAt: new Date('2026-06-15T12:00:00Z'),
      })
      .returning();

    await db.insert(ledgerEntries).values({
      userId: me.id,
      accountId: acct.id,
      positionId: pos!.id,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '100.0000',
      currency: 'USD',
      occurredAt: new Date('2026-06-15T12:00:00Z'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });

    // Fixture (b): a large cash balance adjustment in the same year and
    // account. It carries a NULL positionId by design, so
    // `listRealisedPositionsForYear`'s INNER JOIN on positions drops it before
    // its entry-type filter is even consulted. That is why the filter in
    // expenses.query.ts is deliberately NOT widened with 'balance_adjustment'
    // (design §C13) — a balance adjustment is not realised trading P&L and
    // must never reach a tax summary.
    await db.insert(ledgerEntries).values({
      userId: me.id,
      accountId: acct.id,
      positionId: null,
      entryType: 'balance_adjustment',
      direction: 'credit',
      amount: '50000.0000',
      currency: 'USD',
      occurredAt: new Date('2026-07-01T12:00:00Z'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
    await extendSessions(new Date('2026-12-15T11:45:00Z'));

    const res = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    const usd = body.realisedPnl.perCurrency.find(
      (r: { currency: string }) => r.currency === 'USD',
    );
    // The position's 100, and NOT the 50,000 adjustment.
    expect(usd?.amount).toBe('100.00');
  });

  it('cash-movement rows are excluded from realised P&L and fees (ledger-cash-movements Req 5.1-5.4)', async () => {
    vi.useRealTimers();
    const { cookie } = await registerAndGetCookie();
    // This test probes the ledger-based SUM directly (hand-inserted rows, no
    // fills); force average cost so the FIFO default doesn't read empty lots.
    await patchLotMethod(cookie, 'average');
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    const me = await getMe(cookie);

    // Baseline: a closed position with a real +100 realised P&L row, so the
    // summary has a non-zero figure the cash rows must not be able to move.
    // eslint-disable-next-line no-restricted-syntax
    const [pos] = await db
      .insert(positions)
      .values({
        userId: me.id,
        accountId: acct.id,
        symbol: 'CASH',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-05-15T12:00:00Z'),
        closedAt: new Date('2026-06-15T12:00:00Z'),
      })
      .returning();

    await db.insert(ledgerEntries).values({
      userId: me.id,
      accountId: acct.id,
      positionId: pos!.id,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '100.0000',
      currency: 'USD',
      occurredAt: new Date('2026-06-15T12:00:00Z'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });

    // Every manual cash-movement class in the same year and account: a deposit,
    // a withdrawal, and each of their reversals. Each carries a NULL positionId
    // by design, so `listRealisedPositionsForYear`'s INNER JOIN on positions
    // drops all four before its entry-type filter is even consulted. That is
    // why the filter in expenses.query.ts:269 is deliberately NOT widened with
    // these types (d-57868245): cash funding is not realised trading P&L. It
    // also carries no fills, so it can never enter the fills-sourced fee rollup.
    for (const [entryType, direction, amount, occurredAt] of [
      ['deposit', 'credit', '5000.0000', '2026-07-01T12:00:00Z'],
      ['withdrawal', 'debit', '2000.0000', '2026-08-01T12:00:00Z'],
      ['deposit_reversal', 'debit', '5000.0000', '2026-09-01T12:00:00Z'],
      ['withdrawal_reversal', 'credit', '2000.0000', '2026-10-01T12:00:00Z'],
    ] as const) {
      await db.insert(ledgerEntries).values({
        userId: me.id,
        accountId: acct.id,
        positionId: null,
        entryType,
        direction,
        amount,
        currency: 'USD',
        occurredAt: new Date(occurredAt),
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      });
    }

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
    await extendSessions(new Date('2026-12-15T11:45:00Z'));

    // (a) Realised P&L: the position's 100 only — none of the cash rows.
    const taxRes = await authedRequest('GET', '/api/expenses/tax-summary?year=2026', cookie);
    expect(taxRes.status).toBe(200);
    const taxBody = await taxRes.json();
    const usd = taxBody.realisedPnl.perCurrency.find(
      (r: { currency: string }) => r.currency === 'USD',
    );
    expect(usd?.amount).toBe('100.00');

    // (b) Fees: cash movements post no fills, so the fee rollup — sourced from
    // fills.fees — surfaces no row for them (this account trades nothing else).
    const feeRes = await authedRequest('GET', '/api/expenses/fee-rollup?year=2026', cookie);
    expect(feeRes.status).toBe(200);
    const feeBody = await feeRes.json();
    expect(feeBody.totalsByAccount).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET/PATCH /api/users/me/tax-lot-method
// ---------------------------------------------------------------------------

async function patchLotMethod(cookie: string, value: 'fifo' | 'average' | null) {
  return authedRequest('PATCH', '/api/users/me/tax-lot-method', cookie, { taxLotMethod: value });
}

describe('GET/PATCH /api/users/me/tax-lot-method', () => {
  it('defaults a new user (no jurisdiction, no stored method) to FIFO', async () => {
    const { cookie } = await registerAndGetCookie();

    const res = await authedRequest('GET', '/api/users/me/tax-lot-method', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taxLotMethod).toBeNull();
    expect(body.effectiveMethod).toBe('fifo');
    expect(body.isDefault).toBe(true);
  });

  it('defaults a CA user with no stored method to the pooled acb method (AC 2.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    await patchJurisdiction(cookie, 'CA');

    const res = await authedRequest('GET', '/api/users/me/tax-lot-method', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taxLotMethod).toBeNull();
    expect(body.effectiveMethod).toBe('acb');
    expect(body.isDefault).toBe(true);
  });

  it('the stored method is kept under CA (effective method is acb) and applies again under US (AC 2.1, AC 2.2)', async () => {
    const { cookie } = await registerAndGetCookie();
    await patchJurisdiction(cookie, 'CA');

    const res = await patchLotMethod(cookie, 'fifo');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taxLotMethod).toBe('fifo');
    expect(body.effectiveMethod).toBe('acb');
    expect(body.isDefault).toBe(false);

    await patchJurisdiction(cookie, 'US');
    const afterUs = await authedRequest('GET', '/api/users/me/tax-lot-method', cookie);
    expect(afterUs.status).toBe(200);
    const afterUsBody = await afterUs.json();
    expect(afterUsBody.taxLotMethod).toBe('fifo');
    expect(afterUsBody.effectiveMethod).toBe('fifo');
    expect(afterUsBody.isDefault).toBe(false);
  });

  it('PATCH null clears the stored method and returns to the jurisdiction default (AC 2.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    await patchJurisdiction(cookie, 'CA');
    await patchLotMethod(cookie, 'fifo');

    const res = await patchLotMethod(cookie, null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taxLotMethod).toBeNull();
    expect(body.effectiveMethod).toBe('acb');
    expect(body.isDefault).toBe(true);
  });

  it("PATCH 'lifo' is rejected with 400", async () => {
    const { cookie } = await registerAndGetCookie();

    const res = await authedRequest('PATCH', '/api/users/me/tax-lot-method', cookie, {
      taxLotMethod: 'lifo',
    });
    expect(res.status).toBe(400);
  });

  it('requires a session for both GET and PATCH', async () => {
    const headers = { 'X-Forwarded-For': uniqueIp() };

    const getRes = await app.request('/api/users/me/tax-lot-method', { headers });
    expect(getRes.status).toBe(401);

    const patchRes = await app.request('/api/users/me/tax-lot-method', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taxLotMethod: 'fifo' }),
    });
    expect(patchRes.status).toBe(401);
  });

  it("a PATCH changes only the user's stored method, leaving fills and ledger rows unchanged", async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'USD acct', 'USD');
    const position = await openAndClose(cookie, acct.id, {
      symbol: 'LOTM',
      entryPrice: '100',
      exitPrice: '110',
      openedAt: '2026-01-10T15:00:00Z',
      closedAt: '2026-02-10T15:00:00Z',
    });

    const fillsBeforeRes = await authedRequest('GET', `/api/positions/${position.id}`, cookie);
    const fillsBefore = (await fillsBeforeRes.json()).fills;
    const ledgerBefore = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, position.id));

    const res = await patchLotMethod(cookie, 'fifo');
    expect(res.status).toBe(200);

    const fillsAfterRes = await authedRequest('GET', `/api/positions/${position.id}`, cookie);
    const fillsAfter = (await fillsAfterRes.json()).fills;
    const ledgerAfter = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, position.id));

    expect(fillsAfter).toEqual(fillsBefore);
    expect(ledgerAfter).toEqual(ledgerBefore);
  });
});

// DO NOT add describe() blocks below this line — see Task 17.4 (boundary-year vi.useFakeTimers scoping).
