/**
 * ibkr.secrets.test.ts — the sentinel test design's Testing Strategy names
 * for Req 5.1 ("a test with sentinel values SHALL assert their absence from
 * captured `logger` output, `captureServerEvent` payloads ... and response
 * bodies"). Regression guard (tasks.md task 12): tasks 3, 9 and 11 already
 * ship this behaviour — `ibkr.service.ts`/`ibkr.route.ts` never put the token
 * or query id in a response, `flex.client.ts` replaces every outbound
 * failure with one of Tradr's own coded `AppError`s (never the caught error,
 * IBKR's body or a URL), and `error.middleware.ts` only ever logs/returns
 * `err.code`/`err.message` for an `AppError`. Every case below is expected to
 * pass today; none is red-first.
 *
 * Two calling forms, per the task's Test line:
 *  - `app.request` on every `/api/ibkr/*` route and on
 *    `POST /api/csv-import/flex-fetch`, collecting the real HTTP response
 *    body.
 *  - `fetchAndPreview(db, userId, accountId, deps)` driven directly for the
 *    Error Handling rows HTTP rate limiting would make slow to reach two at
 *    a time. There is no HTTP response for this form; the rejected
 *    `AppError`'s own `{ code, message }` is exactly what `error.middleware`
 *    turns into the response body (verified by reading that file), so
 *    asserting on the rejected error is the equivalent check.
 *
 * Every logger call is captured by spying on the four `logger` methods
 * directly (the module the whole API shares), and every `captureServerEvent`
 * call by spying on the `posthog` module export — the same two seams
 * `csv-import.commit.test.ts` and `unusual-whales.client.test.ts` already
 * use for this exact kind of secret-hygiene assertion.
 *
 * Both sentinel values are picked to dodge `telemetry-redact.ts`'s own
 * `VALUE_PATTERNS` (no `sk-`/`sk_`/`phc_`/`Bearer `/JWT/email/filename
 * shape) — the Restriction "neither scrubString nor logger redacts, so the
 * code must never emit the value" only holds if a scrub could not
 * coincidentally save a leak from being caught here.
 *
 * Contract (one row per success criterion):
 *
 * | # | Pre-condition | Test (call) | Observable result | Source |
 * |---|---|---|---|---|
 * | C1 | fresh user + account, sentinel token/queryId | PUT save, GET read, POST flex-fetch (stubbed success), POST commit, DELETE remove — `app.request` on each | every response body, every captured `logger` call and every `captureServerEvent` payload across the whole walk omit both sentinels | Req 5.1 |
 * | C1b-h | the same connection; `fetchAndPreview(db, userId, accountId, deps)` driven through token-rejected, query-rejected, rate-limited, not-ready (budget exhaustion), XML format-unsupported, undecryptable-connection, no-trades and account-unproven | direct call | the rejected `AppError`, every captured `logger` call and every `captureServerEvent` payload omit both sentinels, for each Error Handling row a stub can trigger | Req 5.1 |
 * | C2 | connection saved with a sentinel token; the global `fetch` stub throws an `Error` whose message embeds that sentinel | `POST /api/csv-import/flex-fetch` | 503 `IBKR_FLEX_UNAVAILABLE`; the response body, captured `logger` calls and `captureServerEvent` calls omit the sentinel | Req 5.2 |
 * | C3 | connection saved with a sentinel token; the stubbed SendRequest envelope carries a terminal error code and an unparsed free-text tag holding the sentinel | `POST /api/csv-import/flex-fetch` | 400 `IBKR_FLEX_TOKEN_REJECTED` with Tradr's fixed text; the response body omits the sentinel | Req 4.3 |
 * | C4 | connection saved with a sentinel token; the stubbed report carries an extra column the `interactive-brokers` preset does not map, holding a distinct sentinel in every data row | `POST /api/csv-import/flex-fetch` | 200 preview; the response body, every captured `logger` call and the staged `csv_import_staging.result` row all omit that sentinel | Req 5.4 |
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { accounts, ibkrFlexConnections, users } from '@/db/schema';
import { csvImportStaging } from '@/db/schema/csv-import.schema';
import { loadEncryptionKeyMaterial } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import * as posthog from '@/lib/posthog';

import { fetchAndPreview, saveConnection } from './ibkr.service';

beforeAll(() => {
  loadEncryptionKeyMaterial();
});

// --- shared capture rig ---------------------------------------------------

type LogCall = { level: string; message: string; extra?: Record<string, unknown> };

let logCalls: LogCall[];
let logSpies: ReturnType<typeof vi.spyOn>[];
let captureSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logCalls = [];
  logSpies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi
      .spyOn(logger, level)
      .mockImplementation((message: string, extra?: Record<string, unknown>) => {
        logCalls.push({ level, message, extra });
      }),
  );
  captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});
});

afterEach(() => {
  for (const spy of logSpies) spy.mockRestore();
  captureSpy.mockRestore();
});

/** Every string a sentinel could hide in, across both capture seams. */
function capturedSurfaces(): string[] {
  return [
    ...logCalls.map((c) => JSON.stringify(c)),
    ...captureSpy.mock.calls.map((c) => JSON.stringify(c)),
  ];
}

function assertNoSentinel(surfaces: string[], sentinel: string, where: string) {
  for (const surface of surfaces) {
    expect(surface, `${where} must not contain the sentinel`).not.toContain(sentinel);
  }
}

// --- HTTP harness (ibkr.route.test.ts precedent) --------------------------

let ipCounter = 0;
function uniqueIp() {
  return `10.91.0.${++ipCounter}`;
}

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `ibkr-secrets-${testRunId}-${++testCounter}@example.com`;
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
    body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session');
  expect(cookie).toBeDefined();
  return cookie!;
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

async function createAccount(cookie: string): Promise<string> {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: `Secrets-${randomUUID()}`,
    currency: 'USD',
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id as string;
}

async function registeredAccount(): Promise<{ cookie: string; accountId: string }> {
  const cookie = await registerAndGetCookie();
  const accountId = await createAccount(cookie);
  return { cookie, accountId };
}

// --- service-level harness (ibkr.service.test.ts precedent) ---------------

async function seedAccount(): Promise<{ userId: string; accountId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Secrets Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function connectionRow(accountId: string) {
  const [row] = await db
    .select()
    .from(ibkrFlexConnections)
    .where(eq(ibkrFlexConnections.accountId, accountId));
  return row;
}

const ENCODER = new TextEncoder();
function bytesOf(text: string): Uint8Array {
  return ENCODER.encode(text);
}
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
function httpResponse(bytes: Uint8Array): Response {
  return { ok: true, status: 200, body: streamOf(bytes) } as unknown as Response;
}
function envelopeResponse(opts: {
  referenceCode?: string;
  errorCode?: number;
  extra?: string;
}): Response {
  const parts = ['<FlexStatementResponse timestamp="now">'];
  parts.push(`<Status>${opts.referenceCode ? 'Success' : 'Fail'}</Status>`);
  if (opts.referenceCode) parts.push(`<ReferenceCode>${opts.referenceCode}</ReferenceCode>`);
  if (opts.errorCode !== undefined) parts.push(`<ErrorCode>${opts.errorCode}</ErrorCode>`);
  if (opts.extra) parts.push(opts.extra);
  parts.push('</FlexStatementResponse>');
  return httpResponse(bytesOf(parts.join('')));
}
function reportResponse(content: string): Response {
  return httpResponse(bytesOf(content));
}
function fetchImplOf(...responses: Response[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const res of responses) mock.mockResolvedValueOnce(res);
  return mock;
}
function instantClock() {
  return { sleep: vi.fn(async () => {}), now: () => 0 };
}
function flexCsv(rows: string[]): string {
  return [
    'ClientAccountID,Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,IBCommission,Multiplier,DateTime,Notes/Codes',
    ...rows,
  ].join('\n');
}
const HAPPY_ROWS = [
  'U1234567,AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
  'U1234567,AAPL,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",',
];

// ---------------------------------------------------------------------------
// C1 — the full HTTP walk (Req 5.1)
// ---------------------------------------------------------------------------

describe('the full connection lifecycle over HTTP never leaks the sentinel values (C1, Req 5.1)', () => {
  it('save, read, fetch, commit and remove all omit the sentinel token and query id', async () => {
    const { cookie, accountId } = await registeredAccount();
    const sentinelToken = `SENTINEL-TOKEN-${randomUUID()}`;
    const sentinelQuery = `SENTINEL-QUERY-${randomUUID()}`;
    const responseBodies: string[] = [];

    const putRes = await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: sentinelToken,
      queryId: sentinelQuery,
    });
    expect(putRes.status).toBe(200);
    responseBodies.push(JSON.stringify(await putRes.json()));

    const getRes = await authedRequest('GET', '/api/ibkr/connections', cookie);
    expect(getRes.status).toBe(200);
    responseBodies.push(JSON.stringify(await getRes.json()));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes('SendRequest')) return envelopeResponse({ referenceCode: 'REF-C1' });
      return reportResponse(flexCsv(HAPPY_ROWS));
    });
    let previewToken: string;
    try {
      const fetchRes = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, {
        accountId,
      });
      expect(fetchRes.status).toBe(200);
      const body = await fetchRes.json();
      responseBodies.push(JSON.stringify(body));
      previewToken = body.token;

      // The outbound call itself carries the credentials in the URL — that is
      // the wire contract, not a leak surface this test covers (flex.client.test.ts
      // covers the URL shape). Confirm the stub was actually exercised.
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }

    const commitRes = await authedRequest('POST', '/api/csv-import/commit', cookie, {
      token: previewToken,
    });
    expect(commitRes.status).toBe(200);
    responseBodies.push(JSON.stringify(await commitRes.json()));

    const deleteRes = await authedRequest('DELETE', `/api/ibkr/connections/${accountId}`, cookie);
    expect(deleteRes.status).toBe(204);

    for (const body of responseBodies) {
      expect(body).not.toContain(sentinelToken);
      expect(body).not.toContain(sentinelQuery);
    }
    assertNoSentinel(capturedSurfaces(), sentinelToken, 'logger/captureServerEvent calls');
    assertNoSentinel(capturedSurfaces(), sentinelQuery, 'logger/captureServerEvent calls');
  });
});

// ---------------------------------------------------------------------------
// C1b-h — the remaining Error Handling rows a stub can trigger, driven
// directly through fetchAndPreview's `deps` seam (Req 5.1)
// ---------------------------------------------------------------------------

describe('fetchAndPreview error paths never leak the sentinel values (C1b-h, Req 5.1)', () => {
  async function connectedSentinelAccount() {
    const { userId, accountId } = await seedAccount();
    const sentinelToken = `SENTINEL-TOKEN-${randomUUID()}`;
    const sentinelQuery = `SENTINEL-QUERY-${randomUUID()}`;
    await saveConnection(db, userId, accountId, { token: sentinelToken, queryId: sentinelQuery });
    return { userId, accountId, sentinelToken, sentinelQuery };
  }

  function assertRejectionIsClean(
    rejection: unknown,
    sentinelToken: string,
    sentinelQuery: string,
  ) {
    const serialized = JSON.stringify({
      message: (rejection as Error).message,
      code: (rejection as { code?: string }).code,
    });
    expect(serialized).not.toContain(sentinelToken);
    expect(serialized).not.toContain(sentinelQuery);
    assertNoSentinel(capturedSurfaces(), sentinelToken, 'logger/captureServerEvent calls');
    assertNoSentinel(capturedSurfaces(), sentinelQuery, 'logger/captureServerEvent calls');
  }

  it('token rejected (errorCode 1011)', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    const fetchImpl = fetchImplOf(envelopeResponse({ errorCode: 1011 }));

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 400, code: 'IBKR_FLEX_TOKEN_REJECTED' });
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });

  it('query rejected (errorCode 1010)', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    const fetchImpl = fetchImplOf(envelopeResponse({ errorCode: 1010 }));

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 400, code: 'IBKR_FLEX_QUERY_REJECTED' });
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });

  it('rate limited (errorCode 1018)', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    const fetchImpl = fetchImplOf(envelopeResponse({ errorCode: 1018 }));

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 429, code: 'IBKR_FLEX_RATE_LIMITED' });
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });

  it('not ready (budget exhausted while polling)', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const now = () => clock;
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) return envelopeResponse({ referenceCode: 'REF-NR' });
      return envelopeResponse({ errorCode: 1001 });
    });

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now,
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 503, code: 'IBKR_FLEX_NOT_READY' });
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });

  it('XML format unsupported', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-XML' }),
      reportResponse('<FlexQueryResponse><Note>irrelevant</Note></FlexQueryResponse>'),
    );

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 422, code: 'IBKR_FLEX_FORMAT_UNSUPPORTED' });
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });

  it('undecryptable connection', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    // Corrupt the stored ciphertext in place so decryption fails, the way an
    // unsupported key-rotation or a bit-flip would in production — the
    // sentinel was genuinely encrypted at save time (saveConnection ran
    // `encrypt`), so this proves corruption can't turn into a leak either.
    const before = await connectionRow(accountId);
    await db
      .update(ibkrFlexConnections)
      .set({ encryptedToken: before!.encryptedToken.slice(0, -4) })
      .where(eq(ibkrFlexConnections.accountId, accountId));
    const fetchImpl = vi.fn(async () => {
      throw new Error('must not call IBKR on this path');
    });

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 409, code: 'IBKR_CONNECTION_UNREADABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });

  it('no trades (zero data rows)', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-NT' }),
      reportResponse(flexCsv([])),
    );

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 422, code: 'IBKR_FLEX_NO_TRADES' });
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });

  it('account unproven (two distinct account values)', async () => {
    const { userId, accountId, sentinelToken, sentinelQuery } = await connectedSentinelAccount();
    const csv = flexCsv([
      'U1111111,AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
      'U2222222,AAPL,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",',
    ]);
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-AU' }),
      reportResponse(csv),
    );

    const rejection = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    }).catch((err: unknown) => err);

    expect(rejection).toMatchObject({ statusCode: 422, code: 'IBKR_FLEX_ACCOUNT_UNPROVEN' });
    assertRejectionIsClean(rejection, sentinelToken, sentinelQuery);
  });
});

// ---------------------------------------------------------------------------
// C2 — a sentinel thrown inside a transport error (Req 5.2)
// ---------------------------------------------------------------------------

describe('a sentinel inside a caught transport error never reaches the response (C2, Req 5.2)', () => {
  it('answers 503 IBKR_FLEX_UNAVAILABLE with no trace of the sentinel', async () => {
    const { cookie, accountId } = await registeredAccount();
    const sentinelToken = `SENTINEL-TOKEN-${randomUUID()}`;
    const sentinelQuery = `SENTINEL-QUERY-${randomUUID()}`;
    await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: sentinelToken,
      queryId: sentinelQuery,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error(`connect ECONNREFUSED while sending token=${sentinelToken}`);
    });
    try {
      const res = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, { accountId });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe('IBKR_FLEX_UNAVAILABLE');
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(sentinelToken);
      assertNoSentinel(capturedSurfaces(), sentinelToken, 'logger/captureServerEvent calls');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// C3 — a sentinel in IBKR's own error text (Req 4.3)
// ---------------------------------------------------------------------------

describe("a sentinel in IBKR's error text never reaches the response (C3, Req 4.3)", () => {
  it("answers with Tradr's own fixed text, never the envelope free text", async () => {
    const { cookie, accountId } = await registeredAccount();
    const sentinelToken = `SENTINEL-TOKEN-${randomUUID()}`;
    await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: sentinelToken,
      queryId: `SENTINEL-QUERY-${randomUUID()}`,
    });
    const sentinelErrorText = `SENTINEL-IBKR-TEXT-${randomUUID()}`;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      envelopeResponse({
        errorCode: 1011, // token rejected — terminal, no GetStatement call
        extra: `<ErrorMessage>${sentinelErrorText}</ErrorMessage>`,
      }),
    );
    try {
      const res = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, { accountId });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('IBKR_FLEX_TOKEN_REJECTED');
      expect(body.error.message).toBe('IBKR rejected this token; replace it in Settings.');
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(sentinelErrorText);
      assertNoSentinel(capturedSurfaces(), sentinelErrorText, 'logger/captureServerEvent calls');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// C4 — a sentinel in a column the preset does not map (Req 5.4)
// ---------------------------------------------------------------------------

describe('a sentinel in an unmapped report column never reaches a log or a staged row (C4, Req 5.4)', () => {
  it('stages a clean preview with no trace of the sentinel column value', async () => {
    const { cookie, accountId } = await registeredAccount();
    await authedRequest('PUT', `/api/ibkr/connections/${accountId}`, cookie, {
      token: `SENTINEL-TOKEN-${randomUUID()}`,
      queryId: `SENTINEL-QUERY-${randomUUID()}`,
    });
    const sentinelColumnValue = `SENTINEL-COLUMN-${randomUUID()}`;
    const reportWithExtraColumn = [
      'ClientAccountID,Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,IBCommission,Multiplier,DateTime,Notes/Codes,ExecutionNote',
      `U1234567,AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",,${sentinelColumnValue}`,
      `U1234567,AAPL,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",,${sentinelColumnValue}`,
    ].join('\n');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const href = String(url);
      if (href.includes('SendRequest')) return envelopeResponse({ referenceCode: 'REF-C4' });
      return reportResponse(reportWithExtraColumn);
    });
    try {
      const res = await authedRequest('POST', '/api/csv-import/flex-fetch', cookie, { accountId });
      expect(res.status).toBe(200);
      const body = await res.json();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(sentinelColumnValue);
      assertNoSentinel(capturedSurfaces(), sentinelColumnValue, 'logger/captureServerEvent calls');

      const [staged] = await db
        .select()
        .from(csvImportStaging)
        .where(eq(csvImportStaging.id, body.token));
      expect(staged).toBeDefined();
      expect(JSON.stringify(staged!.result)).not.toContain(sentinelColumnValue);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// An isolated check that commit-time telemetry (the one captureServerEvent
// path a fetched preview can reach) carries no sentinel either — otherwise
// every test above would exercise captureServerEvent zero times and the
// spy's "no leak" assertion on it would be vacuous.
// ---------------------------------------------------------------------------

describe('captureServerEvent at commit time carries no sentinel (Req 5.1, non-vacuous check)', () => {
  it('a tier-limit refusal event carries only the lever name, never the sentinel', async () => {
    const { userId, accountId } = await seedAccount();
    const sentinelToken = `SENTINEL-TOKEN-${randomUUID()}`;
    const sentinelQuery = `SENTINEL-QUERY-${randomUUID()}`;
    await saveConnection(db, userId, accountId, { token: sentinelToken, queryId: sentinelQuery });

    const { getTierLimits } = await import('@/features/billing/tier-limits.constants');
    const { csvImportCounters } = await import('@/db/schema/csv-import.schema');
    const { commitImport } = await import('@/features/csv-import/csv-import.service');
    const { config } = await import('@/lib/config');

    const freeCap = getTierLimits('free').csvImports!;
    await db
      .insert(csvImportCounters)
      .values({ userId, committedCount: freeCap })
      .onConflictDoUpdate({
        target: csvImportCounters.userId,
        set: { committedCount: freeCap },
      });
    const prevGating = config.FEATURE_GATING;
    config.FEATURE_GATING = true;

    try {
      const preview = await fetchAndPreview(db, userId, accountId, {
        fetchImpl: fetchImplOf(
          envelopeResponse({ referenceCode: 'REF-TIER' }),
          reportResponse(flexCsv(HAPPY_ROWS)),
        ) as unknown as typeof fetch,
        ...instantClock(),
      });

      await expect(
        commitImport(db, userId, preview.token, false, { isAdmin: false }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'TIER_LIMIT_CSV_IMPORTS' });

      expect(captureSpy).toHaveBeenCalledWith(
        'tier_limit_hit',
        expect.objectContaining({ distinctId: userId }),
      );
      assertNoSentinel(capturedSurfaces(), sentinelToken, 'captureServerEvent payload');
      assertNoSentinel(capturedSurfaces(), sentinelQuery, 'captureServerEvent payload');
    } finally {
      config.FEATURE_GATING = prevGating;
    }
  });
});
