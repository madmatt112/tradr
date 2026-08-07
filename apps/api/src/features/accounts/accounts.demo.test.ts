import Decimal from 'decimal.js';
import { asc, eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { accounts as accountsTable, fills, ledgerEntries, positions, users } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  postFillLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import {
  replaceCloseHook,
  replaceFillHook,
  replaceReverseHook,
  unregisterCloseHook,
  unregisterFillHook,
  unregisterReverseHook,
} from '@/features/positions/positions.service';

// The whole point of the seeder is that realized P&L is DERIVED by these hooks
// rather than written by the seeder, so the production hooks are installed for
// this file. Without them the seed would still create positions and fills and
// the ledger assertions below would catch it.
beforeAll(() => {
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
  replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
  replaceFillHook('ledger', postFillLedgerEntries);
});

afterAll(() => {
  unregisterCloseHook('ledger');
  unregisterReverseHook('ledger');
  unregisterFillHook('ledger');
});

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `acct-demo-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 100;
function uniqueIp() {
  return `10.7.0.${++ipCounter}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<{ cookie: string; userId: string }> {
  const email = uniqueEmail();
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { cookie, userId: user.id };
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

/**
 * Everything the seed wrote for one user, projected into a shape that can be
 * compared across users: identifiers and row order are dropped, values are not.
 */
async function readSeededData(userId: string) {
  const positionRows = await db
    .select()
    .from(positions)
    .where(eq(positions.userId, userId))
    .orderBy(asc(positions.symbol));

  const fillRows = positionRows.length
    ? await db
        .select()
        .from(fills)
        .where(
          inArray(
            fills.positionId,
            positionRows.map((p) => p.id),
          ),
        )
    : [];

  const bySymbol = new Map(positionRows.map((p) => [p.id, p.symbol]));

  const ledgerRows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, userId));

  return {
    positions: positionRows.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      assetType: p.assetType,
      status: p.status,
      notes: p.notes,
      targetPrice: p.targetPrice,
      stopLoss: p.stopLoss,
      openedAt: p.openedAt?.toISOString() ?? null,
      closedAt: p.closedAt?.toISOString() ?? null,
      lastFlatNetPnl: p.lastFlatNetPnl,
    })),
    fills: fillRows
      .map((f) => ({
        symbol: bySymbol.get(f.positionId)!,
        type: f.type,
        price: f.price,
        quantity: f.quantity,
        fees: f.fees,
        filledAt: f.filledAt.toISOString(),
      }))
      .sort((a, b) =>
        `${a.symbol}${a.type}${a.filledAt}`.localeCompare(`${b.symbol}${b.type}${b.filledAt}`),
      ),
    ledger: ledgerRows
      .map((l) => ({
        symbol: l.symbol,
        entryType: l.entryType,
        direction: l.direction,
        amount: l.amount,
        currency: l.currency,
        occurredAt: l.occurredAt.toISOString(),
      }))
      .sort((a, b) => `${a.symbol}${a.occurredAt}`.localeCompare(`${b.symbol}${b.occurredAt}`)),
  };
}

describe('POST /api/accounts/demo', () => {
  it('creates one flagged account whose positions AND derived ledger rows are both present', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    const res = await authedRequest('POST', '/api/accounts/demo', cookie);
    expect(res.status).toBe(201);
    const account = (await res.json()) as { id: string; name: string; isDemo: boolean };

    const accountRows = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.userId, userId));
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0].isDemo).toBe(true);
    expect(accountRows[0].id).toBe(account.id);
    expect(accountRows[0].startingBalance).toBe('25000.0000');

    const data = await readSeededData(userId);

    // Ten closed, three open, one planned.
    expect(data.positions).toHaveLength(14);
    const byStatus = data.positions.reduce<Record<string, number>>((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStatus).toEqual({ closed: 10, open: 3, draft: 1 });

    // Every closed position carries exactly one derived realized-P&L row, and
    // no other position carries one. This is the assertion that a raw-insert
    // implementation would fail: the rows exist only because the seed went
    // through the real fill and close path.
    expect(data.ledger).toHaveLength(10);
    expect(data.ledger.every((l) => l.entryType === 'position_pnl')).toBe(true);
    const closedSymbols = data.positions
      .filter((p) => p.status === 'closed')
      .map((p) => p.symbol)
      .sort();
    expect(data.ledger.map((l) => l.symbol).sort()).toEqual(closedSymbols);

    // Seven winners and three losers netting +1,728.00 against the fixture.
    const net = data.ledger.reduce(
      (sum, l) => (l.direction === 'credit' ? sum.plus(l.amount) : sum.minus(l.amount)),
      new Decimal(0),
    );
    expect(net.toFixed(2)).toBe('1728.00');
    expect(data.ledger.filter((l) => l.direction === 'credit')).toHaveLength(7);
    expect(data.ledger.filter((l) => l.direction === 'debit')).toHaveLength(3);

    // The ledger row lands on the close, not on the seeding run.
    const aapl = data.ledger.find((l) => l.symbol === 'AAPL')!;
    expect(aapl.occurredAt).toBe('2026-02-19T18:20:00.000Z');
    expect(aapl.amount).toBe('438.0000');

    // Closed positions have both fills; the planned one has only its entry.
    expect(data.fills).toHaveLength(14 + 10);
    expect(data.fills.filter((f) => f.symbol === 'UBER')).toHaveLength(1);
  });

  it('produces identical data for two users seeded independently', async () => {
    const first = await registerAndGetCookie();
    const second = await registerAndGetCookie();

    expect((await authedRequest('POST', '/api/accounts/demo', first.cookie)).status).toBe(201);
    expect((await authedRequest('POST', '/api/accounts/demo', second.cookie)).status).toBe(201);

    expect(await readSeededData(second.userId)).toEqual(await readSeededData(first.userId));
  });

  it('refuses to seed when the user already has an account', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    const created = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(created.status).toBe(201);

    const res = await authedRequest('POST', '/api/accounts/demo', cookie);
    expect(res.status).toBe(409);

    const accountRows = await db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.userId, userId));
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0].isDemo).toBe(false);
  });

  it('refuses a second seed, leaving the first untouched', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    expect((await authedRequest('POST', '/api/accounts/demo', cookie)).status).toBe(201);
    const before = await readSeededData(userId);

    expect((await authedRequest('POST', '/api/accounts/demo', cookie)).status).toBe(409);

    expect(
      await db.select().from(accountsTable).where(eq(accountsTable.userId, userId)),
    ).toHaveLength(1);
    expect(await readSeededData(userId)).toEqual(before);
  });

  it('leaves nothing behind when the seed fails part-way through', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    // Fail on the third position to close, so the failure lands after an
    // account, several positions, their fills and real ledger rows have all
    // been written. Anything that survives is a half-seeded account.
    let closes = 0;
    replaceCloseHook('ledger', async (tx, ctx) => {
      if (++closes === 3) throw new Error('__forced_mid_seed_failure__');
      await insertPositionCloseLedgerEntries(tx, ctx);
    });

    try {
      const res = await authedRequest('POST', '/api/accounts/demo', cookie);
      expect(res.status).toBe(500);
      expect(closes).toBe(3);
    } finally {
      replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
    }

    expect(
      await db.select().from(accountsTable).where(eq(accountsTable.userId, userId)),
    ).toHaveLength(0);
    const data = await readSeededData(userId);
    expect(data.positions).toHaveLength(0);
    expect(data.fills).toHaveLength(0);
    expect(data.ledger).toHaveLength(0);

    // And the user can still seed cleanly afterwards — the failure is not sticky.
    expect((await authedRequest('POST', '/api/accounts/demo', cookie)).status).toBe(201);
    expect((await readSeededData(userId)).ledger).toHaveLength(10);
  });

  it('requires authentication', async () => {
    const res = await app.request('/api/accounts/demo', {
      method: 'POST',
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });
});
