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

  it('keeps the sample trades in a window that still looks current', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    expect((await authedRequest('POST', '/api/accounts/demo', cookie)).status).toBe(201);

    const { fills: seededFills } = await readSeededData(userId);
    const newest = seededFills.reduce((max, f) => (f.filledAt > max ? f.filledAt : max), '');
    const ageInDays = (Date.now() - Date.parse(newest)) / 86_400_000;

    // The fixture's dates are absolute, which is exactly what makes the
    // documentation screenshots and the end-to-end assertions stable — and also
    // what makes the window age. A comment asking a future maintainer to move
    // the dates forward is not a mechanism; this is. When it fails, move them
    // forward in the fixture and regenerate the screenshots in the same change.
    expect(ageInDays).toBeLessThan(365);
    // Not ahead of the clock either: a sample account whose newest trade has not
    // happened yet reads as broken in the other direction.
    expect(ageInDays).toBeGreaterThan(0);
  });
});

/**
 * What is still booked against an account, counted directly rather than through
 * any of the code under test.
 *
 * `positionIds` has to be captured before the teardown, because a fill reaches
 * its account only through its position — once the positions are gone, a fill
 * that outlived them would be invisible to every query that starts from the
 * account, which is precisely the orphan worth looking for.
 */
async function countRemaining(accountId: string, positionIds: string[]) {
  const accountRows = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  const positionRows = await db.select().from(positions).where(eq(positions.accountId, accountId));
  const fillRows = positionIds.length
    ? await db.select().from(fills).where(inArray(fills.positionId, positionIds))
    : [];
  const ledgerRows = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));

  return {
    accounts: accountRows.length,
    positions: positionRows.length,
    fills: fillRows.length,
    ledger: ledgerRows.length,
  };
}

async function readDisplayCurrency(userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row.displayCurrency;
}

async function seedDemo(cookie: string, userId: string) {
  const res = await authedRequest('POST', '/api/accounts/demo', cookie);
  expect(res.status).toBe(201);
  const account = (await res.json()) as { id: string };
  const positionIds = (await db.select().from(positions).where(eq(positions.userId, userId))).map(
    (p) => p.id,
  );
  return { accountId: account.id, positionIds };
}

describe('DELETE /api/accounts/:id?cascade=demo', () => {
  it('removes the sample account and everything booked against it', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId, positionIds } = await seedDemo(cookie, userId);

    expect(await countRemaining(accountId, positionIds)).toEqual({
      accounts: 1,
      positions: 14,
      fills: 24,
      ledger: 10,
    });

    const res = await authedRequest('DELETE', `/api/accounts/${accountId}?cascade=demo`, cookie);
    expect(res.status).toBe(204);

    expect(await countRemaining(accountId, positionIds)).toEqual({
      accounts: 0,
      positions: 0,
      fills: 0,
      ledger: 0,
    });

    const list = await authedRequest('GET', '/api/accounts', cookie);
    expect(await list.json()).toEqual([]);
  });

  it('clears the display currency the seed set, so a later real account sets its own', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId } = await seedDemo(cookie, userId);
    expect(await readDisplayCurrency(userId)).toBe('USD');

    expect(
      (await authedRequest('DELETE', `/api/accounts/${accountId}?cascade=demo`, cookie)).status,
    ).toBe(204);
    expect(await readDisplayCurrency(userId)).toBeNull();

    // Which is the point of clearing it: the materialization only ever fires on
    // a user who has none, so a value left behind by disposable data would have
    // made this account report in the wrong currency for good.
    const created = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'CAD',
    });
    expect(created.status).toBe(201);
    expect(await readDisplayCurrency(userId)).toBe('CAD');
  });

  it('leaves a display currency the user set themselves', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    // A real account materializes USD, then goes away — so by the time the
    // sample account is seeded the column is already set and the seed's own
    // first-writer-wins update does nothing. The value is the user's, not the
    // sample data's, and teardown must be able to tell the difference.
    const created = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(created.status).toBe(201);
    const real = (await created.json()) as { id: string };
    expect((await authedRequest('DELETE', `/api/accounts/${real.id}`, cookie)).status).toBe(204);
    expect(await readDisplayCurrency(userId)).toBe('USD');

    const { accountId } = await seedDemo(cookie, userId);
    expect(
      (await authedRequest('DELETE', `/api/accounts/${accountId}?cascade=demo`, cookie)).status,
    ).toBe(204);

    expect(await readDisplayCurrency(userId)).toBe('USD');
  });

  it('still refuses a real account holding positions', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    const created = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(created.status).toBe(201);
    const account = (await created.json()) as { id: string };

    // performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId,
      accountId: account.id,
      symbol: 'TSLA',
      side: 'short',
      assetType: 'equity',
      status: 'open',
    });

    // Asking for the teardown does not grant it. The account's stored flag is
    // what decides, and this account's says no, so the request meets the same
    // guard it would have met without the parameter.
    const res = await authedRequest('DELETE', `/api/accounts/${account.id}?cascade=demo`, cookie);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe('Cannot delete account while it has positions');

    const rows = await db.select().from(accountsTable).where(eq(accountsTable.id, account.id));
    expect(rows).toHaveLength(1);
  });

  it("refuses another user's sample account and leaves it intact", async () => {
    const owner = await registerAndGetCookie();
    const other = await registerAndGetCookie();
    const { accountId, positionIds } = await seedDemo(owner.cookie, owner.userId);

    const res = await authedRequest(
      'DELETE',
      `/api/accounts/${accountId}?cascade=demo`,
      other.cookie,
    );
    expect(res.status).toBe(404);

    expect(await countRemaining(accountId, positionIds)).toEqual({
      accounts: 1,
      positions: 14,
      fills: 24,
      ledger: 10,
    });
  });

  it("refuses another user's real account", async () => {
    const owner = await registerAndGetCookie();
    const other = await registerAndGetCookie();

    const created = await authedRequest('POST', '/api/accounts', owner.cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(created.status).toBe(201);
    const account = (await created.json()) as { id: string };

    const res = await authedRequest(
      'DELETE',
      `/api/accounts/${account.id}?cascade=demo`,
      other.cookie,
    );
    expect(res.status).toBe(404);

    expect(
      await db.select().from(accountsTable).where(eq(accountsTable.id, account.id)),
    ).toHaveLength(1);
  });

  it('succeeds silently when the sample account is already gone', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId } = await seedDemo(cookie, userId);

    const path = `/api/accounts/${accountId}?cascade=demo`;
    expect((await authedRequest('DELETE', path, cookie)).status).toBe(204);
    expect((await authedRequest('DELETE', path, cookie)).status).toBe(204);
  });

  it("404s an id that was never the user's, even asking for the teardown", async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest(
      'DELETE',
      `/api/accounts/${crypto.randomUUID()}?cascade=demo`,
      cookie,
    );
    expect(res.status).toBe(404);
  });

  it('refuses the sample account when the teardown is not asked for', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId, positionIds } = await seedDemo(cookie, userId);

    const res = await authedRequest('DELETE', `/api/accounts/${accountId}`, cookie);
    expect(res.status).toBe(409);
    expect((await countRemaining(accountId, positionIds)).accounts).toBe(1);
  });

  it('rejects an unrecognised cascade value', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId, positionIds } = await seedDemo(cookie, userId);

    const res = await authedRequest('DELETE', `/api/accounts/${accountId}?cascade=true`, cookie);
    expect(res.status).toBe(400);
    expect((await countRemaining(accountId, positionIds)).accounts).toBe(1);
  });

  it('requires authentication', async () => {
    const res = await app.request(`/api/accounts/${crypto.randomUUID()}?cascade=demo`, {
      method: 'DELETE',
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });
});
