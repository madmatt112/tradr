import { eq } from 'drizzle-orm';
import { describe, it, expect, afterEach } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { accounts as accountsTable, positions, users, ledgerEntries } from '@/db/schema';
import { config } from '@/lib/config';

import { resolveWritableAccountId } from './accounts.query';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `acct-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 100;
function uniqueIp() {
  return `10.1.0.${++ipCounter}`;
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

async function createTestAccount(
  cookie: string,
  name = 'Test Account',
  currency = 'USD',
  brokerageId?: string | null,
) {
  const body: Record<string, unknown> = { name, currency };
  if (brokerageId !== undefined) body.brokerageId = brokerageId;
  const res = await authedRequest('POST', '/api/accounts', cookie, body);
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestBrokerage(cookie: string, name = 'Test Brokerage') {
  const res = await authedRequest('POST', '/api/brokerages', cookie, { name });
  expect(res.status).toBe(201);
  return res.json();
}

describe('accounts', () => {
  // 1. Create account — success
  it('creates an account with valid data', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'My Brokerage',
      currency: 'USD',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.name).toBe('My Brokerage');
    expect(body.currency).toBe('USD');
  });

  // 2. List accounts — returns user's accounts
  it('lists accounts for the authenticated user', async () => {
    const { cookie } = await registerAndGetCookie();
    await createTestAccount(cookie, 'Account A', 'USD');
    await createTestAccount(cookie, 'Account B', 'EUR');

    const res = await authedRequest('GET', '/api/accounts', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    const names = body.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual(['Account A', 'Account B']);
  });

  // 3. Get account by ID — success
  it('gets an account by ID', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'Lookup Account');

    const res = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(account.id);
    expect(body.name).toBe('Lookup Account');
  });

  // 4. Update account — success
  it('updates an account', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'Old Name', 'USD');

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      name: 'New Name',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('New Name');
    expect(body.currency).toBe('USD');
  });

  // 5. Delete account — success
  it('deletes an account', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'To Delete');

    const deleteRes = await authedRequest('DELETE', `/api/accounts/${account.id}`, cookie);
    expect(deleteRes.status).toBe(204);

    const getRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    expect(getRes.status).toBe(404);
  });

  // 6. Duplicate name detection — case-insensitive
  it('returns 409 for duplicate account name (case-insensitive)', async () => {
    const { cookie } = await registerAndGetCookie();
    await createTestAccount(cookie, 'My Account', 'USD');

    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'my account',
      currency: 'EUR',
    });
    expect(res.status).toBe(409);
  });

  // 7. Currency change blocked when positions exist
  it('returns 409 when changing currency with existing positions', async () => {
    const { cookie } = await registerAndGetCookie();

    // Get user ID from /me
    const meRes = await authedRequest('GET', '/api/auth/me', cookie);
    const me = await meRes.json();

    const account = await createTestAccount(cookie, 'Has Positions', 'USD');

    // Insert a position directly. performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId: me.id,
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'equity',
      status: 'open',
    });

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      currency: 'EUR',
    });
    expect(res.status).toBe(409);
  });

  // REQ-2.7: cross-spec primary test (performance-charts spec)
  // Asserts the upstream currency-change guard (accounts.service.ts:72-75) by exact
  // status, error code, and message. Performance charts depends on stable-currency
  // accounts; weakening this guard would break the downstream invariant.
  it('returns 409 CONFLICT with exact message when changing currency with positions (REQ-2.7)', async () => {
    const { cookie } = await registerAndGetCookie();

    const meRes = await authedRequest('GET', '/api/auth/me', cookie);
    const me = await meRes.json();

    const account = await createTestAccount(cookie, 'REQ-2.7 Account', 'USD');

    // eslint-disable-next-line no-restricted-syntax -- performance-charts §8.2 audit: status='open' is CHECK-safe
    await db.insert(positions).values({
      userId: me.id,
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'equity',
      status: 'open',
    });

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      currency: 'EUR',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('Cannot change currency while account has positions');
  });

  // 7b. Currency change blocked when ledger entries remain but zero positions
  // (ledger-balances Req 7 cross-spec note, d-536e8750). A closed-position
  // delete can drop the position count to zero while append-only ledger rows
  // remain; the re-keyed guard ("has positions OR has ledger entries") keeps
  // currency locked so balance derivation cannot be corrupted.
  it('returns 409 when changing currency with ledger entries but no positions', async () => {
    const { cookie } = await registerAndGetCookie();

    const meRes = await authedRequest('GET', '/api/auth/me', cookie);
    const me = await meRes.json();

    const account = await createTestAccount(cookie, 'Ledger No Positions', 'USD');

    // Ledger row with positionId NULL — mimics the state left after a
    // closed-position delete cascades `position_id ON DELETE SET NULL`. Zero
    // positions, but ledger history exists.
    await db.insert(ledgerEntries).values({
      userId: me.id,
      accountId: account.id,
      positionId: null,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '100.0000',
      currency: 'USD',
      occurredAt: new Date('2026-04-01T15:00:00Z'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      currency: 'EUR',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  // 8. Delete blocked when positions exist
  it('returns 409 when deleting account with existing positions', async () => {
    const { cookie } = await registerAndGetCookie();

    const meRes = await authedRequest('GET', '/api/auth/me', cookie);
    const me = await meRes.json();

    const account = await createTestAccount(cookie, 'Has Positions Too', 'USD');

    // performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId: me.id,
      accountId: account.id,
      symbol: 'TSLA',
      side: 'short',
      assetType: 'equity',
      status: 'open',
    });

    const res = await authedRequest('DELETE', `/api/accounts/${account.id}`, cookie);
    expect(res.status).toBe(409);
  });

  // 9. Ownership scoping — user A can't see/modify user B's accounts
  it('prevents user A from accessing user B accounts', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();

    const accountA = await createTestAccount(cookieA, 'A Private');

    // User B cannot get user A's account
    const getRes = await authedRequest('GET', `/api/accounts/${accountA.id}`, cookieB);
    expect(getRes.status).toBe(404);

    // User B cannot update user A's account
    const putRes = await authedRequest('PUT', `/api/accounts/${accountA.id}`, cookieB, {
      name: 'Hacked',
    });
    expect(putRes.status).toBe(404);

    // User B cannot delete user A's account
    const deleteRes = await authedRequest('DELETE', `/api/accounts/${accountA.id}`, cookieB);
    expect(deleteRes.status).toBe(404);

    // User B's list should not include user A's account
    const listRes = await authedRequest('GET', '/api/accounts', cookieB);
    const list = await listRes.json();
    expect(list).toHaveLength(0);
  });

  // 10. Validation errors — empty name, invalid currency
  it('returns 400 for empty name', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: '',
      currency: 'USD',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid currency', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Bad Currency',
      currency: 'INVALID',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing name', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      currency: 'USD',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await app.request('/api/accounts', {
      method: 'GET',
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });

  // 11. Create account with brokerageId
  it('creates an account with a brokerageId', async () => {
    const { cookie } = await registerAndGetCookie();
    const brokerage = await createTestBrokerage(cookie, 'My Broker');
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Brokered Account',
      currency: 'USD',
      brokerageId: brokerage.id,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brokerageId).toBe(brokerage.id);
    expect(body.brokerageName).toBe('My Broker');
  });

  // 12. Update account brokerageId
  it('updates an account brokerageId', async () => {
    const { cookie } = await registerAndGetCookie();
    const brokerage = await createTestBrokerage(cookie, 'Broker For Update');
    const account = await createTestAccount(cookie, 'No Broker Yet');

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      brokerageId: brokerage.id,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brokerageId).toBe(brokerage.id);
  });

  // 13. Create account with null brokerageId
  it('creates an account with null brokerageId', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Null Broker Account',
      currency: 'USD',
      brokerageId: null,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brokerageId).toBeNull();
    expect(body.brokerageName).toBeNull();
  });

  // 14. Cross-user brokerage rejection
  it('returns 403 when assigning another user brokerage', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();

    const brokerageB = await createTestBrokerage(cookieB, 'B Private Broker');

    const res = await authedRequest('POST', '/api/accounts', cookieA, {
      name: 'Cross User Attempt',
      currency: 'USD',
      brokerageId: brokerageB.id,
    });
    expect(res.status).toBe(403);
  });

  // 15. Starting balance
  it('creates an account with a starting balance reflected in the derived balance', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Seeded Account',
      currency: 'USD',
      startingBalance: '2500.75',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.balance).toBe('2500.7500');
  });

  it('defaults the starting balance to zero when omitted', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Unseeded Account',
      currency: 'USD',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.balance).toBe('0.0000');
  });

  it.each([
    ['negative', '-100'],
    ['non-numeric', 'abc'],
    ['too many decimals', '1.00001'],
    ['untrimmed', ' 100 '],
    ['empty string', ''],
  ])('returns 400 for %s starting balance', async (_label, startingBalance) => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Bad Starting Balance',
      currency: 'USD',
      startingBalance,
    });
    expect(res.status).toBe(400);
  });

  it('rejects startingBalance on update (creation-only field)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'No Balance Edits');
    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      startingBalance: '999',
    });
    // UpdateAccountSchema does not accept the field; validation strips or
    // rejects it — either way the stored value must remain 0.
    const getRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    const body = await getRes.json();
    expect(body.balance).toBe('0.0000');
    expect([200, 400]).toContain(res.status);
  });

  // 15b. Default risk percentage. Editable after creation, unlike
  // startingBalance — it rewrites no history. The 400 cases below pin that its
  // bounds are rejected server-side, not only in the form.
  it('creates an account with a defaultRiskPercent and returns it on read', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Risk Rule Account',
      currency: 'USD',
      defaultRiskPercent: '1.5',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // numeric(5,2) normalises the stored decimal string to two places.
    expect(body.defaultRiskPercent).toBe('1.50');

    const getRes = await authedRequest('GET', `/api/accounts/${body.id}`, cookie);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).defaultRiskPercent).toBe('1.50');

    const listRes = await authedRequest('GET', '/api/accounts', cookie);
    const list = await listRes.json();
    expect(list[0].defaultRiskPercent).toBe('1.50');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['above 100', '101'],
    ['too many decimals', '3.141'],
    ['untrimmed', ' 1.5 '],
  ])('returns 400 for %s default risk percent', async (_label, defaultRiskPercent) => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Bad Risk Rule',
      currency: 'USD',
      defaultRiskPercent,
    });
    expect(res.status).toBe(400);
  });

  // The update path bounds the field through a DIFFERENT schema object
  // (UpdateAccountSchema, which is additionally nullable), so route-level
  // rejection has to be pinned separately from create's — and a rejected
  // update must leave the stored rule exactly as it was.
  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['above 100', '101'],
    ['too many decimals', '3.141'],
    ['untrimmed', ' 1.5 '],
  ])('returns 400 for %s default risk percent on update', async (_label, defaultRiskPercent) => {
    const { cookie } = await registerAndGetCookie();
    const createRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Bad Risk Rule Update',
      currency: 'USD',
      defaultRiskPercent: '1',
    });
    const account = await createRes.json();

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      defaultRiskPercent,
    });
    expect(res.status).toBe(400);

    const getRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    expect((await getRes.json()).defaultRiskPercent).toBe('1.00');
  });

  it('leaves defaultRiskPercent null when omitted on create', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'No Risk Rule');
    expect(account.defaultRiskPercent).toBeNull();
  });

  it('updates defaultRiskPercent', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'Risk Rule Edit');

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      defaultRiskPercent: '2.25',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).defaultRiskPercent).toBe('2.25');
  });

  // Omitted key === "leave it alone" (standard PATCH semantics). This is the
  // case a too-narrow `updateAccount` type would silently break in the other
  // direction, so it is pinned alongside the explicit-null clear below.
  it('leaves a stored defaultRiskPercent untouched when the update omits it', async () => {
    const { cookie } = await registerAndGetCookie();
    const createRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Untouched Risk Rule',
      currency: 'USD',
      defaultRiskPercent: '3',
    });
    const account = await createRes.json();
    expect(account.defaultRiskPercent).toBe('3.00');

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      name: 'Untouched Risk Rule Renamed',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Untouched Risk Rule Renamed');
    expect(body.defaultRiskPercent).toBe('3.00');
  });

  // Explicit null is a real value, not an omission — without it a user who set
  // a percentage could never remove it.
  it('clears defaultRiskPercent when the update sends an explicit null', async () => {
    const { cookie } = await registerAndGetCookie();
    const createRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Cleared Risk Rule',
      currency: 'USD',
      defaultRiskPercent: '5',
    });
    const account = await createRes.json();
    expect(account.defaultRiskPercent).toBe('5.00');

    const res = await authedRequest('PUT', `/api/accounts/${account.id}`, cookie, {
      defaultRiskPercent: null,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).defaultRiskPercent).toBeNull();

    const getRes = await authedRequest('GET', `/api/accounts/${account.id}`, cookie);
    expect((await getRes.json()).defaultRiskPercent).toBeNull();
  });

  // 16. Position-count endpoint
  it('returns position count for an account', async () => {
    const { cookie } = await registerAndGetCookie();

    const meRes = await authedRequest('GET', '/api/auth/me', cookie);
    const me = await meRes.json();

    const account = await createTestAccount(cookie, 'Count Positions');

    // Zero positions initially
    const zeroRes = await authedRequest(
      'GET',
      `/api/accounts/${account.id}/position-count`,
      cookie,
    );
    expect(zeroRes.status).toBe(200);
    const zeroBody = await zeroRes.json();
    expect(zeroBody.count).toBe(0);

    // Insert a position directly. performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId: me.id,
      accountId: account.id,
      symbol: 'MSFT',
      side: 'long',
      assetType: 'equity',
      status: 'open',
    });

    const oneRes = await authedRequest('GET', `/api/accounts/${account.id}/position-count`, cookie);
    expect(oneRes.status).toBe(200);
    const oneBody = await oneRes.json();
    expect(oneBody.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Plan-tiers: L1 account cap + writable-account designation (D9/D18,
// REQ-6.1/6.6/6.7). Real PG; gating toggled via the mutable config.
// ---------------------------------------------------------------------------

describe('accounts tier enforcement + writable designation (plan-tiers L1/D18)', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  async function getUserId(cookie: string): Promise<string> {
    const meRes = await authedRequest('GET', '/api/auth/me', cookie);
    const me = await meRes.json();
    return me.id;
  }

  // L1: create refusal at the cap (free tier, gating on)
  it('refuses account creation at the L1 cap with 403 TIER_LIMIT_ACCOUNTS', async () => {
    const { cookie } = await registerAndGetCookie();
    config.FEATURE_GATING = true;
    // Free cap is 1: the first create passes...
    await createTestAccount(cookie, 'First Account');
    // ...the second is refused with the stable code (never 429).
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Second Account',
      currency: 'USD',
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('TIER_LIMIT_ACCOUNTS');
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  // REQ-6.7: admin pass-through
  it('admin passes through the L1 cap unchanged', async () => {
    const { cookie, email } = await registerAndGetCookie();
    await db.update(users).set({ isAdmin: true }).where(eq(users.email, email));
    config.FEATURE_GATING = true;
    await createTestAccount(cookie, 'Admin One');
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Admin Two',
      currency: 'USD',
    });
    expect(res.status).toBe(201);
  });

  // REQ-6.7: gating-off pass-through (self-host parity)
  it('gating off passes through the L1 cap unchanged', async () => {
    const { cookie } = await registerAndGetCookie();
    config.FEATURE_GATING = false;
    await createTestAccount(cookie, 'Off One');
    const res = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Off Two',
      currency: 'USD',
    });
    expect(res.status).toBe(201);
  });

  // D18 mount-order pin: a shadowed static route would be captured by
  // PUT /:id, fail its uuid param schema, and 400 from the wrong handler.
  it('PUT /api/accounts/writable sets the designation (static route not shadowed by PUT /:id)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'Designated');
    const res = await authedRequest('PUT', '/api/accounts/writable', cookie, {
      accountId: account.id,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.writableAccountId).toBe(account.id);

    const userId = await getUserId(cookie);
    const [row] = await db
      .select({ writableAccountId: users.writableAccountId })
      .from(users)
      .where(eq(users.id, userId));
    expect(row.writableAccountId).toBe(account.id);
  });

  it('PUT /api/accounts/writable refuses a non-owned account with 404', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();
    const accountB = await createTestAccount(cookieB, 'B Private Account');

    const res = await authedRequest('PUT', '/api/accounts/writable', cookieA, {
      accountId: accountB.id,
    });
    expect(res.status).toBe(404);

    const userIdA = await getUserId(cookieA);
    const [row] = await db
      .select({ writableAccountId: users.writableAccountId })
      .from(users)
      .where(eq(users.id, userIdA));
    expect(row.writableAccountId).toBeNull();
  });

  // D18 deterministic default: activity > creation recency > id (total order)
  it('resolveWritableAccountId defaults to most recent position activity, then most-recently-created', async () => {
    const { cookie } = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const [older] = await db
      .insert(accountsTable)
      .values({
        userId,
        name: 'Older',
        currency: 'USD',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning();
    const [newer] = await db
      .insert(accountsTable)
      .values({
        userId,
        name: 'Newer',
        currency: 'USD',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      })
      .returning();

    // No positions anywhere: the most-recently-created account is the default.
    expect(await resolveWritableAccountId(db, userId)).toBe(newer!.id);

    // Position activity on the older account beats creation recency.
    // performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values({
      userId,
      accountId: older!.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'equity',
      status: 'open',
    });
    expect(await resolveWritableAccountId(db, userId)).toBe(older!.id);
  });

  it('resolveWritableAccountId resolves exact createdAt ties by id (total order)', async () => {
    const { cookie } = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const tie = new Date('2026-03-01T00:00:00Z');
    const [a] = await db
      .insert(accountsTable)
      .values({ userId, name: 'Tie A', currency: 'USD', createdAt: tie })
      .returning();
    const [b] = await db
      .insert(accountsTable)
      .values({ userId, name: 'Tie B', currency: 'USD', createdAt: tie })
      .returning();

    // Canonical lowercase uuid strings sort identically in JS and PG bytewise
    // order, so the expected winner is the lexicographically smaller id.
    const expected = [a!.id, b!.id].sort()[0];
    expect(await resolveWritableAccountId(db, userId)).toBe(expected);
  });

  it('resolveWritableAccountId ignores a stored designation that is no longer owned', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();
    const userIdA = await getUserId(cookieA);
    const own = await createTestAccount(cookieA, 'Own Account');
    const foreign = await createTestAccount(cookieB, 'Foreign Account');

    // Stored + owned: the designation wins.
    await db.update(users).set({ writableAccountId: own.id }).where(eq(users.id, userIdA));
    expect(await resolveWritableAccountId(db, userIdA)).toBe(own.id);

    // Stored but NOT owned (seeded directly — the endpoint refuses this):
    // fall back to the deterministic default.
    await db.update(users).set({ writableAccountId: foreign.id }).where(eq(users.id, userIdA));
    expect(await resolveWritableAccountId(db, userIdA)).toBe(own.id);
  });
});

// ---------------------------------------------------------------------------
// Default-account designation: first-created takes it, PUT /default moves it,
// delete promotes the oldest remaining, the sample account never holds it.
// ---------------------------------------------------------------------------

describe('accounts default designation', () => {
  async function listAccounts(cookie: string): Promise<Array<Record<string, unknown>>> {
    const res = await authedRequest('GET', '/api/accounts', cookie);
    expect(res.status).toBe(200);
    return res.json();
  }

  it('the first account created is the default; the second is not', async () => {
    const { cookie } = await registerAndGetCookie();
    const first = await createTestAccount(cookie, 'First');
    expect(first.isDefault).toBe(true);

    const second = await createTestAccount(cookie, 'Second', 'EUR');
    expect(second.isDefault).toBe(false);

    const rows = await listAccounts(cookie);
    expect(rows.filter((a) => a.isDefault).map((a) => a.id)).toEqual([first.id]);
  });

  // Mount-order pin: a shadowed static route would be captured by PUT /:id,
  // fail its uuid param schema, and 400 from the wrong handler.
  it('PUT /api/accounts/default moves the designation atomically (static route not shadowed)', async () => {
    const { cookie } = await registerAndGetCookie();
    const first = await createTestAccount(cookie, 'First');
    const second = await createTestAccount(cookie, 'Second', 'EUR');

    const res = await authedRequest('PUT', '/api/accounts/default', cookie, {
      accountId: second.id,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).defaultAccountId).toBe(second.id);

    // Exactly one default, and it moved — the old one is cleared in the same
    // statement.
    const rows = await listAccounts(cookie);
    expect(rows.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.id]);
    expect(rows.find((a) => a.id === first.id)?.isDefault).toBe(false);
  });

  it('PUT /api/accounts/default refuses a non-owned account with 404, changing nothing', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();
    const own = await createTestAccount(cookieA, 'Own');
    const foreign = await createTestAccount(cookieB, 'Foreign');

    const res = await authedRequest('PUT', '/api/accounts/default', cookieA, {
      accountId: foreign.id,
    });
    expect(res.status).toBe(404);

    const rows = await listAccounts(cookieA);
    expect(rows.filter((a) => a.isDefault).map((a) => a.id)).toEqual([own.id]);
  });

  it('the sample account never takes the designation and cannot be made the default', async () => {
    const { cookie } = await registerAndGetCookie();
    const seedRes = await authedRequest('POST', '/api/accounts/demo', cookie);
    expect(seedRes.status).toBe(201);
    const demo = await seedRes.json();
    expect(demo.isDefault).toBe(false);

    const res = await authedRequest('PUT', '/api/accounts/default', cookie, {
      accountId: demo.id,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('DEMO_ACCOUNT_NOT_DEFAULTABLE');
  });

  it('deleting the default promotes the oldest remaining account', async () => {
    const { cookie } = await registerAndGetCookie();
    const first = await createTestAccount(cookie, 'First');
    const second = await createTestAccount(cookie, 'Second', 'EUR');
    const third = await createTestAccount(cookie, 'Third', 'GBP');

    const res = await authedRequest('DELETE', `/api/accounts/${first.id}`, cookie);
    expect(res.status).toBe(204);

    // "The first account the user created" — creation order, not id order.
    const rows = await listAccounts(cookie);
    expect(rows.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.id]);
    expect(rows.find((a) => a.id === third.id)?.isDefault).toBe(false);
  });

  it('deleting a non-default account leaves the designation alone', async () => {
    const { cookie } = await registerAndGetCookie();
    const first = await createTestAccount(cookie, 'First');
    const second = await createTestAccount(cookie, 'Second', 'EUR');

    const res = await authedRequest('DELETE', `/api/accounts/${second.id}`, cookie);
    expect(res.status).toBe(204);

    const rows = await listAccounts(cookie);
    expect(rows.filter((a) => a.isDefault).map((a) => a.id)).toEqual([first.id]);
  });

  it('deleting the last account leaves no default; the next create takes it again', async () => {
    const { cookie } = await registerAndGetCookie();
    const only = await createTestAccount(cookie, 'Only');
    const res = await authedRequest('DELETE', `/api/accounts/${only.id}`, cookie);
    expect(res.status).toBe(204);
    expect(await listAccounts(cookie)).toHaveLength(0);

    const next = await createTestAccount(cookie, 'Next');
    expect(next.isDefault).toBe(true);
  });

  // Server-set only: the update schema strips the key, so a request claiming
  // the designation changes nothing.
  it('PUT /api/accounts/:id cannot set isDefault', async () => {
    const { cookie } = await registerAndGetCookie();
    await createTestAccount(cookie, 'First');
    const second = await createTestAccount(cookie, 'Second', 'EUR');

    const res = await authedRequest('PUT', `/api/accounts/${second.id}`, cookie, {
      name: 'Second Renamed',
      isDefault: true,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).isDefault).toBe(false);
  });
});
