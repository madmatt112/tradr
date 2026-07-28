import crypto from 'node:crypto';

import bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { emailTokens, sessions, users } from '@/db/schema';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { initMailer } from '@/lib/mailer';

import { hashPassword } from './auth.service';
import * as emailTokensService from './email-tokens.service';

let testCounter = 0;
function uniqueEmail() {
  return `test${++testCounter}@example.com`;
}

// Each test gets a unique IP to avoid rate limiter interference
let ipCounter = 0;
function uniqueIp() {
  return `10.0.0.${++ipCounter}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerUser(email = uniqueEmail(), password = 'password123', ip = uniqueIp()) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({ email, password }),
  });
}

async function loginUser(email: string, password = 'password123', ip = uniqueIp()) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({ email, password }),
  });
}

// --- email config toggling (direct mutation + restore; isEmailConfigured()
// reads live — the password-reset.test.ts pattern) ---
const ORIGINAL = {
  SMTP_HOST: config.SMTP_HOST,
  EMAIL_FROM: config.EMAIL_FROM,
  WEB_BASE_URL: config.WEB_BASE_URL,
};

function configureEmail() {
  config.SMTP_HOST = 'smtp.test.local';
  config.EMAIL_FROM = 'noreply@test.local';
  config.WEB_BASE_URL = 'https://app.test.local';
}

function unconfigureEmail() {
  config.SMTP_HOST = ORIGINAL.SMTP_HOST;
  config.EMAIL_FROM = ORIGINAL.EMAIL_FROM;
  config.WEB_BASE_URL = ORIGINAL.WEB_BASE_URL;
}

afterEach(() => {
  unconfigureEmail();
  vi.restoreAllMocks();
});

// --- mailer stub seam (Task 5's transportOverride; call configureEmail()
// first — initMailer no-ops when unconfigured) ---
type SentMail = { to: string; text: string };

function stubTransport() {
  const sendMail = vi.fn().mockResolvedValue({});
  initMailer({ sendMail } as unknown as Transporter);
  return sendMail;
}

function hungTransport() {
  // Never settles — a hung SMTP server. An implementation that awaits the
  // send hangs on this and times the test out.
  const sendMail = vi.fn<(mail: unknown) => Promise<never>>(
    () => new Promise<never>(() => undefined),
  );
  initMailer({ sendMail } as unknown as Transporter);
  return sendMail;
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function verifyRowsFor(userId: string) {
  return db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'email_verification')));
}

function userByEmail(email: string) {
  return db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .then((rows) => rows[0]);
}

describe('auth', () => {
  // 1. Registration happy path
  it('registers a new user and returns session cookie', async () => {
    const email = uniqueEmail();
    const res = await registerUser(email);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.user).toHaveProperty('id');
    expect(body.user.email).toBe(email);
    expect(body.user.isAdmin).toBe(false);

    const sessionCookie = getCookieValue(res, 'session');
    expect(sessionCookie).toBeDefined();

    // Verify GET /me works with the session
    const meRes = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.email).toBe(email);
  });

  // 2. Registration duplicate email
  it('returns 409 for duplicate email', async () => {
    const email = uniqueEmail();
    const ip = uniqueIp();
    await registerUser(email, 'password123', ip);
    const res = await registerUser(email, 'password123', ip);
    expect(res.status).toBe(409);
  });

  // 3. Registration validation
  it('returns 400 for invalid email', async () => {
    const res = await registerUser('not-an-email', 'password123');
    expect(res.status).toBe(400);
  });

  it('returns 400 for short password', async () => {
    const res = await registerUser(uniqueEmail(), 'short');
    expect(res.status).toBe(400);
  });

  it('returns 400 for too long password', async () => {
    const res = await registerUser(uniqueEmail(), 'x'.repeat(73));
    expect(res.status).toBe(400);
  });

  // 4. Login happy path
  it('logs in with valid credentials', async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const res = await loginUser(email);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.user.email).toBe(email);

    const sessionCookie = getCookieValue(res, 'session');
    expect(sessionCookie).toBeDefined();
  });

  // 5. Login wrong password
  it('returns 401 for wrong password', async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const res = await loginUser(email, 'wrongpassword');
    expect(res.status).toBe(401);
  });

  // 6. Login nonexistent email
  it('returns 401 for nonexistent email', async () => {
    const res = await loginUser('nobody@example.com', 'password123');
    expect(res.status).toBe(401);
  });

  // 7. Logout
  it('logs out and invalidates session', async () => {
    const email = uniqueEmail();
    const registerRes = await registerUser(email);
    const sessionCookie = getCookieValue(registerRes, 'session');

    const logoutRes = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `session=${sessionCookie}` },
    });
    expect(logoutRes.status).toBe(200);

    // Session should be invalid now
    const meRes = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    expect(meRes.status).toBe(401);
  });

  // 8. Logout without session
  it('returns 200 for logout without session cookie', async () => {
    const res = await app.request('/api/auth/logout', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // 9. Session expiry
  it('returns 401 for expired session', async () => {
    const email = uniqueEmail();
    const registerRes = await registerUser(email);
    expect(registerRes.status).toBe(201);
    const sessionCookie = getCookieValue(registerRes, 'session')!;
    expect(sessionCookie).toBeDefined();

    // Backdate this user's session to simulate expiry
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const userSessions = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(userSessions.length).toBe(1);

    const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    await db
      .update(sessions)
      .set({
        createdAt: pastDate,
        lastAccessed: pastDate,
      })
      .where(eq(sessions.id, userSessions[0].id));

    const meRes = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    expect(meRes.status).toBe(401);
  });

  // 10. Session eviction
  it('evicts oldest session when exceeding limit', async () => {
    const email = uniqueEmail();
    const ip = uniqueIp();
    await registerUser(email, 'password123', ip);

    // Create 5 more sessions by logging in
    for (let i = 0; i < 5; i++) {
      await loginUser(email, 'password123', ip);
    }

    // 6th login should trigger eviction
    await loginUser(email, 'password123', ip);

    // Per-user eviction: this user should have at most 6 sessions (5 limit + brief exceed)
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const userSessions = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(userSessions.length).toBeLessThanOrEqual(6);
  });

  // 11. Health check
  it('health check returns 200', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  // 12. Rate limiting
  it('returns 429 after exceeding login rate limit', async () => {
    const email = uniqueEmail();
    const ip = uniqueIp();
    await registerUser(email, 'password123', ip);

    // Login rate limit is 10/15min — send 10 requests from same IP
    for (let i = 0; i < 10; i++) {
      await loginUser(email, 'password123', ip);
    }

    // 11th request should be rate limited
    const res = await loginUser(email, 'password123', ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
  });

  // 13. Request ID
  it('includes X-Request-Id header on responses', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('X-Request-Id')).toBeDefined();
    expect(res.headers.get('X-Request-Id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  // 14. Extracted hashPassword still backs registration (REQ-8)
  it('hashPassword produces a bcrypt hash that verifies and registration authenticates through it', async () => {
    const hash = await hashPassword('password123');
    expect(await bcrypt.compare('password123', hash)).toBe(true);
    expect(await bcrypt.compare('wrong-password', hash)).toBe(false);

    // registerUser now hashes via hashPassword — a fresh registration still logs in.
    const email = uniqueEmail();
    expect((await registerUser(email)).status).toBe(201);
    expect((await loginUser(email)).status).toBe(200);
  });

  // 15. Password recovery is CLI-only: no public HTTP reset/enumeration route (REQ-8.5)
  it('exposes NO unauthenticated password-reset endpoint', async () => {
    // (a) No reset/forgot route is registered on the auth router (CLI-only, D7).
    const { readFile } = await import('node:fs/promises');
    const routeSrc = await readFile(new URL('./auth.route.ts', import.meta.url), 'utf8');
    expect(routeSrc).not.toMatch(/['"`]\/(reset|forgot)[\w-]*['"`]/);

    // (b) Probing such a path never SUCCEEDS unauthenticated (404 absent, or 401
    // blocked — either way no reset/enumeration happens).
    for (const path of [
      '/api/auth/reset-password',
      '/api/auth/reset',
      '/api/auth/forgot-password',
    ]) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      });
      expect(res.ok).toBe(false);
      expect([401, 404]).toContain(res.status);
    }
  });
});

// Task 10 (design Component 7): registration verification issuance, the
// additive emailVerified payload field, and the REQ-1.1 frozen-surface parity.
describe('registration verification issuance + emailVerified payload', () => {
  // 1. Configured register (REQ-5.2): 201 with emailVerified: false, exactly
  //    one hashed verification row, dispatch invoked — driven against a HUNG
  //    transport, so an implementation that awaits the send times this test
  //    out (the prompt-response check; signup latency never inherits SMTP
  //    latency).
  it('configured register issues one token and dispatches without awaiting the send', async () => {
    configureEmail();
    const sendMail = hungTransport();
    const email = uniqueEmail();

    const res = await registerUser(email);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.emailVerified).toBe(false);

    const user = await userByEmail(email);
    expect(user.emailVerified).toBe(false);

    // The send is genuinely in flight (dispatched, unresolved) — the 201
    // returned anyway.
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0] as SentMail;
    expect(mail.to).toBe(email);

    // Exactly one verification row, hashed at rest — the raw token appears
    // only in the emailed link.
    const rows = await verifyRowsFor(user.id);
    expect(rows).toHaveLength(1);
    const raw = /#token=([0-9a-f]{64})/.exec(mail.text)?.[1];
    expect(raw).toBeDefined();
    expect(rows[0].tokenHash).toBe(sha256(raw!));
    expect(rows[0].consumedAt).toBeNull();
  });

  // 2. Unconfigured register (REQ-5.6, D10's verified-at-creation): the user
  //    lands verified, zero verification rows, zero dispatches. The stub is
  //    installed while configured and config removed BEFORE registering, so a
  //    dispatch WOULD be observed if one happened.
  it('unconfigured register creates a verified user with zero tokens and zero dispatches', async () => {
    configureEmail();
    const sendMail = stubTransport();
    unconfigureEmail();
    const email = uniqueEmail();

    const res = await registerUser(email);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.emailVerified).toBe(true);

    const user = await userByEmail(email);
    expect(user.emailVerified).toBe(true);
    expect(await verifyRowsFor(user.id)).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  // 3. Error Scenario 12: ANY issuance throw after the user/session rows
  //    committed is swallowed — the 201 stands (never a 500-after-commit,
  //    never the retry-409 trap), nothing dispatches, and the swallowing
  //    catch's log carries neither a token nor the recipient (REQ-2.5).
  it('still 201s when issuance throws — generic error AND IssuanceConflictError', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const warnSpy = vi.spyOn(logger, 'warn');
    vi.spyOn(emailTokensService, 'issueEmailToken')
      .mockRejectedValueOnce(new Error('transient DB failure notifying someone@example.com'))
      .mockRejectedValueOnce(new emailTokensService.IssuanceConflictError());

    const emailA = uniqueEmail();
    const resA = await registerUser(emailA);
    expect(resA.status).toBe(201);
    expect((await resA.json()).user.emailVerified).toBe(false);

    const emailB = uniqueEmail();
    const resB = await registerUser(emailB);
    expect(resB.status).toBe(201);

    // No token was issued, so nothing may be dispatched.
    expect(sendMail).not.toHaveBeenCalled();
    expect(await verifyRowsFor((await userByEmail(emailA)).id)).toHaveLength(0);

    // The swallowing catch logged both failures — scrubbed of any address
    // (the mocked message embeds one) and carrying no raw token.
    const issuanceWarns = warnSpy.mock.calls.filter(
      ([message]) => message === 'email_verification_issuance_failed',
    );
    expect(issuanceWarns).toHaveLength(2);
    for (const call of issuanceWarns) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(emailA);
      expect(serialized).not.toContain(emailB);
      expect(serialized).not.toContain('someone@example.com');
    }
  });

  // 4. Login and /me read the flag live from the row (REQ-1.1 carve-out (b)).
  it('login and /me carry the live emailVerified flag', async () => {
    const email = uniqueEmail();
    await registerUser(email); // unconfigured ⇒ verified at creation

    const loginRes = await loginUser(email);
    expect(loginRes.status).toBe(200);
    expect((await loginRes.json()).user.emailVerified).toBe(true);
    const cookie = getCookieValue(loginRes, 'session');

    const meRes = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).emailVerified).toBe(true);

    // Flip the stored flag: both endpoints reflect it — nothing is cached.
    await db.update(users).set({ emailVerified: false }).where(eq(users.email, email));
    const loginRes2 = await loginUser(email);
    expect((await loginRes2.json()).user.emailVerified).toBe(false);
    const meRes2 = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${cookie}` },
    });
    expect((await meRes2.json()).emailVerified).toBe(false);
  });

  // 5. Frozen-surface parity (REQ-1.1): with email unconfigured, the four
  //    existing endpoints' bodies match today's shapes byte-for-byte except
  //    the one additive emailVerified field — asserted on the raw text, so
  //    any other drift (key order, extra fields, spacing) fails here.
  it('unconfigured responses match the frozen shapes byte-for-byte except emailVerified', async () => {
    const email = uniqueEmail();

    const registerRes = await registerUser(email);
    expect(registerRes.status).toBe(201);
    const registerText = await registerRes.text();
    const { user } = JSON.parse(registerText) as { user: { id: string } };
    expect(registerText).toBe(
      JSON.stringify({ user: { id: user.id, email, isAdmin: false, emailVerified: true } }),
    );

    const loginRes = await loginUser(email);
    expect(loginRes.status).toBe(200);
    expect(await loginRes.text()).toBe(
      JSON.stringify({ user: { id: user.id, email, isAdmin: false, emailVerified: true } }),
    );
    const cookie = getCookieValue(loginRes, 'session');

    const meRes = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(meRes.status).toBe(200);
    expect(await meRes.text()).toBe(
      JSON.stringify({ id: user.id, email, isAdmin: false, emailVerified: true }),
    );

    // Logout is untouched: byte-identical to today's body.
    const logoutRes = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `session=${cookie}` },
    });
    expect(logoutRes.status).toBe(200);
    expect(await logoutRes.text()).toBe('{"success":true}');
  });
});
