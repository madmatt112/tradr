import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { positions } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import { getTierLimits } from '@/features/billing/tier-limits.constants';
import {
  replaceCloseHook,
  unregisterCloseHook,
  replaceReverseHook,
  unregisterReverseHook,
} from '@/features/positions/positions.service';
import { config } from '@/lib/config';

let testCounter = 0;
function uniqueEmail() {
  return `pos-test${Date.now()}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.99.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(
  email = uniqueEmail(),
): Promise<{ cookie: string; email: string }> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  expect(cookie).toBeDefined();
  return { cookie, email };
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

async function createTestAccount(cookie: string, name = 'Test Account', currency = 'USD') {
  const res = await authedRequest('POST', '/api/accounts', cookie, { name, currency });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestPosition(
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
  data: {
    type: string;
    price: string;
    quantity: string;
    fees?: string;
    filledAt: string;
    notes?: string;
  },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, data);
  expect(res.status).toBe(201);
  return res.json();
}

async function openTestPosition(cookie: string, positionId: string, openedAt?: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {
    openedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function closeTestPosition(cookie: string, positionId: string, closedAt?: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/close`, cookie, {
    closedAt,
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('positions', () => {
  // 1. Create draft position — success
  it('creates a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const res = await authedRequest('POST', '/api/positions', cookie, {
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.symbol).toBe('AAPL');
    expect(body.side).toBe('long');
    expect(body.assetType).toBe('stock');
    expect(body.status).toBe('draft');
    expect(body.accountId).toBe(account.id);
  });

  // 1b. Create an option position with a valid compact OCC symbol → 201
  it('creates an option position with a valid compact OCC symbol', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const res = await authedRequest('POST', '/api/positions', cookie, {
      accountId: account.id,
      symbol: 'AAPL260116C150',
      side: 'long',
      assetType: 'option',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.assetType).toBe('option');
    expect(body.symbol).toBe('AAPL260116C150');
  });

  // 1c. Create an option position with an unparseable symbol → 400 + details.symbol
  it('rejects an option position with an unparseable symbol', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const res = await authedRequest('POST', '/api/positions', cookie, {
      accountId: account.id,
      symbol: 'NOTANOPTION',
      side: 'long',
      assetType: 'option',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details.symbol).toBeDefined();
  });

  // 2. Create with invalid accountId → 404
  it('returns 404 for invalid accountId', async () => {
    const { cookie } = await registerAndGetCookie();

    const res = await authedRequest('POST', '/api/positions', cookie, {
      accountId: '00000000-0000-0000-0000-000000000000',
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(res.status).toBe(404);
  });

  // 3. List with status filter
  it('lists positions filtered by status', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    // Create two drafts
    await createTestPosition(cookie, account.id, { symbol: 'AAPL' });
    const pos2 = await createTestPosition(cookie, account.id, { symbol: 'TSLA' });

    // Open one of them
    await addFill(cookie, pos2.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos2.id);

    const draftRes = await authedRequest('GET', '/api/positions?status=draft', cookie);
    expect(draftRes.status).toBe(200);
    const drafts = await draftRes.json();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].symbol).toBe('AAPL');

    const openRes = await authedRequest('GET', '/api/positions?status=open', cookie);
    expect(openRes.status).toBe(200);
    const opens = await openRes.json();
    expect(opens).toHaveLength(1);
    expect(opens[0].symbol).toBe('TSLA');
  });

  // 4. List with accountId filter
  it('lists positions filtered by accountId', async () => {
    const { cookie } = await registerAndGetCookie();
    const acctA = await createTestAccount(cookie, 'Account A');
    const acctB = await createTestAccount(cookie, 'Account B');

    await createTestPosition(cookie, acctA.id, { symbol: 'AAPL' });
    await createTestPosition(cookie, acctB.id, { symbol: 'TSLA' });

    const res = await authedRequest('GET', `/api/positions?accountId=${acctA.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].symbol).toBe('AAPL');
  });

  // 5. Update draft — all fields (asset type unchanged)
  it('updates all fields on a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const acctA = await createTestAccount(cookie, 'Account A');
    const acctB = await createTestAccount(cookie, 'Account B');
    const pos = await createTestPosition(cookie, acctA.id);

    const res = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      symbol: 'TSLA',
      side: 'short',
      assetType: 'stock',
      accountId: acctB.id,
      notes: 'Updated notes',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.symbol).toBe('TSLA');
    expect(body.side).toBe('short');
    expect(body.assetType).toBe('stock');
    expect(body.accountId).toBe(acctB.id);
    expect(body.notes).toBe('Updated notes');
  });

  // 5b. Stock→option flip carrying a non-OCC symbol → 400 (edge refine fires
  // before the service)
  it('rejects a stock→option flip with a non-OCC symbol', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    const res = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      assetType: 'option',
      symbol: 'TSLA',
    });
    expect(res.status).toBe(400);
  });

  // 5c. Draft-option re-encode — change to a new valid compact symbol → 200 (Req 3.2)
  it('updates a draft option to a new valid compact symbol', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      symbol: 'AAPL260116C150',
      assetType: 'option',
    });

    const res = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      symbol: 'NVDA260321C120',
      assetType: 'option',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assetType).toBe('option');
    expect(body.symbol).toBe('NVDA260321C120');
  });

  // 5d. Draft-option symbol changed to an invalid value → 400 with details.symbol
  it('rejects changing a draft option symbol to an invalid value', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      symbol: 'AAPL260116C150',
      assetType: 'option',
    });

    const res = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      symbol: 'NOTANOPTION',
      assetType: 'option',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details.symbol).toBeDefined();
  });

  // 5e. Explicit asset-type flip reaching the service (symbol omitted so the
  // edge refine does not pre-empt) → 409 CONFLICT (Req 5.5)
  it('rejects an asset-type flip on a draft with 409', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id); // stock draft

    const res = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      assetType: 'option',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  // 6. Update open — notes only, reject other fields with 409
  it('allows updating notes on an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '150',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id);

    const notesRes = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      notes: 'New notes on open',
    });
    expect(notesRes.status).toBe(200);
    const body = await notesRes.json();
    expect(body.notes).toBe('New notes on open');

    // Reject symbol change
    const symbolRes = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      symbol: 'TSLA',
    });
    expect(symbolRes.status).toBe(409);
  });

  // 7. Delete draft → 204
  it('deletes a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(204);

    const getRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(getRes.status).toBe(404);
  });

  // 8. Delete open without exit fills → 204
  it('deletes an open position without exit fills', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '5',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id);

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(204);
  });

  // 9. Delete open WITH exit fills → 204 (R4 amendment 2026-07-17: an open
  // position has never written a ledger entry, so there is no accounting to
  // reverse — it deletes cleanly regardless of exit fills)
  it('deletes an open position with exit fills', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id);

    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(204);

    const getRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(getRes.status).toBe(404);
  });

  // 10. Delete closed → 204 (R4 amendment / task 23b). No ledger hook is
  // registered in this block, so the close wrote no ledger entry and the reverse
  // step is a no-op; the position and its fills hard-delete cleanly. The
  // ledger-reversal balance behaviour is covered in the dedicated block below.
  it('deletes a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');

    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-02T00:00:00Z');

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(204);

    const getRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(getRes.status).toBe(404);
  });

  // 11. Open transition — success
  it('transitions a draft to open', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '150',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });

    const res = await authedRequest('POST', `/api/positions/${pos.id}/open`, cookie, {
      openedAt: '2025-01-01T00:00:00Z',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('open');
    expect(body.openedAt).toBeTruthy();
  });

  // 12. Open transition failure — no fills → 409, wrong status → 409
  it('rejects opening a position with no fills', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/open`, cookie, {});
    expect(res.status).toBe(409);
  });

  it('rejects opening an already open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/open`, cookie, {});
    expect(res.status).toBe(409);
  });

  // 13. Close transition — success
  it('transitions an open position to closed', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');

    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('POST', `/api/positions/${pos.id}/close`, cookie, {
      closedAt: '2025-01-02T00:00:00Z',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('closed');
    expect(body.closedAt).toBeTruthy();
  });

  // 14. Close transition failure — not fully exited → 409, wrong status → 409
  it('rejects closing a position not fully exited', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id);

    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('POST', `/api/positions/${pos.id}/close`, cookie, {});
    expect(res.status).toBe(409);
  });

  it('rejects closing a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/close`, cookie, {});
    expect(res.status).toBe(409);
  });

  // 15. Close with closedAt before openedAt → 400
  it('rejects closing with closedAt before openedAt', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-06-01T00:00:00Z');

    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('POST', `/api/positions/${pos.id}/close`, cookie, {
      closedAt: '2025-01-01T00:00:00Z',
    });
    expect(res.status).toBe(400);
  });

  // 16. P&L in detail response
  it('returns P&L fields in detail response', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    // Buy 10 at $100, sell 10 at $120 → P&L = (120-100)*10 = $200
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '5',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');

    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '10',
      fees: '5',
      filledAt: '2025-01-02T00:00:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-02T00:00:00Z');

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.avgEntryPrice).toBe(100);
    expect(body.avgExitPrice).toBe(120);
    expect(body.totalEntryQuantity).toBe(10);
    expect(body.totalExitQuantity).toBe(10);
    // realizedPnl = (120 - 100) * 10 - 5 - 5 = 190
    expect(body.realizedPnl).toBe(190);
    expect(typeof body.returnPercentage).toBe('number');
    expect(body.fills).toHaveLength(2);
  });

  // 17. Cross-path P&L parity — list and detail return identical values
  it('returns identical P&L in list and detail', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '50',
      quantity: '20',
      fees: '2',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');

    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '60',
      quantity: '20',
      fees: '3',
      filledAt: '2025-01-02T00:00:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-02T00:00:00Z');

    const detailRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const detail = await detailRes.json();

    const listRes = await authedRequest('GET', '/api/positions', cookie);
    const list = await listRes.json();
    const listItem = list.find((p: { id: string }) => p.id === pos.id);

    expect(listItem.realizedPnl).toBe(detail.realizedPnl);
    expect(listItem.returnPercentage).toBe(detail.returnPercentage);
    expect(listItem.avgEntryPrice).toBe(detail.avgEntryPrice);
    expect(listItem.avgExitPrice).toBe(detail.avgExitPrice);
  });

  // 18. Ownership scoping
  it('prevents user A from accessing user B positions', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();

    const accountA = await createTestAccount(cookieA, 'A Private');
    const posA = await createTestPosition(cookieA, accountA.id);

    // User B cannot get user A's position
    const getRes = await authedRequest('GET', `/api/positions/${posA.id}`, cookieB);
    expect(getRes.status).toBe(404);

    // User B cannot update user A's position
    const putRes = await authedRequest('PUT', `/api/positions/${posA.id}`, cookieB, {
      notes: 'Hacked',
    });
    expect(putRes.status).toBe(404);

    // User B cannot delete user A's position
    const deleteRes = await authedRequest('DELETE', `/api/positions/${posA.id}`, cookieB);
    expect(deleteRes.status).toBe(404);

    // User B's list should not include user A's position
    const listRes = await authedRequest('GET', '/api/positions', cookieB);
    const list = await listRes.json();
    expect(list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trade-plan fields & Risk/Reward (R14, R3 amendment) — Phase 1 of task 24.
// R/R and unit-count coverage for tasks 20/21; plan-field editability for the
// R2/R4 amendment. Reopen and closed-delete are Phase 2 (task 24 continued)
// and deliberately absent. Expected targetRR/actualRR values are computed by
// hand from avgEntry/avgExit/stop/target and asserted for equality.
// ---------------------------------------------------------------------------

describe('positions R/R and trade-plan fields (R14)', () => {
  // 1. R/R happy path — long, partially exited. entry 10@100, stop 90, target
  //    130, exit 4@120. riskPerUnit=|100-90|=10; targetRR=|130-100|/10=3.00;
  //    actualRR=((120-100)*+1)/10=2.00. openUnits=10-4=6, closedUnits=4.
  it('computes targetRR/actualRR, plan fields, and unit counts for a long position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      targetPrice: '130',
      stopLoss: '90',
    });

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '4',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.targetPrice).toBe(130);
    expect(body.stopLoss).toBe(90);
    expect(body.targetRR).toBe(3);
    expect(body.actualRR).toBe(2);
    expect(body.openUnits).toBe(6);
    expect(body.closedUnits).toBe(4);
  });

  // 2. R/R sign — short loser → negative actualRR. Short entry 10@100 (sell to
  //    open), stop 110 (above entry), target 80. Exit 10@120 (buy to cover
  //    higher = loss). riskPerUnit=|100-110|=10; sideMultiplier=-1;
  //    actualRR=((120-100)*-1)/10=-2.00; targetRR=|80-100|/10=2.00.
  it('reports a signed negative actualRR for a short losing position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      side: 'short',
      targetPrice: '80',
      stopLoss: '110',
    });

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.targetRR).toBe(2);
    expect(body.actualRR).toBe(-2);
  });

  // 3a. Null case — no stopLoss → both targetRR and actualRR null even with a
  //     target set and a completed exit.
  it('returns null R/R when stopLoss is not set', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, { targetPrice: '130' });

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const body = await res.json();
    expect(body.targetRR).toBeNull();
    expect(body.actualRR).toBeNull();
  });

  // 3b. Null case — stopLoss set but no exit fills → targetRR present,
  //     actualRR null (no realized exit yet).
  it('returns targetRR but null actualRR when there are no exit fills', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      targetPrice: '130',
      stopLoss: '90',
    });

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const body = await res.json();
    expect(body.targetRR).toBe(3); // |130-100|/|100-90| = 3.00
    expect(body.actualRR).toBeNull();
  });

  // 3c. Null case — draft with no entry fills → both null (no realized entry
  //     price to anchor to), even with stop/target set.
  it('returns null R/R for a draft with plan fields but no fills', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      targetPrice: '130',
      stopLoss: '90',
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const body = await res.json();
    expect(body.targetRR).toBeNull();
    expect(body.actualRR).toBeNull();
    expect(body.openUnits).toBe(0);
    expect(body.closedUnits).toBe(0);
  });

  // 3d. Null case — stop == avgEntry (zero risk denominator) → both null (no
  //     divide-by-zero).
  it('returns null R/R when stopLoss equals the average entry price', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      targetPrice: '130',
      stopLoss: '100',
    });

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const body = await res.json();
    expect(body.targetRR).toBeNull();
    expect(body.actualRR).toBeNull();
  });

  // 4. List/detail parity for the new fields — mirrors the existing
  //    realizedPnl/returnPercentage parity test for targetRR, actualRR,
  //    openUnits, closedUnits, targetPrice, stopLoss.
  it('returns identical R/R, unit counts, and plan fields in list and detail', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      targetPrice: '130',
      stopLoss: '90',
    });

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '4',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const detailRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const detail = await detailRes.json();

    const listRes = await authedRequest('GET', '/api/positions', cookie);
    const list = await listRes.json();
    const listItem = list.find((p: { id: string }) => p.id === pos.id);

    expect(listItem.targetRR).toBe(detail.targetRR);
    expect(listItem.actualRR).toBe(detail.actualRR);
    expect(listItem.openUnits).toBe(detail.openUnits);
    expect(listItem.closedUnits).toBe(detail.closedUnits);
    expect(listItem.targetPrice).toBe(detail.targetPrice);
    expect(listItem.stopLoss).toBe(detail.stopLoss);
  });

  // 5. openUnits/closedUnits semantics — partially closed stock: enter 100,
  //    exit 40 → openUnits 60, closedUnits 40.
  it('reports openUnits and closedUnits for a partially closed stock position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '10',
      quantity: '100',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '12',
      quantity: '40',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const body = await res.json();
    expect(body.openUnits).toBe(60);
    expect(body.closedUnits).toBe(40);
  });

  // 6. Unit basis for options is contracts, not shares. entry 3 contracts,
  //    exit 1 → openUnits 2, closedUnits 1 (would be 200/100 if shares).
  it('expresses openUnits and closedUnits in contracts for option positions', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id, {
      symbol: 'AAPL260116C150',
      assetType: 'option',
    });

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '5',
      quantity: '3',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '8',
      quantity: '1',
      filledAt: '2025-01-02T00:00:00Z',
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const body = await res.json();
    expect(body.openUnits).toBe(2);
    expect(body.closedUnits).toBe(1);
  });

  // 7. Plan fields editable on an OPEN position (R2 amendment supersedes the
  //    R4 "notes only" rule); symbol/side changes on a non-draft still 409
  //    (test 6 above covers symbol; this covers side and the plan-field path).
  it('allows editing targetPrice/stopLoss on an open position but not side', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');

    const planRes = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      targetPrice: '130',
      stopLoss: '90',
    });
    expect(planRes.status).toBe(200);

    const detail = await (await authedRequest('GET', `/api/positions/${pos.id}`, cookie)).json();
    expect(detail.targetPrice).toBe(130);
    expect(detail.stopLoss).toBe(90);
    expect(detail.targetRR).toBe(3); // |130-100|/|100-90|

    // side change on a non-draft is still rejected
    const sideRes = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      side: 'short',
    });
    expect(sideRes.status).toBe(409);
  });

  // 8. Plan fields editable on a CLOSED position — backfilling a stop after the
  //    fact retroactively produces R/R (accepted tradeoff, R2 amendment). The
  //    open→close flow is available; only closed DELETE and reopen are blocked.
  it('allows editing targetPrice/stopLoss on a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '120',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-02T00:00:00Z');

    const planRes = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      targetPrice: '130',
      stopLoss: '90',
    });
    expect(planRes.status).toBe(200);

    const detail = await (await authedRequest('GET', `/api/positions/${pos.id}`, cookie)).json();
    expect(detail.status).toBe('closed');
    expect(detail.targetPrice).toBe(130);
    expect(detail.stopLoss).toBe(90);
    expect(detail.targetRR).toBe(3); // |130-100|/|100-90|
    expect(detail.actualRR).toBe(2); // ((120-100)*+1)/10
  });
});

// ---------------------------------------------------------------------------
// Plan-tiers: L2 position cap + L1 writability (D9/D18, REQ-6.1/6.6/6.7).
// Real PG; gating toggled via the mutable config. REQ-6.5 never-blocked paths
// (close/fill/edit/delete/state transitions) carry NO check structurally —
// the existing suites above run them green with these checks in place.
// ---------------------------------------------------------------------------

describe('positions tier enforcement (plan-tiers L2 + L1 writability)', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  async function getUserId(cookie: string): Promise<string> {
    const meRes = await authedRequest('GET', '/api/auth/me', cookie);
    const me = await meRes.json();
    return me.id;
  }

  // L2: single-create refusal at the free position cap
  it('refuses a single create at the L2 cap with 403 TIER_LIMIT_POSITIONS', async () => {
    const { cookie } = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const account = await createTestAccount(cookie, 'L2 Account');

    // Seed exactly the free cap of positions in one bulk insert.
    const cap = getTierLimits('free').positions!;
    const rows = Array.from({ length: cap }, (_, i) => ({
      userId,
      accountId: account.id,
      symbol: `SYM${i}`,
      side: 'long',
      assetType: 'equity',
      status: 'open',
    }));
    // performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values(rows);

    config.FEATURE_GATING = true;
    const res = await authedRequest('POST', '/api/positions', cookie, {
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('TIER_LIMIT_POSITIONS');
    expect(res.headers.get('Retry-After')).toBeNull();

    // Gating off: the same create passes through (REQ-6.7 self-host parity).
    config.FEATURE_GATING = false;
    const okRes = await authedRequest('POST', '/api/positions', cookie, {
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(okRes.status).toBe(201);
  });

  // L1 writability (D18): over the account cap, only the effective writable
  // designation accepts new positions — and enforcement observes a
  // re-designation made through PUT /api/accounts/writable.
  it('refuses creates into a non-writable account while over-cap and observes re-designation', async () => {
    const { cookie } = await registerAndGetCookie();
    // Both accounts created while gating is off (the over-cap state). Rapid
    // in-process creates can land on the SAME created_at microsecond, so pin
    // the deterministic default via position activity (its highest-priority
    // key) rather than relying on creation-order timestamps: a position in B
    // makes B the effective designation regardless of timestamp ties.
    const accountA = await createTestAccount(cookie, 'Acct A');
    const accountB = await createTestAccount(cookie, 'Acct B');
    await createTestPosition(cookie, accountB.id, { symbol: 'NVDA' });

    config.FEATURE_GATING = true;

    // Target ≠ effective designation (B, most recent activity) ⇒ refused.
    const refused = await authedRequest('POST', '/api/positions', cookie, {
      accountId: accountA.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(refused.status).toBe(403);
    const refusedBody = await refused.json();
    expect(refusedBody.error.code).toBe('TIER_ACCOUNT_NOT_WRITABLE');

    // The designated account stays writable.
    const allowed = await authedRequest('POST', '/api/positions', cookie, {
      accountId: accountB.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(allowed.status).toBe(201);

    // Re-designate A (always-on endpoint, works while gated + over-cap)...
    const setRes = await authedRequest('PUT', '/api/accounts/writable', cookie, {
      accountId: accountA.id,
    });
    expect(setRes.status).toBe(200);

    // ...and enforcement observes the new designation in both directions.
    const nowAllowed = await authedRequest('POST', '/api/positions', cookie, {
      accountId: accountA.id,
      symbol: 'MSFT',
      side: 'long',
      assetType: 'stock',
    });
    expect(nowAllowed.status).toBe(201);

    const nowRefused = await authedRequest('POST', '/api/positions', cookie, {
      accountId: accountB.id,
      symbol: 'MSFT',
      side: 'long',
      assetType: 'stock',
    });
    expect(nowRefused.status).toBe(403);
    const nowRefusedBody = await nowRefused.json();
    expect(nowRefusedBody.error.code).toBe('TIER_ACCOUNT_NOT_WRITABLE');
  });
});

// ---------------------------------------------------------------------------
// Reopen endpoint (R13, task 22). The live ledger close + reverse hooks are
// registered for the whole block so the reopen posts a reversing row and the
// zero-open-units guard has a reopen marker to key off. Same-day logic is
// exercised in an explicit account timezone (America/New_York) with controlled
// openedAt/closedAt/reopenedAt — including a US-Eastern evening session that
// crosses UTC midnight, which a UTC comparison would wrongly split.
// ---------------------------------------------------------------------------

describe('positions reopen (R13)', () => {
  beforeAll(() => {
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
    replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
    unregisterReverseHook('ledger');
  });

  async function createTzAccount(
    cookie: string,
    timezone = 'America/New_York',
    name = 'TZ Account',
    currency = 'USD',
  ) {
    const res = await authedRequest('POST', '/api/accounts', cookie, { name, currency, timezone });
    expect(res.status).toBe(201);
    return res.json();
  }

  async function buildClosedPosition(
    cookie: string,
    accountId: string,
    opts: {
      openedAt: string;
      closedAt: string;
      quantity?: string;
      entryPrice?: string;
      exitPrice?: string;
      overrides?: Record<string, unknown>;
    },
  ) {
    const { openedAt, closedAt, quantity = '100', entryPrice = '10', exitPrice = '11' } = opts;
    const pos = await createTestPosition(cookie, accountId, opts.overrides ?? {});
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: entryPrice,
      quantity,
      filledAt: openedAt,
    });
    await openTestPosition(cookie, pos.id, openedAt);
    await addFill(cookie, pos.id, { type: 'exit', price: exitPrice, quantity, filledAt: closedAt });
    await closeTestPosition(cookie, pos.id, closedAt);
    return pos;
  }

  async function getAccountBalance(cookie: string, accountId: string): Promise<number> {
    const res = await authedRequest('GET', `/api/accounts/${accountId}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    return Number(body.balance);
  }

  // 1. Same-day (account tz) closed → open; closedAt cleared; openedAt preserved.
  //    Evening US-Eastern session crossing UTC midnight: opened 18:30 EST and
  //    reopened 21:00 EST are the SAME New York day but DIFFERENT UTC days — a
  //    UTC comparison would 409 here, proving the tz conversion (AC1/AC4).
  it('reopens a same-day closed position, clearing closedAt and preserving openedAt', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie, 'America/New_York');
    const pos = await buildClosedPosition(cookie, account.id, {
      openedAt: '2025-01-15T23:30:00Z', // NY 2025-01-15 18:30 EST
      closedAt: '2025-01-16T00:30:00Z', // NY 2025-01-15 19:30 EST
    });

    const before = await (await authedRequest('GET', `/api/positions/${pos.id}`, cookie)).json();
    expect(before.status).toBe('closed');

    const res = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-16T02:00:00Z', // NY 2025-01-15 21:00 EST — same NY day
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('open');
    expect(body.closedAt).toBeNull();
    expect(new Date(body.openedAt).getTime()).toBe(new Date(before.openedAt).getTime());
  });

  // 2. Prior-day (account tz) → 409 (AC2). openedAt NY Jan 15, reopen NY Jan 16.
  it('rejects reopening a position opened on a previous day', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie, 'America/New_York');
    const pos = await buildClosedPosition(cookie, account.id, {
      openedAt: '2025-01-15T15:00:00Z', // NY Jan 15 10:00
      closedAt: '2025-01-15T18:00:00Z', // NY Jan 15 13:00
    });

    const res = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-16T15:00:00Z', // NY Jan 16 10:00 — next day
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe(
      'This position was opened on a previous day — create a new position instead',
    );
  });

  // 3. Non-closed → 409 (AC3): draft and open both rejected.
  it('rejects reopening a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {});
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe('Cannot reopen a draft position');
  });

  it('rejects reopening an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie);
    const pos = await createTestPosition(cookie, account.id);
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '10',
      quantity: '100',
      filledAt: '2025-01-15T15:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-15T15:00:00Z');

    const res = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {});
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe('Cannot reopen a open position');
  });

  // 4. reopenedAt before closedAt → 400 (AC8).
  it('rejects a reopenedAt that precedes closedAt', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie);
    const pos = await buildClosedPosition(cookie, account.id, {
      openedAt: '2025-01-15T15:00:00Z',
      closedAt: '2025-01-15T18:00:00Z',
    });

    const res = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-15T17:00:00Z', // before closedAt 18:00
    });
    expect(res.status).toBe(400);
  });

  // 5. reopenedAt in the future → 400 (AC8).
  it('rejects a reopenedAt in the future', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie);
    const pos = await buildClosedPosition(cookie, account.id, {
      openedAt: '2025-01-15T15:00:00Z',
      closedAt: '2025-01-15T18:00:00Z',
    });

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: future,
    });
    expect(res.status).toBe(400);
  });

  // 6. Full open→close→reopen→scale-in→close cycle. The reopen's reversing row
  //    nets the first close, so the account balance reflects the position's
  //    cumulative realized P&L EXACTLY ONCE (300, not 100+300=400) — R13-AC5/AC6
  //    plus the "accounting on reopen" note.
  it('nets cumulative realized P&L exactly once across an open→close→reopen→close cycle', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie, 'America/New_York');
    const pos = await createTestPosition(cookie, account.id);

    // Cycle 1: enter 100 @10, exit 100 @11 → +100 realized. Close posts +100.
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '10',
      quantity: '100',
      filledAt: '2025-01-15T15:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-15T15:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '11',
      quantity: '100',
      filledAt: '2025-01-15T15:30:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-15T16:00:00Z');
    expect(await getAccountBalance(cookie, account.id)).toBe(100);

    // Reopen (same NY day). Posts a −100 reversal, so the balance returns to 0.
    const reopenRes = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-15T17:00:00Z',
    });
    expect(reopenRes.status).toBe(200);
    expect(await getAccountBalance(cookie, account.id)).toBe(0);

    // Cycle 2: scale in 100 @10, exit 100 @12. Cumulative realized now +300.
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '10',
      quantity: '100',
      filledAt: '2025-01-15T17:15:00Z',
    });
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '12',
      quantity: '100',
      filledAt: '2025-01-15T17:30:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-15T18:00:00Z');

    const detail = await (await authedRequest('GET', `/api/positions/${pos.id}`, cookie)).json();
    expect(detail.status).toBe('closed');
    expect(detail.realizedPnl).toBe(300); // cumulative over ALL fills (R8/R13-AC6)

    // Single count: balance == cumulative realized. Double counting would give 400.
    expect(await getAccountBalance(cookie, account.id)).toBe(300);
  });

  // 7. Reopen then immediate re-close with NO new fills → 409 zero-open-units
  //    guard (design "Reopen mechanics" mitigation). Prevents ledger churn on a
  //    no-op re-close of the transient openUnits == 0 state.
  it('rejects an immediate re-close after reopen with no new fills', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie, 'America/New_York');
    const pos = await buildClosedPosition(cookie, account.id, {
      openedAt: '2025-01-15T15:00:00Z',
      closedAt: '2025-01-15T16:00:00Z',
    });

    const reopenRes = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-15T17:00:00Z',
    });
    expect(reopenRes.status).toBe(200);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/close`, cookie, {
      closedAt: '2025-01-15T18:00:00Z',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe(
      'Add a fill before closing — nothing has changed since the reopen',
    );
  });
});

// ---------------------------------------------------------------------------
// Closed-position deletion with ledger reversal (R4 amendment, task 23b).
// removePosition is uniform across statuses: it invokes the registered reverse
// hooks FIRST (posting a position_pnl_reversal for any un-reversed close), then
// hard-deletes. `positionId ON DELETE SET NULL` keeps both the original close
// row and its reversal in the append-only ledger, netting to zero in the
// balance. The live close + reverse hooks are registered so these assertions
// exercise the real reversal path.
// ---------------------------------------------------------------------------

describe('positions closed-delete + ledger reversal (R4 amendment, task 23b)', () => {
  beforeAll(() => {
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
    replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
    unregisterReverseHook('ledger');
  });

  async function createTzAccount(cookie: string, timezone = 'America/New_York') {
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'TZ Account',
      currency: 'USD',
      timezone,
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  async function getAccountBalance(cookie: string, accountId: string): Promise<number> {
    const res = await authedRequest('GET', `/api/accounts/${accountId}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    return Number(body.balance);
  }

  // Delete a CLOSED position → 204; the reversal nets its realized P&L out of
  // the account balance (back to the pre-close value) and the row is gone.
  it('deletes a closed position, reverses the ledger, and returns the balance to pre-close', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);

    const preClose = await getAccountBalance(cookie, account.id);
    expect(preClose).toBe(0);

    const pos = await createTestPosition(cookie, account.id);
    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2025-01-01T00:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-01T00:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '110',
      quantity: '10',
      filledAt: '2025-01-02T00:00:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-02T00:00:00Z');

    // Close posted +100 realized ((110 − 100) × 10). Balance moved off pre-close.
    expect(await getAccountBalance(cookie, account.id)).toBe(100);

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(204);

    // The reversal netted the close: balance back to its pre-close value.
    expect(await getAccountBalance(cookie, account.id)).toBe(preClose);

    // Row is gone.
    const getRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(getRes.status).toBe(404);
  });

  // Delete an OPEN position that was previously reopened (open→close→reopen):
  // the prior close was already reversed on reopen, so the delete's reverse step
  // is a no-op and everything nets to zero.
  it('deletes a reopened-open position (prior close already reversed) with correct balance', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTzAccount(cookie, 'America/New_York');
    const pos = await createTestPosition(cookie, account.id);

    await addFill(cookie, pos.id, {
      type: 'entry',
      price: '10',
      quantity: '100',
      filledAt: '2025-01-15T15:00:00Z',
    });
    await openTestPosition(cookie, pos.id, '2025-01-15T15:00:00Z');
    await addFill(cookie, pos.id, {
      type: 'exit',
      price: '11',
      quantity: '100',
      filledAt: '2025-01-15T15:30:00Z',
    });
    await closeTestPosition(cookie, pos.id, '2025-01-15T16:00:00Z');
    expect(await getAccountBalance(cookie, account.id)).toBe(100);

    // Same-day reopen posts a −100 reversal → balance 0; position back to open.
    const reopenRes = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-15T17:00:00Z',
    });
    expect(reopenRes.status).toBe(200);
    expect((await reopenRes.json()).status).toBe('open');
    expect(await getAccountBalance(cookie, account.id)).toBe(0);

    // Delete the now-open position. The reverse hook finds the prior close
    // already reversed (no-op); the delete nets everything to zero.
    const res = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(204);
    expect(await getAccountBalance(cookie, account.id)).toBe(0);

    const getRes = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(getRes.status).toBe(404);
  });
});
