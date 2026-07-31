import { eq, sql as drizzleSql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

import app, { bootstrap } from '@/app';
import { db } from '@/db';
import { ledgerEntries, positions as positionsTbl } from '@/db/schema';
import {
  registerCloseHook,
  unregisterCloseHook,
  listCloseHooks,
} from '@/features/positions/positions.service';

// ---------------------------------------------------------------------------
// Bootstrap opt-in (design.md §Testing Strategy > Integration Testing)
// ---------------------------------------------------------------------------
//
// This file installs the production 'ledger' close hook for the whole file
// via `bootstrap()`, and cleans it up in `afterAll`. Task 18's global
// `afterAll` registry sweep is a belt-and-suspenders net; per-file cleanup
// is still required.
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
// HTTP fixture helpers (mirrors brokerages.test.ts / positions.test.ts).
// ---------------------------------------------------------------------------

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `acct-int${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 400;
function uniqueIp() {
  return `10.4.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
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

async function getMe(cookie: string): Promise<{ id: string }> {
  const res = await authedRequest('GET', '/api/auth/me', cookie);
  expect(res.status).toBe(200);
  const data = await res.json();
  return data.user ?? data;
}

async function createAccount(cookie: string, name = 'Test Account', currency = 'USD') {
  const res = await authedRequest('POST', '/api/accounts', cookie, { name, currency });
  expect(res.status).toBe(201);
  return res.json();
}

async function createPosition(
  cookie: string,
  accountId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function addFill(
  cookie: string,
  positionId: string,
  data: { type: string; price: string; quantity: string; fees?: string; filledAt: string },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, data);
  expect(res.status).toBe(201);
  return res.json();
}

async function openPosition(cookie: string, positionId: string, openedAt?: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {
    openedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Ensures the position is closed. A balancing exit auto-closes it (R7
 * amendment), so callers that fully exit find it already closed and the
 * explicit route would 409.
 */
async function closePosition(cookie: string, positionId: string, closedAt?: string) {
  const existing = await authedRequest('GET', `/api/positions/${positionId}`, cookie);
  expect(existing.status).toBe(200);
  const position = await existing.json();
  if (position.status === 'closed') return position;

  const res = await authedRequest('POST', `/api/positions/${positionId}/close`, cookie, {
    closedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Open + close a position whose net P&L = (exit - entry) * qty - entryFees - exitFees.
 * Returns the closed position row.
 */
async function openAndClosePosition(
  cookie: string,
  accountId: string,
  opts: {
    entryPrice: string;
    exitPrice: string;
    quantity: string;
    entryFees?: string;
    exitFees?: string;
    symbol?: string;
  },
) {
  const pos = await createPosition(cookie, accountId, { symbol: opts.symbol ?? 'AAPL' });
  await addFill(cookie, pos.id, {
    type: 'entry',
    price: opts.entryPrice,
    quantity: opts.quantity,
    fees: opts.entryFees ?? '0',
    filledAt: '2026-01-01T00:00:00Z',
  });
  await openPosition(cookie, pos.id, '2026-01-01T00:00:00Z');
  await addFill(cookie, pos.id, {
    type: 'exit',
    price: opts.exitPrice,
    quantity: opts.quantity,
    fees: opts.exitFees ?? '0',
    filledAt: '2026-01-02T00:00:00Z',
  });
  await closePosition(cookie, pos.id, '2026-01-02T00:00:00Z');
  return pos;
}

// ---------------------------------------------------------------------------
// 1. GET /api/ledger/:accountId — pagination, ordering, running balance
// ---------------------------------------------------------------------------

describe('GET /api/ledger/:accountId', () => {
  it('paginates and returns entries in (occurred_at DESC, created_at DESC) order with hasMore', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccount(cookie, 'L Account', 'USD');

    // Close three profitable positions producing three credit ledger rows.
    await openAndClosePosition(cookie, account.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
      symbol: 'A',
    });
    await openAndClosePosition(cookie, account.id, {
      entryPrice: '10',
      exitPrice: '30',
      quantity: '1',
      symbol: 'B',
    });
    await openAndClosePosition(cookie, account.id, {
      entryPrice: '10',
      exitPrice: '40',
      quantity: '1',
      symbol: 'C',
    });

    // pageSize=2 → first page returns 2 entries, hasMore=true.
    const page1Res = await authedRequest(
      'GET',
      `/api/ledger/${account.id}?page=1&pageSize=2`,
      cookie,
    );
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.entries).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);

    // Page 2 returns the third entry; hasMore=false.
    const page2Res = await authedRequest(
      'GET',
      `/api/ledger/${account.id}?page=2&pageSize=2`,
      cookie,
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json();
    expect(page2.entries).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    // The first row of page2 corresponds to the oldest entry (the first
    // close, symbol 'A'); the running balance up to (exclusive) that row
    // sums all newer rows' credits − debits. With three +N credits all
    // older than... wait — the ordering is DESC. So page1[0] is the newest
    // close (symbol 'C'), page2[0] is the oldest (symbol 'A').
    // runningBalanceAtFirstRow on page2 = SUM over rows OLDER than page2[0]
    // = 0 entries → '0.00'.
    expect(page2.runningBalanceAtFirstRow).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// 2. Deleted-position row rendering via manual UPDATE position_id = NULL
// ---------------------------------------------------------------------------

describe('GET /api/ledger/:accountId — deleted position rendering', () => {
  it('returns the ledger row with positionId:null when the column was nulled', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccount(cookie, 'Acct', 'USD');
    await openAndClosePosition(cookie, account.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
    });

    // Manually NULL out the position_id (no v1 flow exercises the cascade).
    await db
      .update(ledgerEntries)
      .set({ positionId: null })
      .where(eq(ledgerEntries.accountId, account.id));

    const res = await authedRequest('GET', `/api/ledger/${account.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].positionId).toBeNull();
    // The row still carries `symbol` so the FE can render "<symbol> (deleted)".
    expect(body.entries[0].symbol).toBe('AAPL');
  });
});

// ---------------------------------------------------------------------------
// 3. ON DELETE SET NULL cascade + close-hook scoping
// ---------------------------------------------------------------------------

describe('positions ON DELETE SET NULL cascade + close-hook scoping', () => {
  it('raw tx.delete(positions) flips position_id → NULL AND adds zero new ledger rows', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccount(cookie, 'Cascade Acct', 'USD');
    const pos = await openAndClosePosition(cookie, account.id, {
      entryPrice: '10',
      exitPrice: '15',
      quantity: '1',
    });

    // Pre-DELETE: one ledger row with non-null position_id.
    const preRows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    expect(preRows).toHaveLength(1);
    expect(preRows[0].positionId).toBe(pos.id);

    // Raw query-layer DELETE bypassing removePosition's "rejects closed" guard.
    // This is a contract test — the close-hook is closePosition-scoped, NOT
    // raw-delete-scoped. A future hook wired on the registry that fires for
    // deletes would break this assertion.
    await db.delete(positionsTbl).where(eq(positionsTbl.id, pos.id));

    const postRows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    // (a) cascade fired — position_id NULLed.
    expect(postRows).toHaveLength(1);
    expect(postRows[0].positionId).toBeNull();
    // (b) hook did NOT fire — row count unchanged.
    expect(postRows.length).toBe(preRows.length);
  });
});

// ---------------------------------------------------------------------------
// 3b. Real removePosition path — reversal + ON DELETE SET NULL cascade (Req 7.11)
// ---------------------------------------------------------------------------
//
// Task 27 pays the cascade test "owed by Open Design Question 6". Section 3
// above drives a RAW `db.delete(positions)` with no reversal; this one goes
// through the production `DELETE /api/positions/:id` endpoint with the live
// close + reverse hooks (installed by `bootstrap()` in `beforeAll`), so it
// asserts the full owed contract via the REAL path (not a manual UPDATE):
//   (a) a `position_pnl_reversal` links back to the original close via
//       `reversesGroupId`;
//   (b) the `positions.positionId ON DELETE SET NULL` cascade NULLs `positionId`
//       on BOTH the original close row AND its reversal;
//   (c) the account balance returns to its pre-close value;
//   (d) the position is gone.

describe('DELETE /api/positions/:id — ledger reversal + ON DELETE SET NULL cascade (Req 7.11)', () => {
  async function getBalance(cookie: string, accountId: string): Promise<string> {
    const res = await authedRequest('GET', `/api/accounts/${accountId}`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()).balance;
  }

  it('reverses the close, NULLs positionId on original + reversal, and restores the pre-close balance', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccount(cookie, 'Cascade+Reversal Acct', 'USD');

    const preClose = await getBalance(cookie, account.id);
    expect(preClose).toBe('0.0000');

    // Close a +$10 position (entry 100, exit 110, qty 1).
    const pos = await openAndClosePosition(cookie, account.id, {
      entryPrice: '100',
      exitPrice: '110',
      quantity: '1',
    });

    // The close posted exactly one credit position_pnl row; capture its groupId.
    const closeRows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, pos.id));
    expect(closeRows).toHaveLength(1);
    expect(closeRows[0].entryType).toBe('position_pnl');
    expect(closeRows[0].direction).toBe('credit');
    const originalGroupId = closeRows[0].groupId;
    // Balance moved off its pre-close value.
    expect(await getBalance(cookie, account.id)).toBe('10.0000');

    // Real delete path: the reverse hook fires FIRST (posting the reversal),
    // then the position hard-deletes, firing the ON DELETE SET NULL cascade.
    const del = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(del.status).toBe(204);

    // positionId is NULL now, so query by account.
    const postRows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    // Two append-only rows survive: the original close + its reversal.
    expect(postRows).toHaveLength(2);

    const original = postRows.find((r) => r.entryType === 'position_pnl');
    const reversal = postRows.find((r) => r.entryType === 'position_pnl_reversal');
    expect(original).toBeDefined();
    expect(reversal).toBeDefined();

    // (a) the reversal links back to the original close via reversesGroupId,
    //     with a flipped direction and the same magnitude.
    expect(reversal!.reversesGroupId).toBe(originalGroupId);
    expect(reversal!.direction).toBe('debit');
    expect(reversal!.amount).toBe(original!.amount);

    // (b) the ON DELETE SET NULL cascade fired via the REAL delete — positionId
    //     is NULL on BOTH rows (not a hand-written UPDATE).
    expect(original!.positionId).toBeNull();
    expect(reversal!.positionId).toBeNull();

    // (c) the balance nets back to the pre-close value.
    expect(await getBalance(cookie, account.id)).toBe(preClose);

    // (d) the position is gone.
    const getRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4. POST /api/exchange-rates upsert
// ---------------------------------------------------------------------------

describe('POST /api/exchange-rates — upsert', () => {
  it('re-entry of the same (base, quote, effectiveDate) replaces the rate', async () => {
    const { cookie } = await registerAndGetCookie();

    const first = await authedRequest('POST', '/api/exchange-rates', cookie, {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.90',
      effectiveDate: '2026-01-01',
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.rate).toBe('0.900000000000');

    const second = await authedRequest('POST', '/api/exchange-rates', cookie, {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.95',
      effectiveDate: '2026-01-01',
    });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.rate).toBe('0.950000000000');

    const list = await authedRequest('GET', '/api/exchange-rates', cookie);
    const rows = await list.json();
    expect(rows.filter((r: { id: string }) => r.id === firstBody.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. DELETE /api/exchange-rates/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/exchange-rates/:id', () => {
  it('deletes a rate, second delete returns 404', async () => {
    const { cookie } = await registerAndGetCookie();
    const create = await authedRequest('POST', '/api/exchange-rates', cookie, {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9',
      effectiveDate: '2026-01-01',
    });
    const rate = await create.json();

    const del = await authedRequest('DELETE', `/api/exchange-rates/${rate.id}`, cookie);
    expect(del.status).toBe(204);

    const del2 = await authedRequest('DELETE', `/api/exchange-rates/${rate.id}`, cookie);
    expect(del2.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 6. POST /api/exchange-rates/preview
// ---------------------------------------------------------------------------

describe('POST /api/exchange-rates/preview', () => {
  it('upsert intent: first-rate-entry → before:null, after:non-null, exceedsThreshold:true', async () => {
    const { cookie } = await registerAndGetCookie();
    // Materialize display_currency=USD by creating an account.
    await createAccount(cookie, 'USD acct', 'USD');
    // EUR account holds a balance (close a profitable EUR position so the
    // aggregate has something to convert).
    const eur = await createAccount(cookie, 'EUR acct', 'EUR');
    await openAndClosePosition(cookie, eur.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
    });

    const res = await authedRequest('POST', '/api/exchange-rates/preview', cookie, {
      intent: 'upsert',
      rate: {
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rate: '1.10',
        effectiveDate: '2026-01-01',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.beforeTotal).toBeNull();
    expect(body.afterTotal).not.toBeNull();
    expect(body.exceedsThreshold).toBe(true);
  });

  it('delete intent: removing the only rate flips after to null and exceedsThreshold true', async () => {
    const { cookie } = await registerAndGetCookie();
    await createAccount(cookie, 'USD acct', 'USD');
    const eur = await createAccount(cookie, 'EUR acct', 'EUR');
    await openAndClosePosition(cookie, eur.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
    });

    const createRate = await authedRequest('POST', '/api/exchange-rates', cookie, {
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.00',
      effectiveDate: '2026-01-01',
    });
    const rate = await createRate.json();

    const res = await authedRequest('POST', '/api/exchange-rates/preview', cookie, {
      intent: 'delete',
      rateId: rate.id,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.beforeTotal).not.toBeNull();
    expect(body.afterTotal).toBeNull();
    expect(body.exceedsThreshold).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. GET /api/dashboard/totals
// ---------------------------------------------------------------------------

describe('GET /api/dashboard/totals', () => {
  it('happy path: returns aggregate total in display currency', async () => {
    const { cookie } = await registerAndGetCookie();
    const usd = await createAccount(cookie, 'USD acct', 'USD');
    await openAndClosePosition(cookie, usd.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
    });

    const res = await authedRequest('GET', '/api/dashboard/totals', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayCurrency).toBe('USD');
    expect(body.total).not.toBeNull();
    // single account, single $10 profit
    expect(body.total).toBe('10.0000');
    // missingPairs is omitted when empty (route contract).
    expect(body.missingPairs).toBeUndefined();
  });

  it('missing-rate scenario: returns total:null + missingPairs sorted (base ASC, quote ASC)', async () => {
    const { cookie } = await registerAndGetCookie();
    // First account → materializes display_currency=USD.
    await createAccount(cookie, 'USD acct', 'USD');
    // Second account in a different currency, with a balance, no rate.
    const eur = await createAccount(cookie, 'EUR acct', 'EUR');
    await openAndClosePosition(cookie, eur.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
    });

    const res = await authedRequest('GET', '/api/dashboard/totals', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayCurrency).toBe('USD');
    expect(body.total).toBeNull();
    expect(body.missingPairs).toBeDefined();
    expect(body.missingPairs).toEqual([{ baseCurrency: 'EUR', quoteCurrency: 'USD' }]);
  });
});

// ---------------------------------------------------------------------------
// 8. GET /api/accounts and GET /api/accounts/:id include balance
// ---------------------------------------------------------------------------

describe('GET /api/accounts — balance field', () => {
  it('list response includes per-account balance derived from ledger', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'B Account', 'USD');
    await openAndClosePosition(cookie, acct.id, {
      entryPrice: '10',
      exitPrice: '15',
      quantity: '1',
    });

    const res = await authedRequest('GET', '/api/accounts', cookie);
    expect(res.status).toBe(200);
    const rows = await res.json();
    const row = rows.find((r: { id: string }) => r.id === acct.id);
    expect(row).toBeDefined();
    expect(row).toHaveProperty('balance');
    // Profit of $5; balance projection is numeric(18,4)::text COALESCEd.
    expect(row.balance).toBe('5.0000');
  });

  it('accounts with no ledger entries report balance "0.0000"', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'Empty Account', 'USD');
    const res = await authedRequest('GET', '/api/accounts', cookie);
    const rows = await res.json();
    const row = rows.find((r: { id: string }) => r.id === acct.id);
    expect(row.balance).toBe('0.0000');
  });

  it('balance = starting balance + ledger P&L', async () => {
    const { cookie } = await registerAndGetCookie();
    const createRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Seeded Account',
      currency: 'USD',
      startingBalance: '1000.5',
    });
    expect(createRes.status).toBe(201);
    const acct = await createRes.json();
    // Profit of $5 on top of the 1000.50 starting balance.
    await openAndClosePosition(cookie, acct.id, {
      entryPrice: '10',
      exitPrice: '15',
      quantity: '1',
    });

    const res = await authedRequest('GET', '/api/accounts', cookie);
    const rows = await res.json();
    const row = rows.find((r: { id: string }) => r.id === acct.id);
    expect(row.balance).toBe('1005.5000');
  });

  it('starting balance is included in dashboard totals', async () => {
    const { cookie } = await registerAndGetCookie();
    const createRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Seeded USD acct',
      currency: 'USD',
      startingBalance: '100',
    });
    expect(createRes.status).toBe(201);
    const acct = await createRes.json();
    await openAndClosePosition(cookie, acct.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
    });

    const res = await authedRequest('GET', '/api/dashboard/totals', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    // 100 starting + $10 profit.
    expect(body.total).toBe('110.0000');
  });

  it('starting balance anchors the ledger running balance', async () => {
    const { cookie } = await registerAndGetCookie();
    const createRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Seeded Ledger acct',
      currency: 'USD',
      startingBalance: '100',
    });
    expect(createRes.status).toBe(201);
    const acct = await createRes.json();
    await openAndClosePosition(cookie, acct.id, {
      entryPrice: '10',
      exitPrice: '20',
      quantity: '1',
    });

    const res = await authedRequest('GET', `/api/ledger/${acct.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    // No rows older than the page's first row, so the anchor is exactly the
    // starting balance — folding the page's single +10 entry forward lands on
    // the account's derived balance of 110.
    expect(body.runningBalanceAtFirstRow).toBe('100.00');
  });
});

describe('GET /api/accounts/:id — balance field', () => {
  it('detail response includes balance (Task 21 useAccount data source)', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'D Account', 'USD');
    await openAndClosePosition(cookie, acct.id, {
      entryPrice: '10',
      exitPrice: '17',
      quantity: '1',
    });

    const res = await authedRequest('GET', `/api/accounts/${acct.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(acct.id);
    expect(body).toHaveProperty('balance');
    expect(body.balance).toBe('7.0000');
  });
});

// ---------------------------------------------------------------------------
// 9. Cross-spec close: profit, loss, zero P&L → correct ledger rows
// ---------------------------------------------------------------------------

describe('cross-spec close → ledger row shape (production hook installed)', () => {
  it('profit → exactly one credit position_pnl row with correct magnitude', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'Profit Acct', 'USD');
    const pos = await openAndClosePosition(cookie, acct.id, {
      entryPrice: '100',
      exitPrice: '120',
      quantity: '1',
    });
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.positionId, pos.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].entryType).toBe('position_pnl');
    expect(rows[0].direction).toBe('credit');
    expect(rows[0].amount).toBe('20.0000');
    expect(rows[0].currency).toBe('USD');
  });

  it('loss → exactly one debit position_pnl row with positive magnitude', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'Loss Acct', 'USD');
    const pos = await openAndClosePosition(cookie, acct.id, {
      entryPrice: '100',
      exitPrice: '70',
      quantity: '1',
    });
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.positionId, pos.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('debit');
    expect(rows[0].amount).toBe('30.0000');
  });

  it('zero P&L → exactly one credit row with amount "0.0000"', async () => {
    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'Zero Acct', 'USD');
    const pos = await openAndClosePosition(cookie, acct.id, {
      entryPrice: '100',
      exitPrice: '100',
      quantity: '1',
    });
    const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.positionId, pos.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('credit');
    expect(rows[0].amount).toBe('0.0000');
  });
});

// ---------------------------------------------------------------------------
// 10. Mid-hook failure → position remains 'open', no ledger row persisted.
// ---------------------------------------------------------------------------
//
// The task spec asks for a "duplicate-key violation mid-hook" — but the v1
// schema has no unique constraint on the ledger row a second hook could
// duplicate. The functionally-equivalent guarantee the spec actually cares
// about is: ANY mid-hook failure → full transactional rollback. We register
// an extra test-scoped hook that throws unconditionally; the production
// 'ledger' hook runs first, the extra hook throws second, and we assert the
// entire transaction (position update + production-hook ledger insert) was
// rolled back. The duplicate-key mechanism is unavailable; this throw is
// the safe, deterministic proxy for "transient mid-hook failure".

describe('mid-hook failure leaves the position open with zero ledger rows', () => {
  afterEach(() => {
    // The production 'ledger' hook is kept across tests; this teardown
    // removes any test-scoped extras and never touches 'ledger'.
    for (const name of listCloseHooks()) {
      if (name !== 'ledger') unregisterCloseHook(name);
    }
  });

  it('second hook throws → ledger row from first hook AND status update both reverted', async () => {
    // Sanity: production hook is registered, no test-scoped extras.
    expect(listCloseHooks()).toEqual(['ledger']);

    registerCloseHook('test-bomb', async () => {
      throw new Error('intentional mid-hook failure');
    });

    const { cookie } = await registerAndGetCookie();
    const acct = await createAccount(cookie, 'Rollback Acct', 'USD');
    const me = await getMe(cookie);

    // Build a fully-closable position via the API, then issue the close;
    // the close MUST fail because the bomb hook throws.
    const pos = await createPosition(cookie, acct.id, { symbol: 'AAPL' });
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '1',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    await openPosition(cookie, pos.id, '2026-01-01T00:00:00Z');

    // The balancing exit auto-closes the position (R7 amendment), so the bomb
    // hook now fires inside the FILL request rather than a separate close.
    // Everything rides one transaction, so the fill that triggered the close
    // must roll back with it — a saved exit whose close never landed would
    // leave a fully-exited-but-open position and no ledger row.
    const exitRes = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '110',
      quantity: '1',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    // The error handler maps thrown Error → 500.
    expect(exitRes.status).toBeGreaterThanOrEqual(500);

    // The exit fill itself was rolled back — only the entry survives.
    const detail = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.fills.filter((f: { type: string }) => f.type === 'exit')).toHaveLength(0);

    // Position status reverted to 'open' (close transaction rolled back).
    const positionRows = await db.select().from(positionsTbl).where(eq(positionsTbl.id, pos.id));
    expect(positionRows).toHaveLength(1);
    expect(positionRows[0].status).toBe('open');

    // No ledger row was persisted — the production 'ledger' hook's insert
    // and the bomb hook's throw rolled back atomically.
    const ledgerRows = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, pos.id));
    expect(ledgerRows[0].count).toBe(0);

    // User scoping pin (caught at compile time below: typeof me.id is string).
    expect(typeof me.id).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// POST /api/ledger/:accountId/reconcile — cash balance reconciliation (Req 8)
// ---------------------------------------------------------------------------

describe('POST /api/ledger/:accountId/reconcile', () => {
  async function createAccountWithBalance(
    cookie: string,
    name: string,
    startingBalance: string,
    currency = 'USD',
  ) {
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name,
      currency,
      startingBalance,
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  async function reconcile(cookie: string, accountId: string, targetBalance: string) {
    return authedRequest('POST', `/api/ledger/${accountId}/reconcile`, cookie, { targetBalance });
  }

  async function getBalance(cookie: string, accountId: string): Promise<string> {
    const res = await authedRequest('GET', `/api/accounts/${accountId}`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()).balance;
  }

  it('reconciling UP posts one credit balance_adjustment and lands the balance on the target', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Up', '1000');

    const res = await reconcile(cookie, account.id, '1250.50');
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.previousBalance).toBe('1000.0000');
    expect(body.newBalance).toBe('1250.5000');
    expect(body.entry.entryType).toBe('balance_adjustment');
    expect(body.entry.direction).toBe('credit');
    expect(body.entry.amount).toBe('250.5000');
    expect(body.entry.currency).toBe('USD');
    // Not tied to a trade — this is what keeps it out of the tax summary.
    expect(body.entry.positionId).toBeNull();
    expect(body.entry.symbol).toBeNull();

    expect(await getBalance(cookie, account.id)).toBe('1250.5000');
  });

  it('reconciling DOWN posts a debit', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Down', '1000');

    const res = await reconcile(cookie, account.id, '900');
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.entry.direction).toBe('debit');
    // `amount` is a non-negative magnitude — the sign lives in `direction`.
    expect(body.entry.amount).toBe('100.0000');
    expect(await getBalance(cookie, account.id)).toBe('900.0000');
  });

  // This is the test that catches a missed entry-type filter. The
  // ('position_pnl','position_pnl_reversal') list is hand-written in five
  // places, three of them raw SQL; each derivation site below reads a
  // DIFFERENT one of those copies.
  it('the adjusted balance agrees across all three derivation sites', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Sites', '1000');
    expect((await reconcile(cookie, account.id, '1400')).status).toBe(201);

    // Site 1 — `balanceLateral` in accounts.query.ts (account detail + list).
    expect(await getBalance(cookie, account.id)).toBe('1400.0000');
    const listRes = await authedRequest('GET', '/api/accounts', cookie);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()).find((a: { id: string }) => a.id === account.id);
    expect(listed.balance).toBe('1400.0000');

    // Site 2 — `aggregateBalancesForAccounts` (dashboard totals). Single USD
    // account, so the display-currency aggregate is the balance itself.
    const totalsRes = await authedRequest('GET', '/api/dashboard/totals', cookie);
    expect(totalsRes.status).toBe(200);
    const totals = await totalsRes.json();
    expect(totals.displayCurrency).toBe('USD');
    expect(totals.total).toBe('1400.0000');

    // Site 3 — `listLedgerEntriesForAccount`'s running-balance anchor. A second
    // reconcile gives an OLDER adjustment row for the anchor to sum over: with
    // pageSize=1 the anchor is the balance before the newest row, which must
    // already include the first adjustment.
    expect((await reconcile(cookie, account.id, '1750')).status).toBe(201);
    const ledgerRes = await authedRequest(
      'GET',
      `/api/ledger/${account.id}?page=1&pageSize=1`,
      cookie,
    );
    expect(ledgerRes.status).toBe(200);
    const ledger = await ledgerRes.json();
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].amount).toBe('350.0000');
    // 1000 starting + the first 400 adjustment. Would be '1000.00' if the
    // anchor's raw-SQL filter had not been widened.
    expect(ledger.runningBalanceAtFirstRow).toBe('1400.00');
  });

  it('rejects a zero delta with 409 and writes nothing', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Noop', '1000');

    const res = await reconcile(cookie, account.id, '1000');
    expect(res.status).toBe(409);

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    expect(rows).toHaveLength(0);
    expect(await getBalance(cookie, account.id)).toBe('1000.0000');
  });

  it('404s for an unknown account and for another user’s account, writing nothing', async () => {
    const { cookie } = await registerAndGetCookie();
    const { cookie: otherCookie } = await registerAndGetCookie();
    const victim = await createAccountWithBalance(otherCookie, 'Victim Acct', '1000');

    const unknown = await reconcile(cookie, '00000000-0000-4000-8000-000000000000', '50');
    expect(unknown.status).toBe(404);

    const crossUser = await reconcile(cookie, victim.id, '50');
    expect(crossUser.status).toBe(404);

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, victim.id));
    expect(rows).toHaveLength(0);
    expect(await getBalance(otherCookie, victim.id)).toBe('1000.0000');
  });

  it('rejects a target too precise for the account currency', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Precision', '1000');

    // USD has 2 minor units; 3+ decimals is not a figure any statement shows.
    const res = await reconcile(cookie, account.id, '1000.123');
    expect(res.status).toBe(400);

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    expect(rows).toHaveLength(0);
  });

  it('accepts a negative target (margin/debit balance)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Margin', '1000');

    const res = await reconcile(cookie, account.id, '-250.00');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry.direction).toBe('debit');
    expect(body.entry.amount).toBe('1250.0000');
    expect(await getBalance(cookie, account.id)).toBe('-250.0000');
  });

  // Proves the delta is computed server-side from the live balance rather than
  // taken from the client: the second reconcile has to account for the P&L that
  // landed in between.
  it('reconcile → close → reconcile composes on the live balance', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Sequence', '1000');

    expect((await reconcile(cookie, account.id, '1200')).status).toBe(201);
    expect(await getBalance(cookie, account.id)).toBe('1200.0000');

    // +$10 realized P&L.
    await openAndClosePosition(cookie, account.id, {
      entryPrice: '100',
      exitPrice: '110',
      quantity: '1',
    });
    expect(await getBalance(cookie, account.id)).toBe('1210.0000');

    const res = await reconcile(cookie, account.id, '1500');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.previousBalance).toBe('1210.0000');
    expect(body.entry.amount).toBe('290.0000');
    expect(await getBalance(cookie, account.id)).toBe('1500.0000');
  });

  // Req 8.9 — there is no undo. A wrong figure is corrected by reconciling
  // again, and BOTH rows survive as the audit trail.
  it('a mistyped figure is corrected by re-reconciling, retaining both rows', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Fix', '1000');

    expect((await reconcile(cookie, account.id, '100000')).status).toBe(201);
    expect((await reconcile(cookie, account.id, '10000')).status).toBe(201);

    expect(await getBalance(cookie, account.id)).toBe('10000.0000');

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.entryType === 'balance_adjustment')).toBe(true);
  });

  it('surfaces the adjustment in the ledger list with a null position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Recon Ledger', '500');
    expect((await reconcile(cookie, account.id, '750')).status).toBe(201);

    const res = await authedRequest('GET', `/api/ledger/${account.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].entryType).toBe('balance_adjustment');
    expect(body.entries[0].positionId).toBeNull();
    expect(body.entries[0].symbol).toBeNull();
    // NOTE: `userId` / `reversesGroupId` are NOT asserted absent here. The
    // ledger LIST route returns raw rows, so those internal columns are on the
    // wire today for every entry type — a pre-existing gap against Req 1, not
    // something reconciliation introduces. Pinning it here would pin the wrong
    // contract for the wrong feature.
  });
});

// ---------------------------------------------------------------------------
// Per-fill realized P&L posting (Req 9, design §C15–C18)
// ---------------------------------------------------------------------------

describe('per-fill realized P&L posting', () => {
  async function createAccountWithBalance(cookie: string, name: string, startingBalance = '1000') {
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name,
      currency: 'USD',
      startingBalance,
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  async function getBalance(cookie: string, accountId: string): Promise<string> {
    const res = await authedRequest('GET', `/api/accounts/${accountId}`, cookie);
    expect(res.status).toBe(200);
    return (await res.json()).balance;
  }

  async function pnlRows(accountId: string) {
    return db
      .select()
      .from(ledgerEntries)
      .where(
        drizzleSql`${ledgerEntries.accountId} = ${accountId} AND ${ledgerEntries.entryType} = 'position_pnl'`,
      );
  }

  /** Open a position with a single entry fill; leave it open. */
  async function openWithEntry(
    cookie: string,
    accountId: string,
    opts: { price: string; quantity: string; fees?: string; symbol?: string },
  ) {
    const pos = await createPosition(cookie, accountId, { symbol: opts.symbol ?? 'AAPL' });
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: opts.price,
      quantity: opts.quantity,
      fees: opts.fees ?? '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    await openPosition(cookie, pos.id, '2026-01-01T00:00:00Z');
    return pos;
  }

  // The §C18 regression pin. If this ever fails, the change broke the common
  // case — that is an implementation bug, never an expected update.
  it('a whole trade still posts exactly ONE row, unchanged from close-time posting', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'C18 Pin');

    await openAndClosePosition(cookie, account.id, {
      entryPrice: '100',
      exitPrice: '110',
      quantity: '1',
    });

    const rows = await pnlRows(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('credit');
    expect(rows[0].amount).toBe('10.0000');
    expect(await getBalance(cookie, account.id)).toBe('1010.0000');
  });

  it('an entry-only position posts nothing (Req 9.4)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Entry Only');

    await openWithEntry(cookie, account.id, { price: '100', quantity: '10' });

    expect(await pnlRows(account.id)).toHaveLength(0);
    expect(await getBalance(cookie, account.id)).toBe('1000.0000');
  });

  // The design §C15 worked example. This is the test that catches an
  // accumulate-instead-of-recompute implementation: the second partial must
  // post 45, not 90.
  it('two partial exits post 45 then 45 — fee proration stays exact', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Two Partials');

    // Entry 10 @ $100 with $10 fees.
    const pos = await openWithEntry(cookie, account.id, {
      price: '100',
      quantity: '10',
      fees: '10',
    });

    // First partial: 5 @ $110 → (110-100)*5 - (10 * 5/10) = 45.
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });

    let rows = await pnlRows(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('credit');
    expect(rows[0].amount).toBe('45.0000');
    // The balance moves immediately — the whole point of Req 9.
    expect(await getBalance(cookie, account.id)).toBe('1045.0000');

    // Second partial: cumulative becomes (110-100)*10 - 10 = 90, so the delta
    // is 45 again — NOT 90.
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-03T00:00:00Z',
    });

    rows = await pnlRows(account.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount).sort()).toEqual(['45.0000', '45.0000']);
    // Cumulative counted exactly once.
    expect(await getBalance(cookie, account.id)).toBe('1090.0000');

    // The balancing exit auto-closed the position; the close hook's delta was
    // zero, so it added no third row.
    const detail = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect((await detail.json()).status).toBe('closed');
    expect(await pnlRows(account.id)).toHaveLength(2);
  });

  it('deleting an exit fill posts a correcting debit (Req 9.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Delete Exit');

    const pos = await openWithEntry(cookie, account.id, { price: '100', quantity: '10' });
    const exitRes = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '110',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    expect(exitRes.status).toBe(201);
    const exitFill = await exitRes.json();
    expect(await getBalance(cookie, account.id)).toBe('1050.0000');

    const del = await authedRequest(
      'DELETE',
      `/api/positions/${pos.id}/fills/${exitFill.id}`,
      cookie,
    );
    expect(del.status).toBe(204);

    // Append-only: the original credit stays, a debit neutralizes it.
    const rows = await pnlRows(account.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.direction === 'debit')).toHaveLength(1);
    expect(await getBalance(cookie, account.id)).toBe('1000.0000');
  });

  it('editing an exit fill re-derives the posted amount (Req 9.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Edit Exit');

    const pos = await openWithEntry(cookie, account.id, { price: '100', quantity: '10' });
    const exitRes = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '110',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const exitFill = await exitRes.json();
    expect(await getBalance(cookie, account.id)).toBe('1050.0000');

    // Correct the price down: cumulative becomes (105-100)*5 = 25.
    const edit = await authedRequest(
      'PUT',
      `/api/positions/${pos.id}/fills/${exitFill.id}`,
      cookie,
      { price: '105' },
    );
    expect(edit.status).toBe(200);

    expect(await getBalance(cookie, account.id)).toBe('1025.0000');
    const rows = await pnlRows(account.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.direction === 'debit')[0].amount).toBe('25.0000');
  });

  // Req 9.2 — the un-reversed filter is what makes this work. If
  // sumPostedRealizedForPosition counted reversed rows, the re-close would post
  // a delta against postings that have already been neutralized.
  it('reopen reverses every row and resets the posted baseline to zero', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createAccountWithBalance(cookie, 'Reopen Baseline');

    // Reopen is guarded to the position's OPEN DAY in the account's timezone
    // (R13-AC1/AC2), so this fixture must be same-day. `now` for every fill
    // keeps it same-day under any timezone without a clock-boundary race.
    const now = new Date().toISOString();

    const pos = await createPosition(cookie, account.id, { symbol: 'RBASE' });
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '0',
      filledAt: now,
    });
    await openPosition(cookie, pos.id, now);

    // Two partials → two rows, the second auto-closing the position.
    for (let i = 0; i < 2; i++) {
      await addFill(cookie, pos.id, {
        type: 'exit',
        price: '110',
        quantity: '5',
        fees: '0',
        filledAt: now,
      });
    }
    expect(await pnlRows(account.id)).toHaveLength(2);
    expect(await getBalance(cookie, account.id)).toBe('1100.0000');

    const reopen = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {});
    expect(reopen.status).toBe(200);

    // Both originals reversed → balance back to the pre-trade value.
    expect(await getBalance(cookie, account.id)).toBe('1000.0000');
    const afterReopen = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, account.id));
    expect(afterReopen.filter((r) => r.entryType === 'position_pnl_reversal')).toHaveLength(2);

    // The baseline is now zero because sumPostedRealizedForPosition ignores
    // reversed rows (Req 9.2). Scaling into the position with another entry
    // re-realizes the cumulative P&L against the new average cost and posts it
    // ONCE. Note the exit fills survive the reopen, so entry and exit quantities
    // are still balanced — adding another exit would exceed entry; adding an
    // entry is the real "reopen to scale in" case.
    //
    // This is the discriminating assertion: if reversed rows still counted
    // toward the baseline, the delta would come out at 0 and the balance would
    // stay at 1000.
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '5',
      fees: '0',
      filledAt: now,
    });
    // entry 15 @ 100, exit 10 @ 110 → realized (110−100) × 10 = 100.
    expect(await getBalance(cookie, account.id)).toBe('1100.0000');
  });
});

// ---------------------------------------------------------------------------
// Fee-model unification: ledger, position detail and performance must agree
// ---------------------------------------------------------------------------
//
// These three surfaces used to compute net realized P&L three different ways:
//   ledger           computePnlFromTotals                  (fills.fees only)
//   position detail  computePnlFromTotals − scheduleFees   (fills.fees TWICE)
//   performance      computeGrossPnl     − scheduleFees    (schedule only)
//
// A brokerage fee schedule is an ENTRY-TIME convenience — `FillDialog` computes
// the fee from it as the user types and stores the result on `fills.fees`,
// overridable. Re-applying it at read time double-counts. Nothing existed to
// catch the divergence, which is how it drifted; these are that test.

describe('net realized P&L is consistent across ledger, position detail and performance', () => {
  async function createBrokerageWithFees(cookie: string, name: string) {
    const res = await authedRequest('POST', '/api/brokerages', cookie, { name });
    expect(res.status).toBe(201);
    const brokerage = await res.json();
    // A non-zero schedule is the whole point: if any surface re-applies it on
    // top of fills.fees, the numbers below diverge.
    const upd = await authedRequest('PUT', `/api/brokerages/${brokerage.id}`, cookie, {
      name,
      feeSchedule: {
        stockPerShareCommission: '0.01',
        stockMinPerFill: '1',
        stockMaxPerFill: '10',
        optionsPerContractCommission: '0.65',
        optionsPerContractExchangeFee: '0.05',
        optionsMinPerFill: '0',
        optionsMaxPerFill: '10',
      },
    });
    expect(upd.status).toBe(200);
    return brokerage;
  }

  it('a position with recorded fill fees AND a fee schedule reports one number everywhere', async () => {
    const { cookie } = await registerAndGetCookie();
    const brokerage = await createBrokerageWithFees(cookie, 'Fee Broker');

    const acctRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Fee Model Acct',
      currency: 'USD',
      startingBalance: '1000',
      brokerageId: brokerage.id,
    });
    expect(acctRes.status).toBe(201);
    const account = await acctRes.json();

    // Entry 10 @ $100 with $5 recorded fees; exit 10 @ $110 with $5 recorded.
    // Gross = (110 − 100) × 10 = 100. Recorded fees = 10. Net = 90.
    const pos = await createPosition(cookie, account.id, { symbol: 'FEEZ' });
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '5',
      filledAt: '2026-03-02T00:00:00Z',
    });
    await openPosition(cookie, pos.id, '2026-03-02T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '10',
      fees: '5',
      filledAt: '2026-03-03T00:00:00Z',
    });

    // 1. Ledger / account balance.
    const balRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    expect(balRes.status).toBe(200);
    expect((await balRes.json()).balance).toBe('1090.0000');

    // 2. Position detail. grossPnl is the pre-fee figure, brokerageFees the
    //    fees RECORDED on the fills — not a schedule estimate — and the
    //    breakdown reconciles.
    const detailRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.netPnl).toBe(90);
    expect(detail.grossPnl).toBe(100);
    expect(detail.brokerageFees).toBe(10);
    expect(detail.grossPnl - detail.brokerageFees).toBe(detail.netPnl);

    // 3. Performance. Same trade, same number — previously this reported 100
    //    (gross) or a schedule-derived figure, never 90.
    const perfRes = await authedRequest(
      'GET',
      '/api/performance?' +
        new URLSearchParams({
          granularity: 'day',
          start: '2026-03-01T00:00:00.000Z',
          end: '2026-03-31T00:00:00.000Z',
          tz: 'UTC',
          currency: 'USD',
        }).toString(),
      cookie,
    );
    expect(perfRes.status).toBe(200);
    const perf = await perfRes.json();
    const usd = perf.currencies.find((c: { code: string }) => c.code === 'USD');
    expect(usd.stats.totalNetPnl).toBe('90');
    // The per-bucket breakdown reconciles too: gross 100 − fees 10 = net 90.
    const bucket = usd.series.find((b: { totalPositions: number }) => b.totalPositions > 0);
    expect(bucket.grossPnl).toBe('100');
    expect(bucket.fees).toBe('10');
    expect(bucket.netPnl).toBe('90');
  });

  it('with NO fee schedule, performance still nets the recorded fill fees', async () => {
    // The self-hosted default. Performance used to skip its fee block entirely
    // when no schedule existed and report gross, so the equity curve and the
    // account balance disagreed by exactly the fees the user had recorded.
    const { cookie } = await registerAndGetCookie();
    const acctRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'No Schedule Acct',
      currency: 'USD',
      startingBalance: '1000',
    });
    const account = await acctRes.json();

    const pos = await createPosition(cookie, account.id, { symbol: 'NOSCH' });
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '5',
      filledAt: '2026-03-02T00:00:00Z',
    });
    await openPosition(cookie, pos.id, '2026-03-02T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '10',
      fees: '5',
      filledAt: '2026-03-03T00:00:00Z',
    });

    expect(
      (await (await authedRequest('GET', `/api/accounts/${account.id}`, cookie)).json()).balance,
    ).toBe('1090.0000');

    const perfRes = await authedRequest(
      'GET',
      '/api/performance?' +
        new URLSearchParams({
          granularity: 'day',
          start: '2026-03-01T00:00:00.000Z',
          end: '2026-03-31T00:00:00.000Z',
          tz: 'UTC',
          currency: 'USD',
        }).toString(),
      cookie,
    );
    expect(perfRes.status).toBe(200);
    const perf = await perfRes.json();
    const usd = perf.currencies.find((c: { code: string }) => c.code === 'USD');
    expect(usd.stats.totalNetPnl).toBe('90');
  });
});

// ---------------------------------------------------------------------------
// Bucket A/B split: which metrics may use a partially-closed position
// ---------------------------------------------------------------------------
//
// Rule: a metric that REQUIRES a completed trade excludes positions that are not
// flat (win rate, profit factor, avg/largest win/loss, breakeven rate, counts).
// A metric that CAN use a partial realization does (total P&L, the equity
// curve, per-bucket P&L).

describe('performance bucket A/B split', () => {
  function perfQuery(overrides: Record<string, string> = {}) {
    return (
      '/api/performance?' +
      new URLSearchParams({
        granularity: 'day',
        start: '2026-04-01T00:00:00.000Z',
        end: '2026-04-30T00:00:00.000Z',
        tz: 'UTC',
        currency: 'USD',
        ...overrides,
      }).toString()
    );
  }

  async function usdAccount(cookie: string, name: string) {
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name,
      currency: 'USD',
      startingBalance: '1000',
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it('a partial exit contributes P&L but NOT to win rate or position counts', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await usdAccount(cookie, 'Bucket Split');

    // Entry 10 @ $100, then exit only 5 @ $110 → +50 realized, position OPEN.
    const pos = await createPosition(cookie, account.id, { symbol: 'SPLIT' });
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '0',
      filledAt: '2026-04-02T00:00:00Z',
    });
    await openPosition(cookie, pos.id, '2026-04-02T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      fees: '0',
      filledAt: '2026-04-03T00:00:00Z',
    });

    const detail = await (await authedRequest('GET', `/api/positions/${pos.id}`, cookie)).json();
    expect(detail.status).toBe('open');

    const perf = await (await authedRequest('GET', perfQuery(), cookie)).json();
    const usd = perf.currencies.find((c: { code: string }) => c.code === 'USD');

    // Bucket B — the realization counts immediately, in the bucket where the
    // exit fill actually happened.
    expect(usd.stats.totalNetPnl).toBe('50');
    const bucket = usd.series.find((b: { bucketStart: string }) =>
      b.bucketStart.startsWith('2026-04-03'),
    );
    expect(bucket.netPnl).toBe('50');
    // And the equity curve ends at the same figure.
    expect(usd.equityCurve[usd.equityCurve.length - 1].cumulativeNetPnl).toBe('50');

    // Bucket A — nothing is a completed trade yet.
    expect(usd.stats.winRate).toBeNull();
    expect(usd.stats.profitFactor).toBeNull();
    expect(usd.stats.avgWin).toBeNull();
    expect(usd.stats.largestWin).toBeNull();
    expect(usd.stats.totalPositions).toBe(0);
    // The P&L bucket carries no position count — a partial exit on a position
    // that has not gone flat. Intended, not an inconsistency.
    expect(bucket.totalPositions).toBe(0);
    expect(bucket.wins).toBe(0);
  });

  it('once flat, the same position joins the bucket-A statistics exactly once', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await usdAccount(cookie, 'Bucket Flat');

    const pos = await createPosition(cookie, account.id, { symbol: 'FLATZ' });
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '0',
      filledAt: '2026-04-02T00:00:00Z',
    });
    await openPosition(cookie, pos.id, '2026-04-02T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      fees: '0',
      filledAt: '2026-04-03T00:00:00Z',
    });
    // Second half, a day later — auto-closes the position.
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      fees: '0',
      filledAt: '2026-04-04T00:00:00Z',
    });

    const perf = await (await authedRequest('GET', perfQuery(), cookie)).json();
    const usd = perf.currencies.find((c: { code: string }) => c.code === 'USD');

    // Bucket B — total counted once, and SPLIT across the two days it was
    // actually realized on, not lumped onto the close date.
    expect(usd.stats.totalNetPnl).toBe('100');
    const d3 = usd.series.find((b: { bucketStart: string }) =>
      b.bucketStart.startsWith('2026-04-03'),
    );
    const d4 = usd.series.find((b: { bucketStart: string }) =>
      b.bucketStart.startsWith('2026-04-04'),
    );
    expect(d3.netPnl).toBe('50');
    expect(d4.netPnl).toBe('50');

    // Bucket A — one completed trade, one win, counted on the close date only.
    expect(usd.stats.totalPositions).toBe(1);
    expect(usd.stats.winRate).toBe(100);
    expect(d3.totalPositions).toBe(0);
    expect(d4.totalPositions).toBe(1);
    expect(d4.wins).toBe(1);
  });
});
