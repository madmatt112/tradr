import { describe, it, expect, vi } from 'vitest';

import app from '@/app';

// The self-service routes (design C7) end to end through `app.request`, each
// test rolled back by the single-connection harness (test-setup.ts). Nothing
// optional is configured; Stripe is pinned unconfigured so a request with no
// live subscription deletes immediately (Req 1.1-1.4, the C5 none-live path).
//
// Every test registers its OWN user, so the POST limiter — keyed on userId, a
// per-process Map in tests — never carries a count across tests.
vi.mock('@/features/billing/stripe-client', () => ({
  getStripeClient: () => null,
}));

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `acct-del-route${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 400;
function uniqueIp() {
  return `10.7.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

const PASSWORD = 'password123';

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

function clearsSessionCookie(res: Response): boolean {
  return res.headers
    .getSetCookie()
    .some((h) => /^session=(;|$|\s)/.test(h) && /Max-Age=0/i.test(h));
}

async function registerAndGetCookie(): Promise<string> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email: uniqueEmail(), password: PASSWORD }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session');
  expect(cookie).toBeTruthy();
  return cookie!;
}

function deletionRequest(method: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { 'X-Forwarded-For': uniqueIp() };
  if (cookie) headers.Cookie = `session=${cookie}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request('/api/users/me/deletion', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('account-deletion self-service routes', () => {
  it('GET returns a null status by default', async () => {
    const cookie = await registerAndGetCookie();
    const res = await deletionRequest('GET', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scheduledFor: null, state: null });
  });

  it('POST with the wrong password is 403 INVALID_PASSWORD, never 401', async () => {
    const cookie = await registerAndGetCookie();
    const res = await deletionRequest('POST', cookie, { password: 'wrong-password' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('INVALID_PASSWORD');
  });

  it('POST rejects a missing, too-short and too-long password with 400', async () => {
    const cookie = await registerAndGetCookie();

    const missing = await deletionRequest('POST', cookie, {});
    expect(missing.status).toBe(400);

    const short = await deletionRequest('POST', cookie, { password: '1234567' });
    expect(short.status).toBe(400);

    const long = await deletionRequest('POST', cookie, { password: 'a'.repeat(73) });
    expect(long.status).toBe(400);
  });

  it('rate-limits the sixth POST in the window with 429', async () => {
    const cookie = await registerAndGetCookie();

    // Five wrong-password attempts each reach the handler (403) and consume one
    // bucket hit; the sixth is over the max of 5 and is blocked before it.
    for (let i = 0; i < 5; i++) {
      const res = await deletionRequest('POST', cookie, { password: 'wrong-password' });
      expect(res.status).toBe(403);
    }
    const sixth = await deletionRequest('POST', cookie, { password: 'wrong-password' });
    expect(sixth.status).toBe(429);
  });

  it('a successful POST clears the cookie and the old cookie then 401s on /api/auth/me', async () => {
    const cookie = await registerAndGetCookie();

    const res = await deletionRequest('POST', cookie, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'deleted' });
    expect(clearsSessionCookie(res)).toBe(true);

    const me = await app.request('/api/auth/me', {
      method: 'GET',
      headers: { Cookie: `session=${cookie}` },
    });
    expect(me.status).toBe(401);
  });

  it('DELETE with nothing scheduled is 404 NO_DELETION_SCHEDULED', async () => {
    const cookie = await registerAndGetCookie();
    const res = await deletionRequest('DELETE', cookie);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NO_DELETION_SCHEDULED');
  });

  it('every route is 401 without a session', async () => {
    expect((await deletionRequest('GET')).status).toBe(401);
    expect((await deletionRequest('POST', undefined, { password: PASSWORD })).status).toBe(401);
    expect((await deletionRequest('DELETE')).status).toBe(401);
  });
});
