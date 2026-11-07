/**
 * ibkr.route.ts — the connection save/read/remove routes mounted at
 * /api/ibkr (design C2; Req 1.1-1.8, 5.7, 6.5, NFR Security). Drives real
 * HTTP through Hono `app.request` against real Postgres (test-setup.ts's
 * per-test rolled-back transaction), mirroring the register → cookie →
 * account harness at csv-import.preview.test.ts:19-65 and options.test.ts's
 * authedRequest/unauthedRequest helpers.
 *
 * No route exists yet at `/api/ibkr`, so every call below 404s today
 * (Red-first).
 *
 * Contract (one bullet per success criterion):
 *
 * - Req 1.1: a save encrypts both values and stores only ciphertext, the
 *   key version and the token's last four characters.
 *   Pre-condition: a fresh authed user who owns an account, no connection
 *   yet.
 *   Test: `PUT /api/ibkr/connections/:accountId` with a token and queryId.
 *   Observable result: 200; the stored row's `encryptedToken` and
 *   `encryptedQueryId` decrypt back to the sent values but never literally
 *   contain them, `keyVersion` is `ENCRYPTION_KEY_VERSION_CURRENT`, and
 *   `tokenHintTail` is the token's last four characters.
 *   Source: requirements.md Req 1 AC 1.
 *
 * - Req 1.2: a read returns only the masked status.
 *   Pre-condition: the user has just saved a connection for one account.
 *   Test: `GET /api/ibkr/connections`.
 *   Observable result: 200 with one entry whose keys are exactly
 *   `accountId`, `tokenHintTail`, `lastFetchedAt`, `lastPeriodStart` and
 *   `lastPeriodEnd`; the serialized response contains neither the
 *   plaintext token nor the query id.
 *   Source: requirements.md Req 1 AC 2.
 *
 * - Req 1.3: an unowned account refuses the save.
 *   Pre-condition: (a) an accountId naming no row, or (b) an account owned
 *   by a different user.
 *   Test: `PUT /api/ibkr/connections/:accountId` for each case.
 *   Observable result: 404 and no row is stored for that accountId.
 *   Source: requirements.md Req 1 AC 3.
 *
 * - Req 1.4: a second save replaces the first and a second account is
 *   independent.
 *   Pre-condition: one account already holds a connection with a recorded
 *   fetch.
 *   Test: a second `PUT` for the same account, then a first `PUT` for a
 *   second account.
 *   Observable result: the first account's row now decrypts to the new
 *   values with its last-fetch columns null; the second account holds its
 *   own independent row.
 *   Source: requirements.md Req 1 AC 4.
 *
 * - Req 1.5: removal hard-deletes.
 *   Pre-condition: a connection exists for an account.
 *   Test: `DELETE /api/ibkr/connections/:accountId`.
 *   Observable result: 204 and no row remains for that accountId; a
 *   second DELETE (or one with nothing to delete) answers 404.
 *   Source: requirements.md Req 1 AC 5.
 *
 * - Req 1.6: a blank value refuses the save.
 *   Pre-condition: an owned account, no connection yet.
 *   Test: `PUT` with a whitespace-only token, then with a whitespace-only
 *   queryId.
 *   Observable result: 400 each time and no row is stored.
 *   Source: requirements.md Req 1 AC 6.
 *
 * - Req 1.7: a save calls no IBKR endpoint.
 *   Pre-condition: a spy on `globalThis.fetch`.
 *   Test: `PUT /api/ibkr/connections/:accountId`.
 *   Observable result: the spy is never called.
 *   Source: requirements.md Req 1 AC 7.
 *
 * - Req 1.8: an 11th save inside an hour is refused.
 *   Pre-condition: a fresh user, one owned account.
 *   Test: ten sequential `PUT`s, then an 11th.
 *   Observable result: the first ten are 200; the 11th is 429 with
 *   `error.code === 'RATE_LIMITED'` and a numeric `Retry-After` header —
 *   the shape every other limiter in this codebase produces.
 *   Source: requirements.md Req 1 AC 8; design C2's limiter config.
 *
 * - Req 5.7: a user cannot read or change another user's connection.
 *   Pre-condition: the owner has saved a connection; a second user is
 *   also authed.
 *   Test: the second user's `GET /api/ibkr/connections`, and the second
 *   user's `DELETE` on the owner's accountId.
 *   Observable result: the GET excludes the owner's entry; the DELETE
 *   404s and the owner's row is untouched. (The PUT branch of this
 *   requirement is the same observable as Req 1.3's case (b) above.)
 *   Source: requirements.md Req 5 AC 7.
 *
 * - Req 6.5: the routes work with the advisor disabled.
 *   Pre-condition: `config.DISABLE_ADVISOR = true` (the workspace test env
 *   otherwise pins it `false`).
 *   Test: `PUT` then `GET` for a fresh user's account.
 *   Observable result: both still 200 — the ibkr slice does not sit
 *   behind the advisor gate.
 *   Source: requirements.md Req 6 AC 5.
 *
 * - NFR Security: every route sits behind authMiddleware.
 *   Pre-condition: no session cookie.
 *   Test: `GET`, `PUT` and `DELETE` on the connections base with no
 *   `Cookie` header.
 *   Observable result: all three answer 401.
 *   Source: requirements.md Non-Functional Requirements → Security
 *   ("Connection routes SHALL sit behind authMiddleware").
 *   RED-IMPOSSIBLE today: an unrelated bare-`/api`-mounted router
 *   (`calculatorPreferencesRouter.use(authMiddleware)`, no path filter —
 *   `apps/api/src/features/calculator/calculator.route.ts:141`) already
 *   answers 401 for ANY unauthenticated request to ANY unmatched `/api/*`
 *   path, including this one, before task 3 exists. The JSON body is
 *   byte-identical to a real authMiddleware 401 (same `UnauthorizedError`
 *   class), so no HTTP-observable rewrite can make this red. It is kept
 *   as a regression guard: once C2's router-level authMiddleware exists,
 *   removing it would route an unauthenticated request straight to the
 *   handler (crashing on an unset `userId` rather than 401), which this
 *   test would catch.
 *
 * The task-11 cases below drive `POST /api/csv-import/flex-fetch` (design
 * C6) — no route exists at that path yet (Red-first). Every outbound IBKR
 * call is a stub on `globalThis.fetch`, since the route passes no `deps` to
 * `fetchAndPreview`.
 *
 * - Req 4.4: a third fetch inside a minute is refused before any IBKR call.
 *   Pre-condition: a connection saved for an owned account.
 *   Test: three sequential `POST /api/csv-import/flex-fetch` with the same
 *   `accountId`.
 *   Observable result: the first two answer 200; the third answers 429 and
 *   the `fetch` spy's call count is unchanged from after the second.
 *   Source: requirements.md Req 4 AC 4; design C6's limiter (max 2 / 60s).
 *
 * - NFR Security: the flex-fetch route sits behind authMiddleware.
 *   Pre-condition: no session cookie.
 *   Test: `POST /api/csv-import/flex-fetch` with a random `accountId`
 *   through the full app, and again with `flexFetchRouter` mounted alone
 *   (no sibling router in the request path).
 *   Observable result: 401, both times.
 *   Source: requirements.md Non-Functional Requirements → Security.
 *   RED-IMPOSSIBLE today, same cause as Req 1/5.7's note above: the bare
 *   `/api`-mounted `calculatorPreferencesRouter.use(authMiddleware)` 401s
 *   ANY unauthenticated request to ANY unmatched `/api/*` path, so
 *   `POST /api/csv-import/flex-fetch` 401s before the route exists, with a
 *   byte-identical body. Kept as a regression guard, but NOT the guard for
 *   C6's own authMiddleware: `csvImport.use(authMiddleware)`
 *   (csv-import.route.ts) is mounted on the same `/api/csv-import` base
 *   ahead of `flexFetchRouter`, so it 401s this path byte-identically even
 *   with `flexFetchRouter.use(authMiddleware)` removed (task-11 review,
 *   reviewId 6b6921a7). The isolated case drives the exported
 *   `flexFetchRouter` with no sibling router in the mix, so only its own
 *   middleware can produce the 401 — proven to fail (500) when that line is
 *   removed.
 *
 * - Req 6.5: the fetch works with the advisor disabled.
 *   Pre-condition: `config.DISABLE_ADVISOR = true`; a connection saved for
 *   an owned account.
 *   Test: `POST /api/csv-import/flex-fetch` with that `accountId`.
 *   Observable result: 200 with a string `token` in the body.
 *   Source: requirements.md Req 6 AC 5.
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { ibkrFlexConnections } from '@/db/schema';
import { config } from '@/lib/config';
import {
  decrypt,
  ENCRYPTION_KEY_VERSION_CURRENT,
  loadEncryptionKeyMaterial,
} from '@/lib/encryption';
import { errorHandler } from '@/middleware/error.middleware';

import { recordFetch } from './ibkr.query';
import { flexFetchRouter } from './ibkr.route';

// The route drives encrypt()/decrypt() outside bootstrap() — same precedent as
// auth.test.ts:136-140 and the advisor suites.
beforeAll(() => {
  loadEncryptionKeyMaterial();
});

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `ibkr-route-${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.90.0.${++ipCounter}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
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
  const cookie = getCookieValue(res, 'session');
  expect(cookie).toBeDefined();
  return { cookie: cookie! };
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

function unauthedRequest(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'X-Forwarded-For': uniqueIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createAccount(cookie: string): Promise<string> {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: `Acct-${randomUUID()}`,
    currency: 'USD',
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id as string;
}

async function connectionRow(accountId: string) {
  const [row] = await db
    .select()
    .from(ibkrFlexConnections)
    .where(eq(ibkrFlexConnections.accountId, accountId));
  return row;
}

describe('PUT /api/ibkr/connections/:accountId — save (Req 1.1)', () => {
  it('stores only ciphertext, the key version and the last four characters', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = 'super-secret-token-value';
    const queryId = 'query-123';

    const res = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token,
      queryId,
    });
    expect(res.status).toBe(200);

    const row = await connectionRow(accountId);
    expect(row).toBeDefined();
    expect(row!.keyVersion).toBe(ENCRYPTION_KEY_VERSION_CURRENT);
    expect(row!.tokenHintTail).toBe(token.slice(-4));
    expect(row!.encryptedToken).not.toContain(token);
    expect(row!.encryptedQueryId).not.toContain(queryId);
    expect(decrypt(row!.encryptedToken)).toBe(token);
    expect(decrypt(row!.encryptedQueryId)).toBe(queryId);
  });
});

describe('GET /api/ibkr/connections — masked read (Req 1.2)', () => {
  it('returns only accountId, tokenHintTail and the last-fetch fields, never plaintext', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = 'another-secret-token';
    const queryId = 'q-456';
    const putRes = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token,
      queryId,
    });
    expect(putRes.status).toBe(200);

    const res = await authedRequest('GET', '/api/ibkr/connections', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    const entry = body[0];
    expect(Object.keys(entry).sort()).toEqual(
      ['accountId', 'lastFetchedAt', 'lastPeriodEnd', 'lastPeriodStart', 'tokenHintTail'].sort(),
    );
    expect(entry.accountId).toBe(accountId);
    expect(entry.tokenHintTail).toBe(token.slice(-4));
    expect(entry.lastFetchedAt).toBeNull();
    expect(entry.lastPeriodStart).toBeNull();
    expect(entry.lastPeriodEnd).toBeNull();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(queryId);
  });
});

describe('PUT /api/ibkr/connections/:accountId — unowned account (Req 1.3)', () => {
  it('404s and stores nothing for an unknown accountId', async () => {
    const { cookie } = await registerAndGetCookie();
    const unknownAccountId = randomUUID();

    const res = await authedRequest('PUT', `/api/ibkr/connections/${unknownAccountId}`, cookie, {
      token: 'some-valid-token-1',
      queryId: 'q-1',
    });
    expect(res.status).toBe(404);
    // Distinguishes the route's own NotFoundError (JSON `{error:{code:'NOT_FOUND'}}`)
    // from Hono's unmatched-route fallback (plain-text "404 Not Found"), which would
    // otherwise make this assertion pass before the route exists.
    expect((await res.json()).error.code).toBe('NOT_FOUND');

    const row = await connectionRow(unknownAccountId);
    expect(row).toBeUndefined();
  });

  it("404s and stores nothing for another user's account", async () => {
    const { cookie: ownerCookie } = await registerAndGetCookie();
    const accountId = await createAccount(ownerCookie);
    const { cookie: attackerCookie } = await registerAndGetCookie();

    const res = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, attackerCookie, {
      token: 'some-valid-token-2',
      queryId: 'q-2',
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');

    const row = await connectionRow(accountId);
    expect(row).toBeUndefined();
  });
});

describe('PUT /api/ibkr/connections/:accountId — replace (Req 1.4)', () => {
  it('replaces the stored values and clears the last-fetch record; a second account stays independent', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountOne = await createAccount(cookie);
    const accountTwo = await createAccount(cookie);

    const firstRes = await authedRequest('PUT', `/api/ibkr/connections/${accountOne}`, cookie, {
      token: 'first-token-value',
      queryId: 'first-query',
    });
    expect(firstRes.status).toBe(200);

    const firstRow = await connectionRow(accountOne);
    await recordFetch(db, firstRow!.id, {
      fetchedAt: new Date('2026-01-01T00:00:00.000Z'),
      periodStart: '2025-12-01',
      periodEnd: '2025-12-31',
    });

    const secondToken = 'second-token-value';
    const secondQueryId = 'second-query';
    const secondRes = await authedRequest('PUT', `/api/ibkr/connections/${accountOne}`, cookie, {
      token: secondToken,
      queryId: secondQueryId,
    });
    expect(secondRes.status).toBe(200);

    const replaced = await connectionRow(accountOne);
    expect(decrypt(replaced!.encryptedToken)).toBe(secondToken);
    expect(decrypt(replaced!.encryptedQueryId)).toBe(secondQueryId);
    expect(replaced!.lastFetchedAt).toBeNull();
    expect(replaced!.lastPeriodStart).toBeNull();
    expect(replaced!.lastPeriodEnd).toBeNull();

    const thirdRes = await authedRequest('PUT', `/api/ibkr/connections/${accountTwo}`, cookie, {
      token: 'third-token-value',
      queryId: 'third-query',
    });
    expect(thirdRes.status).toBe(200);

    const secondAccountRow = await connectionRow(accountTwo);
    expect(decrypt(secondAccountRow!.encryptedToken)).toBe('third-token-value');
  });
});

describe('DELETE /api/ibkr/connections/:accountId — remove (Req 1.5)', () => {
  it('hard-deletes an existing connection, returning 204', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: 'to-be-deleted-token',
      queryId: 'to-delete',
    });

    const res = await authedRequest('DELETE', `/api/ibkr/connections/${accountId}`, cookie);
    expect(res.status).toBe(204);

    const row = await connectionRow(accountId);
    expect(row).toBeUndefined();
  });

  it('404s when no connection exists for the account', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    const res = await authedRequest('DELETE', `/api/ibkr/connections/${accountId}`, cookie);
    expect(res.status).toBe(404);
    // Same NotFoundError-vs-unmatched-route distinction as Req 1.3 above.
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});

describe('PUT /api/ibkr/connections/:accountId — validation (Req 1.6)', () => {
  it('400s and stores nothing when the token is blank', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    const res = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: '   ',
      queryId: 'valid-query',
    });
    expect(res.status).toBe(400);

    const row = await connectionRow(accountId);
    expect(row).toBeUndefined();
  });

  it('400s and stores nothing when the queryId is blank', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    const res = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: 'valid-token-value',
      queryId: '   ',
    });
    expect(res.status).toBe(400);

    const row = await connectionRow(accountId);
    expect(row).toBeUndefined();
  });
});

describe('PUT /api/ibkr/connections/:accountId — no outbound call (Req 1.7)', () => {
  it('makes no call to IBKR when saving', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const { cookie } = await registerAndGetCookie();
      const accountId = await createAccount(cookie);

      const res = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
        token: 'no-outbound-token',
        queryId: 'no-outbound-query',
      });
      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('PUT /api/ibkr/connections/:accountId — save rate limit (Req 1.8)', () => {
  it('answers 429 on the 11th save within an hour', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    for (let i = 0; i < 10; i++) {
      const res = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
        token: `rate-limit-token-${i}`,
        queryId: `rate-limit-query-${i}`,
      });
      expect(res.status).toBe(200);
    }

    const blocked = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: 'rate-limit-token-11th',
      queryId: 'rate-limit-query-11th',
    });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
  }, 20000);
});

describe('cross-user isolation (Req 5.7)', () => {
  it("excludes another user's connection from GET /api/ibkr/connections", async () => {
    const { cookie: ownerCookie } = await registerAndGetCookie();
    const ownerAccountId = await createAccount(ownerCookie);
    await authedRequest('PUT', `/api/ibkr/connections/${ownerAccountId}`, ownerCookie, {
      token: 'owner-token-value',
      queryId: 'owner-query',
    });

    const { cookie: otherCookie } = await registerAndGetCookie();
    const res = await authedRequest('GET', '/api/ibkr/connections', otherCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404s a DELETE by a non-owner and leaves the owner's connection intact", async () => {
    const { cookie: ownerCookie } = await registerAndGetCookie();
    const ownerAccountId = await createAccount(ownerCookie);
    await authedRequest('PUT', `/api/ibkr/connections/${ownerAccountId}`, ownerCookie, {
      token: 'owner-token-value-2',
      queryId: 'owner-query-2',
    });

    const { cookie: attackerCookie } = await registerAndGetCookie();
    const res = await authedRequest(
      'DELETE',
      `/api/ibkr/connections/${ownerAccountId}`,
      attackerCookie,
    );
    expect(res.status).toBe(404);

    const row = await connectionRow(ownerAccountId);
    expect(row).toBeDefined();
  });
});

describe('routes work regardless of DISABLE_ADVISOR (Req 6.5)', () => {
  afterEach(() => {
    config.DISABLE_ADVISOR = false;
  });

  it('still saves and reads a connection with the advisor disabled', async () => {
    config.DISABLE_ADVISOR = true;
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    const putRes = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: 'disable-advisor-token',
      queryId: 'disable-advisor-query',
    });
    expect(putRes.status).toBe(200);

    const getRes = await authedRequest('GET', '/api/ibkr/connections', cookie);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toHaveLength(1);
  });
});

describe('authMiddleware gates every route (NFR Security)', () => {
  it('401s GET, PUT and DELETE with no session', async () => {
    const randomAccountId = randomUUID();

    const getRes = await unauthedRequest('GET', '/api/ibkr/connections');
    expect(getRes.status).toBe(401);

    const putRes = await unauthedRequest('PUT', `/api/ibkr/connections/${randomAccountId}`, {
      token: 'unauthed-token-value',
      queryId: 'unauthed-query',
    });
    expect(putRes.status).toBe(401);

    const deleteRes = await unauthedRequest('DELETE', `/api/ibkr/connections/${randomAccountId}`);
    expect(deleteRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/csv-import/flex-fetch (task 11, design C6). Stubs globalThis.fetch
// — the route calls fetchAndPreview with no `deps`, so the only outbound-call
// seam reachable from HTTP is the global one (flex.client.test.ts and
// ibkr.service.test.ts exercise fetchFlexReport/fetchAndPreview's own `deps`
// seam instead).
// ---------------------------------------------------------------------------

function flexFetchStreamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function flexFetchHttpResponse(bytes: Uint8Array): Response {
  return { ok: true, status: 200, body: flexFetchStreamOf(bytes) } as unknown as Response;
}

function flexFetchEnvelope(referenceCode: string): Response {
  return flexFetchHttpResponse(
    new TextEncoder().encode(
      `<FlexStatementResponse timestamp="now"><Status>Success</Status><ReferenceCode>${referenceCode}</ReferenceCode></FlexStatementResponse>`,
    ),
  );
}

function flexFetchReportCsv(): string {
  return [
    'ClientAccountID,Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,IBCommission,Multiplier,DateTime,Notes/Codes',
    'U1234567,AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
    'U1234567,AAPL,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",',
  ].join('\n');
}

function stubGlobalFlexFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
    const href = String(url);
    if (href.includes('SendRequest')) return flexFetchEnvelope('REF-ROUTE');
    return flexFetchHttpResponse(new TextEncoder().encode(flexFetchReportCsv()));
  });
}

describe('POST /api/csv-import/flex-fetch — no session (NFR Security)', () => {
  it('answers 401 with no session', async () => {
    const res = await unauthedRequest('POST', '/api/csv-import/flex-fetch', {
      accountId: randomUUID(),
    });
    expect(res.status).toBe(401);
  });

  // The assertion above also 401s from the sibling csv-import router's own
  // blanket `.use(authMiddleware)` (csv-import.route.ts), which is mounted on
  // the same `/api/csv-import` base ahead of `flexFetchRouter` in app.ts — it
  // would still 401 byte-identically even if `flexFetchRouter.use(authMiddleware)`
  // were removed, so it cannot catch that regression (task-11 review,
  // reviewId 6b6921a7). This drives the exported `flexFetchRouter` alone, with
  // no sibling router in the mix, so only its own middleware can produce 401.
  it('401s with no session when the router is driven in isolation', async () => {
    const isolated = new Hono();
    isolated.onError(errorHandler);
    isolated.route('/', flexFetchRouter);

    const res = await isolated.request('/flex-fetch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ accountId: randomUUID() }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/csv-import/flex-fetch — per-user rate limit (Req 4.4)', () => {
  it('answers 429 on the third fetch within a minute, with no outbound call', async () => {
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: 'rate-limit-fetch-token',
      queryId: 'rate-limit-fetch-query',
    });

    const fetchSpy = stubGlobalFlexFetch();
    try {
      const first = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, {
        accountId,
      });
      expect(first.status).toBe(200);
      const second = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, {
        accountId,
      });
      expect(second.status).toBe(200);
      const callsAfterTwo = fetchSpy.mock.calls.length;

      const third = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, {
        accountId,
      });
      expect(third.status).toBe(429);
      expect(fetchSpy.mock.calls.length).toBe(callsAfterTwo);
    } finally {
      fetchSpy.mockRestore();
    }
  }, 20000);
});

describe('POST /api/csv-import/flex-fetch — works regardless of DISABLE_ADVISOR (Req 6.5)', () => {
  afterEach(() => {
    config.DISABLE_ADVISOR = false;
  });

  it('still returns a preview token with the advisor disabled', async () => {
    config.DISABLE_ADVISOR = true;
    const { cookie } = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: 'disable-advisor-fetch-token',
      queryId: 'disable-advisor-fetch-query',
    });

    const fetchSpy = stubGlobalFlexFetch();
    try {
      const res = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, { accountId });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.token).toBe('string');
    } finally {
      fetchSpy.mockRestore();
    }
  }, 15000);
});
