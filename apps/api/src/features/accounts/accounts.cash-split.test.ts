/**
 * Cash / position-value split (ledger-balances Req 10).
 *
 * The account balance is partitioned into `cash` and `positionValue`:
 *
 *     cash = balance − Σ (open positions at cost basis)
 *
 * This became derivable only once per-fill P&L posting landed (Req 9, commit
 * 234d091). Before that the ledger held a position's realized P&L back until it
 * went flat, so mid-trade the subtraction was short by exactly the unposted
 * amount — $4,500 against a true $4,550 in the worked example below. Half of
 * these tests exist to keep that gap closed.
 *
 * Every expectation here is a real cash figure, computed independently of the
 * app: what a broker's cash column would read after the same fills. If a test
 * says $4,540, that is 5000 − 1000 − 10 + 550, not whatever the query returned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import app, { bootstrap } from '@/app';
import { unregisterCloseHook } from '@/features/positions/positions.service';

beforeAll(() => {
  // See accounting.test.ts — .catch swallows the async advisor-startup tail,
  // whose fire-and-forget canary rejects against the per-test mocked db.
  bootstrap().catch(() => {});
});

afterAll(() => {
  unregisterCloseHook('ledger');
});

// ---------------------------------------------------------------------------
// Fixtures (mirrors accounting.test.ts)
// ---------------------------------------------------------------------------

let testCounter = 0;
const testRunId = Date.now();
let ipCounter = 900;

function uniqueIp() {
  return `10.9.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<string> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({
      email: `cashsplit${testRunId}-${++testCounter}@example.com`,
      password: 'password123',
    }),
  });
  expect(res.status).toBe(201);
  return getCookieValue(res, 'session')!;
}

function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = {
    Cookie: `session=${cookie}`,
    'X-Forwarded-For': uniqueIp(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createAccount(cookie: string, startingBalance: string, currency = 'USD') {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: `Cash Split ${++testCounter}`,
    currency,
    startingBalance,
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** The account's derived balance and its two halves, as numbers. */
async function split(cookie: string, accountId: string) {
  const res = await authedRequest('GET', `/api/accounts/${accountId}`, cookie);
  expect(res.status).toBe(200);
  const account = await res.json();
  return {
    balance: Number(account.balance),
    cash: Number(account.cash),
    positionValue: Number(account.positionValue),
  };
}

async function listPositions(cookie: string, query = '') {
  const res = await authedRequest('GET', `/api/positions${query}`, cookie);
  expect(res.status).toBe(200);
  return res.json();
}

async function addFill(
  cookie: string,
  positionId: string,
  data: {
    type: 'entry' | 'exit';
    price: string;
    quantity: string;
    fees?: string;
    filledAt: string;
  },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, {
    fees: '0',
    ...data,
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** Create a position, give it one entry fill, and open it. */
async function openWithEntry(
  cookie: string,
  accountId: string,
  o: {
    price: string;
    quantity: string;
    fees?: string;
    side?: 'long' | 'short';
    assetType?: 'stock' | 'option';
    symbol?: string;
  },
) {
  const created = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: o.symbol ?? 'AAPL',
    side: o.side ?? 'long',
    assetType: o.assetType ?? 'stock',
  });
  expect(created.status).toBe(201);
  const position = await created.json();

  await addFill(cookie, position.id, {
    type: 'entry',
    price: o.price,
    quantity: o.quantity,
    fees: o.fees ?? '0',
    filledAt: '2026-01-01T00:00:00Z',
  });

  const opened = await authedRequest('POST', `/api/positions/${position.id}/open`, cookie, {
    openedAt: '2026-01-01T00:00:00Z',
  });
  expect(opened.status).toBe(200);
  return position;
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe('cash + positionValue === balance', () => {
  it('holds through the full open → partial exit → flat lifecycle', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');

    // Flat account: everything is cash.
    expect(await split(cookie, account.id)).toEqual({
      balance: 5000,
      cash: 5000,
      positionValue: 0,
    });

    // $5,000 cash → open a $1,000 position (10 @ $100).
    const position = await openWithEntry(cookie, account.id, { price: '100', quantity: '10' });
    expect(await split(cookie, account.id)).toEqual({
      balance: 5000,
      cash: 4000,
      positionValue: 1000,
    });

    // Partially close at a profit: 5 @ $110 realizes $50.
    // THIS is the assertion the whole feature turns on. Before per-fill posting
    // the balance would still read $5,000 here, making cash $4,000 — short by
    // the $50 that had been realized but not yet posted.
    await addFill(cookie, position.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      filledAt: '2026-01-02T00:00:00Z',
    });
    expect(await split(cookie, account.id)).toEqual({
      balance: 5050,
      cash: 4550,
      positionValue: 500,
    });

    // Close the rest: the position value returns to cash.
    await addFill(cookie, position.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      filledAt: '2026-01-03T00:00:00Z',
    });
    expect(await split(cookie, account.id)).toEqual({
      balance: 5100,
      cash: 5100,
      positionValue: 0,
    });
  });

  it('survives a fill edit that retroactively reprices the position', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');
    const position = await openWithEntry(cookie, account.id, { price: '100', quantity: '10' });

    const exit = await addFill(cookie, position.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      filledAt: '2026-01-02T00:00:00Z',
    });
    expect(await split(cookie, account.id)).toEqual({
      balance: 5050,
      cash: 4550,
      positionValue: 500,
    });

    // Correct the exit price down to $105 — realized P&L drops to $25 and the
    // ledger posts a compensating debit.
    const edited = await authedRequest(
      'PUT',
      `/api/positions/${position.id}/fills/${exit.id}`,
      cookie,
      { price: '105' },
    );
    expect(edited.status).toBe(200);

    expect(await split(cookie, account.id)).toEqual({
      balance: 5025,
      cash: 4525,
      positionValue: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// Entry fees — the term that makes the derivation exact rather than close
// ---------------------------------------------------------------------------

describe('entry fees', () => {
  it('rides with the open portion so cash matches the broker to the cent', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');

    // 10 @ $100 with a $10 commission. Real cash out is $1,010, not $1,000.
    const position = await openWithEntry(cookie, account.id, {
      price: '100',
      quantity: '10',
      fees: '10',
    });

    // Nothing realized yet, so the balance has not moved — but the whole $10
    // commission is already out of cash, carried on the position.
    expect(await split(cookie, account.id)).toEqual({
      balance: 5000,
      cash: 3990,
      positionValue: 1010,
    });

    await addFill(cookie, position.id, {
      type: 'exit',
      price: '110',
      quantity: '5',
      filledAt: '2026-01-02T00:00:00Z',
    });

    // Broker's cash: 5000 − (10 × 100) − 10 + (5 × 110) = 4540.
    //
    // The ledger charged $5 of the commission against the realized half
    // (prorated exitQty/entryQty), so the balance is 5045. The remaining $5
    // rides on the open half. Omit that term — as the old display-only cost
    // basis did — and cash reads 4545, overstated for as long as any part of
    // the position stays open.
    expect(await split(cookie, account.id)).toEqual({
      balance: 5045,
      cash: 4540,
      positionValue: 505,
    });
  });

  it('is fully spent once the position is flat', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');
    const position = await openWithEntry(cookie, account.id, {
      price: '100',
      quantity: '10',
      fees: '10',
    });
    await addFill(cookie, position.id, {
      type: 'exit',
      price: '110',
      quantity: '10',
      fees: '4',
      filledAt: '2026-01-02T00:00:00Z',
    });

    // 5000 − 1000 − 10 + 1100 − 4 = 5086, all of it cash.
    expect(await split(cookie, account.id)).toEqual({
      balance: 5086,
      cash: 5086,
      positionValue: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Shorts and options
// ---------------------------------------------------------------------------

describe('shorts', () => {
  it('carry a NEGATIVE position value, so cash exceeds the balance', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');

    // Short 10 @ $100: the broker credits $1,000 of proceeds against 10 shares
    // owed. Cash goes UP; the position is a liability.
    const position = await openWithEntry(cookie, account.id, {
      side: 'short',
      price: '100',
      quantity: '10',
    });
    expect(await split(cookie, account.id)).toEqual({
      balance: 5000,
      cash: 6000,
      positionValue: -1000,
    });

    // Cover 5 @ $90 → $50 realized, $450 of cash out.
    await addFill(cookie, position.id, {
      type: 'exit',
      price: '90',
      quantity: '5',
      filledAt: '2026-01-02T00:00:00Z',
    });

    // Broker's cash: 5000 + 1000 − 450 = 5550. An unsigned position value would
    // report 4550 here — wrong by twice the remaining proceeds.
    expect(await split(cookie, account.id)).toEqual({
      balance: 5050,
      cash: 5550,
      positionValue: -500,
    });
  });

  it('take their entry fee toward zero, not away from it', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');
    await openWithEntry(cookie, account.id, {
      side: 'short',
      price: '100',
      quantity: '10',
      fees: '10',
    });

    // Proceeds received are $1,000 less the $10 commission = $990 of cash in.
    // The fee is an outflow on both sides of the book, so it shrinks the
    // magnitude of a short's negative position value.
    expect(await split(cookie, account.id)).toEqual({
      balance: 5000,
      cash: 5990,
      positionValue: -990,
    });
  });
});

describe('options', () => {
  it('apply the 100x contract multiplier to the price leg only', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');

    // 2 contracts @ $3.00 with $1.30 of fees = 2 × 3 × 100 + 1.30 of capital.
    await openWithEntry(cookie, account.id, {
      assetType: 'option',
      symbol: 'AAPL260116C00150000',
      price: '3',
      quantity: '2',
      fees: '1.30',
    });

    expect(await split(cookie, account.id)).toEqual({
      balance: 5000,
      cash: 4398.7,
      positionValue: 601.3,
    });
  });
});

// ---------------------------------------------------------------------------
// What does and does not count
// ---------------------------------------------------------------------------

describe('scope of the position-value aggregate', () => {
  it('counts only open positions — drafts are invisible', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');

    // A draft with an entry fill. Drafts cannot take exit fills, so they never
    // realize anything and never touch the ledger; counting them here would
    // move cash against a balance that never moved.
    const created = await authedRequest('POST', '/api/positions', cookie, {
      accountId: account.id,
      symbol: 'MSFT',
      side: 'long',
      assetType: 'stock',
    });
    expect(created.status).toBe(201);
    await addFill(cookie, (await created.json()).id, {
      type: 'entry',
      price: '100',
      quantity: '10',
      filledAt: '2026-01-01T00:00:00Z',
    });

    expect(await split(cookie, account.id)).toEqual({
      balance: 5000,
      cash: 5000,
      positionValue: 0,
    });
  });

  it('puts reconciliation adjustments in cash, not in position value', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '5000');
    await openWithEntry(cookie, account.id, { price: '100', quantity: '10' });

    // A $500 deposit, recorded by reconciling to the new target. This is the
    // `balance_adjustment` entry type — a cash movement, and it needs no
    // special handling: it is already in `balance` and is not position value,
    // so the subtraction routes it to cash on its own.
    const reconciled = await authedRequest('POST', `/api/ledger/${account.id}/reconcile`, cookie, {
      targetBalance: '5500',
    });
    expect(reconciled.status).toBe(201);

    expect(await split(cookie, account.id)).toEqual({
      balance: 5500,
      cash: 4500,
      positionValue: 1000,
    });
  });

  it('scopes position value to the owning account', async () => {
    const cookie = await registerAndGetCookie();
    const a = await createAccount(cookie, '5000');
    const b = await createAccount(cookie, '2000');

    await openWithEntry(cookie, a.id, { price: '100', quantity: '10' });
    await openWithEntry(cookie, b.id, { price: '50', quantity: '4', symbol: 'MSFT' });

    expect(await split(cookie, a.id)).toEqual({ balance: 5000, cash: 4000, positionValue: 1000 });
    expect(await split(cookie, b.id)).toEqual({ balance: 2000, cash: 1800, positionValue: 200 });
  });

  it('does not leak another user’s positions into the aggregate', async () => {
    const owner = await registerAndGetCookie();
    const account = await createAccount(owner, '5000');
    await openWithEntry(owner, account.id, { price: '100', quantity: '10' });

    const stranger = await registerAndGetCookie();
    const denied = await authedRequest('GET', `/api/accounts/${account.id}`, stranger);
    expect(denied.status).toBe(404);

    // And the owner's own figures are unchanged by the stranger existing.
    expect(await split(owner, account.id)).toEqual({
      balance: 5000,
      cash: 4000,
      positionValue: 1000,
    });
  });
});

// ---------------------------------------------------------------------------
// SQL / TypeScript parity
// ---------------------------------------------------------------------------

describe('parity between the SQL aggregate and computeOpenCostBasis', () => {
  // `positionValue` on the account is a SQL LATERAL in accounts.query.ts;
  // `openCostBasis` on each position is `computeOpenCostBasis` in pnl.ts. They
  // encode the same rule in two languages because the account aggregate cannot
  // be TypeScript (it would be an N+1 across accounts) and the per-row display
  // cannot be SQL. Nothing but this test stops them drifting apart.
  it('agrees across long, short, option, partial exits and fees', async () => {
    const cookie = await registerAndGetCookie();
    const account = await createAccount(cookie, '10000');

    // Long, partially exited, with fees on both legs.
    const long = await openWithEntry(cookie, account.id, {
      price: '100',
      quantity: '10',
      fees: '7.50',
    });
    await addFill(cookie, long.id, {
      type: 'exit',
      price: '112.34',
      quantity: '3',
      fees: '1.25',
      filledAt: '2026-01-02T00:00:00Z',
    });

    // Short, partially covered, with an entry fee.
    const short = await openWithEntry(cookie, account.id, {
      side: 'short',
      symbol: 'TSLA',
      price: '243.17',
      quantity: '7',
      fees: '3.10',
    });
    await addFill(cookie, short.id, {
      type: 'exit',
      price: '230.05',
      quantity: '2',
      filledAt: '2026-01-02T00:00:00Z',
    });

    // Option, untouched since entry.
    await openWithEntry(cookie, account.id, {
      assetType: 'option',
      symbol: 'AAPL260116C00150000',
      price: '4.35',
      quantity: '3',
      fees: '1.95',
    });

    // A flat position, which must contribute nothing to either side.
    const flat = await openWithEntry(cookie, account.id, {
      symbol: 'NVDA',
      price: '80',
      quantity: '5',
      fees: '2',
    });
    await addFill(cookie, flat.id, {
      type: 'exit',
      price: '85',
      quantity: '5',
      fees: '2',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const open = await listPositions(cookie, '?status=open');
    expect(open).toHaveLength(3);

    const summed = open.reduce(
      (total: number, p: { openCostBasis: number }) => total + p.openCostBasis,
      0,
    );
    const { balance, cash, positionValue } = await split(cookie, account.id);

    // Rounded to cents: the SQL sums unrounded per-position terms and rounds
    // once at the end, while the TypeScript rounds each position. They agree to
    // the cent, which is the contract — not bit-for-bit.
    expect(positionValue).toBeCloseTo(summed, 2);
    expect(cash + positionValue).toBeCloseTo(balance, 4);

    // The flat position reports zero on the TypeScript side too.
    const all = await listPositions(cookie);
    const flatRow = all.find((p: { id: string }) => p.id === flat.id);
    expect(flatRow.openCostBasis).toBe(0);
  });
});
