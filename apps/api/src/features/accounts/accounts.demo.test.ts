import Decimal from 'decimal.js';
import { asc, eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

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
import { config } from '@/lib/config';

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
    // The ordinary account shape, with the sample-data flag on it. It is
    // read-only on the way out — the flag is still the server's own
    // authorisation and no request can set it — but a client cannot label or
    // offer to remove sample data it has no way of recognising.
    const account = (await res.json()) as { id: string; name: string; isDemo: boolean };
    expect(account.name).toBe('Demo Account');
    expect(account.isDemo).toBe(true);

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

  it('marks the sample account on the list and the detail read, and real accounts as not', async () => {
    // Without this the client can only guess which account is the sample one,
    // and the only guess available — "it is the only account" — is an invariant
    // enforced somewhere else entirely.
    const { cookie } = await registerAndGetCookie();
    expect((await authedRequest('POST', '/api/accounts/demo', cookie)).status).toBe(201);

    const listRes = await authedRequest('GET', '/api/accounts', cookie);
    const list = (await listRes.json()) as { id: string; isDemo: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0].isDemo).toBe(true);

    const detailRes = await authedRequest('GET', `/api/accounts/${list[0].id}`, cookie);
    expect(((await detailRes.json()) as { isDemo: boolean }).isDemo).toBe(true);

    // And a real account reads false rather than absent — the flag answers the
    // question for every account, not only for the interesting one.
    const other = await registerAndGetCookie();
    const created = await authedRequest('POST', '/api/accounts', other.cookie, {
      name: 'Main',
      currency: 'USD',
    });
    expect(((await created.json()) as { isDemo: boolean }).isDemo).toBe(false);
  });

  it('keeps the sample trades in a window that still looks current', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    expect((await authedRequest('POST', '/api/accounts/demo', cookie)).status).toBe(201);

    const { positions: seededPositions } = await readSeededData(userId);

    // THE NEWEST CLOSE, not the newest fill. Every figure the dashboard draws
    // comes from closed positions — the stats tiles, the equity curve and the
    // bar chart are all cut from `closed_at` — so an entry fill against a
    // position that is still open, or against the planned trade that was never
    // opened, moves nothing on screen. Reading the newest FILL is what let this
    // guard report a nine-day-old fixture as current while the newest CLOSE was
    // a month old and the dashboard had nothing to show.
    const closes = seededPositions
      .map((p) => p.closedAt)
      .filter((closedAt): closedAt is string => closedAt !== null);
    expect(closes.length, 'the fixture still has closed trades to measure').toBeGreaterThan(0);
    const newestClose = new Date(closes.reduce((max, at) => (at > max ? at : max)));

    // WHOLE CALENDAR MONTHS, not days. Every window the dashboard asks for is
    // cut on a month boundary — `all-time` anchors its start on the first of
    // the earliest close's month, and the performance widget's default
    // `monthly` preset is a rolling twelve of them — so a day count means
    // something different depending on where in the month it is read. An
    // 85-day-old close is inside the window on the 30th and outside it on the
    // 1st; a month count says the same thing on both days.
    const now = new Date();
    const monthsBehind =
      (now.getUTCFullYear() - newestClose.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - newestClose.getUTCMonth());

    // The fixture's dates are absolute, which is exactly what makes the
    // documentation screenshots and the end-to-end assertions stable — and also
    // what makes the window age. A comment asking a future maintainer to move
    // the dates forward is not a mechanism; this is. When it fails, move them
    // forward in the fixture and regenerate the screenshots in the same change.
    //
    // Three months of slack against a twelve-month cliff. Twelve is not a
    // warning — it is the point at which the sample account is already broken:
    // the dashboard's performance widget defaults to a rolling twelve months,
    // so a close older than that leaves the chart with nothing to plot and the
    // docs capture's paint gate fails on it. Two months behind is the last
    // point the account still reads as live: by then the 30-day preset has been
    // empty for a while and the three positions the fixture leaves open have
    // gone a quarter without a fill against them, which reads as abandoned. It
    // is also a cadence a maintainer can plan a deliberate refresh around,
    // which a bound that only fires once the demo is past saving is not.
    //
    // Move the DATES when this fails. Moving this number instead is the failure
    // it exists to catch.
    expect(monthsBehind).toBeLessThanOrEqual(2);
    // Not ahead of the clock either: a sample account whose newest trade has not
    // happened yet reads as broken in the other direction.
    expect(monthsBehind).toBeGreaterThanOrEqual(0);
    expect(newestClose.getTime()).toBeLessThan(now.getTime());
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

/**
 * The marker as STORED, read straight out of the column rather than through
 * `selectDemoMarker`. What is really in the jsonb is the whole question below,
 * and going through the slice's own reader would only prove it agrees with
 * itself.
 */
async function readDemoMarker(userId: string) {
  const [row] = await db
    .select({ onboarding: users.onboarding })
    .from(users)
    .where(eq(users.id, userId));
  return (row?.onboarding as Record<string, unknown> | undefined)?.demo;
}

async function getOnboarding(cookie: string) {
  const res = await authedRequest('GET', '/api/users/me/onboarding', cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * `users.onboarding -> 'demo'` is bookkeeping the seed shares with its teardown,
 * and it is deliberately not described by `OnboardingStateSchema`. That leaves
 * its safety resting entirely on two properties of code that never mentions it:
 * the state schema STRIPS unknown keys on read, so the marker cannot reach a
 * client, and `updateUserOnboarding` merges IN SQL naming only its own keys, so
 * no client PATCH can destroy it.
 *
 * Both are one plausible edit away from breaking silently — a `.passthrough()`
 * added to the schema, or that SQL merge turned into a read-modify-write — and
 * neither edit would fail anything in the onboarding slice, whose own tests
 * cover keys it is happy to publish. These are the tests that fail instead: the
 * marker's presence is asserted on the raw column, and its consequences (the
 * currency the seed latched, the id that makes a repeat teardown a success) are
 * asserted through the endpoints that depend on them.
 */
describe('the private demo marker is invisible to the client and safe from it', () => {
  it('never reaches the onboarding response', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId } = await seedDemo(cookie, userId);

    // It really is in the column, so its absence below is the schema stripping
    // it rather than the seed never having written it.
    expect(await readDemoMarker(userId)).toEqual({ accountId, latchedDisplayCurrency: true });

    const body = await getOnboarding(cookie);
    expect(body).toEqual({ status: 'pending', coachMarksSeen: [] });
    expect('demo' in body).toBe(false);
    // And the internal account id is not in the payload under any other key
    // either — it is not the client's to know, whatever it might be nested in.
    expect(JSON.stringify(body)).not.toContain(accountId);
  });

  it('survives an ordinary client PATCH, with teardown still able to use it', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId } = await seedDemo(cookie, userId);
    expect(await readDisplayCurrency(userId)).toBe('USD');

    const patched = await authedRequest('PATCH', '/api/users/me/onboarding', cookie, {
      status: 'done',
      coachMarkSeen: 'csv-import',
    });
    expect(patched.status).toBe(200);
    // The merged state on the way back out carries no more than the GET does.
    expect(await patched.json()).toEqual({ status: 'done', coachMarksSeen: ['csv-import'] });

    // The merge rewrote only the keys the body named. A read-modify-write
    // through the state schema would have parsed the marker away right here,
    // and the request would still have answered 200.
    expect(await readDemoMarker(userId)).toEqual({ accountId, latchedDisplayCurrency: true });

    // Still load-bearing rather than merely present: teardown reads
    // `latchedDisplayCurrency` off it to decide whether the currency is its to
    // undo. Lose the marker to a client PATCH and the sample data's currency is
    // left on the user for good.
    expect(
      (await authedRequest('DELETE', `/api/accounts/${accountId}?cascade=demo`, cookie)).status,
    ).toBe(204);
    expect(await readDisplayCurrency(userId)).toBeNull();
  });

  it('rejects a client-supplied demo key rather than storing it', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const { accountId } = await seedDemo(cookie, userId);

    // The PATCH body is strict, so naming the server's own key is a 400 — not a
    // silent drop, and not a partial application of the rest of the body.
    const res = await authedRequest('PATCH', '/api/users/me/onboarding', cookie, {
      status: 'done',
      demo: { accountId: crypto.randomUUID(), latchedDisplayCurrency: false },
    });
    expect(res.status).toBe(400);

    expect(await readDemoMarker(userId)).toEqual({ accountId, latchedDisplayCurrency: true });
    expect((await getOnboarding(cookie)).status).toBe('pending');
  });
});

/**
 * The creation half of mutual exclusion. The seeding half already refuses to
 * add sample data to a user who has an account; this is the same rule from the
 * other side, and between them there is no supported state in which sample and
 * real data coexist.
 *
 * It matters more than a tidy invariant. Every aggregate the app renders scopes
 * by currency and never by account, so the alternative to refusing here is a
 * per-account filter on each of them — and the moment one is missed, invented
 * trades are in the user's own numbers with nothing on screen to say so.
 */
describe('POST /api/accounts while the sample account exists', () => {
  const gatingBefore = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = gatingBefore;
  });

  it('refuses with a code the client can act on, and creates nothing', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    await seedDemo(cookie, userId);

    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(res.status).toBe(409);
    // The code, not the sentence: the client branches on this to offer removing
    // the sample data and retrying, and a plain conflict would leave it with
    // nothing to distinguish this from a duplicate name.
    expect((await res.json()).error.code).toBe('DEMO_ACCOUNT_EXISTS');

    const rows = await db.select().from(accountsTable).where(eq(accountsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].isDemo).toBe(true);
  });

  it('tells a gated Free user to remove the sample data rather than to upgrade', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    config.FEATURE_GATING = true;

    // The sample account occupies the Free plan's single slot, so this user is
    // at the cap purely by having accepted the offer of sample data. Checked in
    // the other order they would be sold an upgrade to escape it.
    await seedDemo(cookie, userId);

    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DEMO_ACCOUNT_EXISTS');
  });

  it('still enforces the plan cap for a gated Free user whose account is a real one', async () => {
    const { cookie } = await registerAndGetCookie();
    config.FEATURE_GATING = true;

    const first = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'First Account',
      currency: 'USD',
    });
    expect(first.status).toBe(201);

    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Second Account',
      currency: 'USD',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('TIER_LIMIT_ACCOUNTS');
  });

  it('refuses with nothing configured, as a self-hosted deployment runs', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    config.FEATURE_GATING = false;
    await seedDemo(cookie, userId);

    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'USD',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DEMO_ACCOUNT_EXISTS');
  });

  it('creates normally once the sample data has been removed', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    config.FEATURE_GATING = true;
    const { accountId } = await seedDemo(cookie, userId);

    expect(
      (await authedRequest('DELETE', `/api/accounts/${accountId}?cascade=demo`, cookie)).status,
    ).toBe(204);

    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Real Account',
      currency: 'CAD',
    });
    expect(res.status).toBe(201);

    const rows = await db.select().from(accountsTable).where(eq(accountsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].isDemo).toBe(false);
  });
});
