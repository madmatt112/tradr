import { describe, it, expect } from 'vitest';

import app from '@/app';

/**
 * Contract — task 8, design C7/D10/D11, AC 4.1/4.2/4.6, NFR Security, NFR Reliability
 *
 * 1. Pre: an open position with two entry lots (entry1 older/smaller price,
 *    entry2 newer) and one FIFO (unselected) exit that fully consumes entry1.
 *    Call: GET /api/positions/:id/lots (no exitFillId).
 *    Observe: `lots` carries one row per entry fill with entryFillId,
 *    filledAt, price, quantity and `available` reduced by the exit's slice.
 *    Expected value source: design C7's response shape and D11's availability
 *    rule, applied to the known FIFO match (entry1 fully consumed, entry2
 *    untouched).
 * 2. Pre: same position/exit as (1).
 *    Call: GET /api/positions/:id/lots?exitFillId=<the exit's id>.
 *    Observe: entry1's `available` returns to its full lot quantity (the
 *    exit's own slice is added back); entry2 is unaffected.
 *    Expected value source: design D11 ("less every other exit's current
 *    match") — excluding the named exit restores what it had consumed.
 * 3. Pre: a brand-new user (no stored jurisdiction or lot method) with a
 *    position, then the same user after PATCH /api/users/me/tax-jurisdiction
 *    'CA'.
 *    Call: GET /api/positions/:id/lots, twice.
 *    Observe: first call echoes `method: 'fifo'`, `jurisdiction: 'other'`;
 *    second echoes `method: 'average'`, `jurisdiction: 'CA'`.
 *    Expected value source: the task prompt's stated defaults (fifo/other for
 *    a new user, average after PATCH jurisdiction CA) and D10's method
 *    resolution via the stored jurisdiction.
 * 4. Three 404 cases, each from the task's Success line and design Error
 *    Handling item 7 ("Lots endpoint, unknown position or non-exit
 *    exitFillId: 404") and NFR Security (another user's position refused):
 *    4a. Call: GET on a random, non-existent position id. Observe: 404.
 *    4b. Pre: user A owns a position. Call: user B's session GETs user A's
 *        position id. Observe: 404 (cross-user scoping).
 *    4c. Pre: a position with one entry fill and no exit. Call: GET with
 *        `exitFillId` set to that entry fill's id (not an exit of the
 *        position). Observe: 404.
 * 5. Call: GET with no session cookie at all. Observe: 401.
 *
 * Red-first: the route does not exist at base (unmounted), so every call
 * above 404s/errors before reaching any of these assertions.
 */

let emailCounter = 0;
function uniqueEmail() {
  return `lots-route-test${++emailCounter}-${Date.now()}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  const n = ++ipCounter;
  const b = (n >> 8) & 255;
  const c = n & 255;
  return `10.7.${b}.${c || 1}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(email = uniqueEmail()): Promise<{ cookie: string }> {
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

let acctCounter = 0;
async function createTestAccount(cookie: string) {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: `Lots Route Test Account ${++acctCounter}-${Date.now()}`,
    currency: 'USD',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createDraftPosition(cookie: string, accountId: string) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
  });
  expect(res.status).toBe(201);
  return res.json();
}

function makeFill(
  overrides: Partial<{
    type: string;
    price: string;
    quantity: string;
    fees: string;
    filledAt: string;
  }>,
) {
  return {
    type: 'entry',
    price: '150.00',
    quantity: '10',
    fees: '1.00',
    filledAt: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

async function addFill(cookie: string, positionId: string, fill: ReturnType<typeof makeFill>) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, fill);
  expect(res.status).toBe(201);
  return res.json();
}

async function openPos(cookie: string, positionId: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {});
  expect(res.status).toBe(200);
  return res.json();
}

async function patchJurisdiction(cookie: string, value: 'US' | 'CA' | 'other' | null) {
  return authedRequest('PATCH', '/api/users/me/tax-jurisdiction', cookie, {
    taxJurisdiction: value,
  });
}

/** Open position: entry1 (older, smaller price) + entry2 (newer), then a
 * FIFO (unselected) exit that fully consumes entry1. */
async function setupTwoLotFifoScenario() {
  const { cookie } = await registerAndGetCookie();
  const account = await createTestAccount(cookie);
  const pos = await createDraftPosition(cookie, account.id);

  const entry1 = await addFill(
    cookie,
    pos.id,
    makeFill({ type: 'entry', price: '100.00', quantity: '10', filledAt: '2025-01-10T10:00:00Z' }),
  );
  await openPos(cookie, pos.id);
  const entry2 = await addFill(
    cookie,
    pos.id,
    makeFill({ type: 'entry', price: '150.00', quantity: '10', filledAt: '2025-02-10T10:00:00Z' }),
  );
  const exit = await addFill(
    cookie,
    pos.id,
    makeFill({ type: 'exit', price: '160.00', quantity: '10', filledAt: '2025-03-10T10:00:00Z' }),
  );

  return { cookie, pos, entry1, entry2, exit };
}

describe('GET /api/positions/:id/lots', () => {
  it("returns each lot's entryFillId, filledAt, price, quantity and available with the FIFO exit's slice subtracted", async () => {
    const { cookie, pos, entry1, entry2 } = await setupTwoLotFifoScenario();

    const res = await authedRequest('GET', `/api/positions/${pos.id}/lots`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const row1 = body.lots.find((l: { entryFillId: string }) => l.entryFillId === entry1.id);
    const row2 = body.lots.find((l: { entryFillId: string }) => l.entryFillId === entry2.id);
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    expect(new Date(row1.filledAt).getTime()).toBe(new Date('2025-01-10T10:00:00Z').getTime());
    expect(Number(row1.price)).toBe(100);
    expect(Number(row1.quantity)).toBe(10);
    expect(Number(row1.available)).toBe(0);

    expect(new Date(row2.filledAt).getTime()).toBe(new Date('2025-02-10T10:00:00Z').getTime());
    expect(Number(row2.price)).toBe(150);
    expect(Number(row2.quantity)).toBe(10);
    expect(Number(row2.available)).toBe(10);
  });

  it("adds the named exit's own slices back to available when exitFillId is given", async () => {
    const { cookie, pos, entry1, entry2, exit } = await setupTwoLotFifoScenario();

    const res = await authedRequest(
      'GET',
      `/api/positions/${pos.id}/lots?exitFillId=${exit.id}`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const row1 = body.lots.find((l: { entryFillId: string }) => l.entryFillId === entry1.id);
    const row2 = body.lots.find((l: { entryFillId: string }) => l.entryFillId === entry2.id);

    expect(Number(row1.available)).toBe(10);
    expect(Number(row2.available)).toBe(10);
  });

  it('echoes fifo/other for a new user, then acb/CA after PATCH jurisdiction CA (AC 2.5)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);

    const before = await authedRequest('GET', `/api/positions/${pos.id}/lots`, cookie);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.method).toBe('fifo');
    expect(beforeBody.jurisdiction).toBe('other');

    const patchRes = await patchJurisdiction(cookie, 'CA');
    expect(patchRes.status).toBe(200);

    const after = await authedRequest('GET', `/api/positions/${pos.id}/lots`, cookie);
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.method).toBe('acb');
    expect(afterBody.jurisdiction).toBe('CA');
  });

  it('404s on an unknown position', async () => {
    const { cookie } = await registerAndGetCookie();
    const unknownId = crypto.randomUUID();

    const res = await authedRequest('GET', `/api/positions/${unknownId}/lots`, cookie);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('404s when the position belongs to another user', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const accountA = await createTestAccount(cookieA);
    const posA = await createDraftPosition(cookieA, accountA.id);

    const { cookie: cookieB } = await registerAndGetCookie();

    const res = await authedRequest('GET', `/api/positions/${posA.id}/lots`, cookieB);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('404s when exitFillId names a fill that is not an exit of the position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));

    const res = await authedRequest(
      'GET',
      `/api/positions/${pos.id}/lots?exitFillId=${entry.id}`,
      cookie,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // Regression guard, not a red case: `/api/positions/*` already 401s with no
  // session via the shared `authMiddleware` applied by every sibling router
  // mounted at that base (fillsRouter, positionImagesRouter) — true before
  // this route exists and must stay true once it is mounted beside them.
  it('401s with no session', async () => {
    const res = await app.request(`/api/positions/${crypto.randomUUID()}/lots`, {
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });
});
