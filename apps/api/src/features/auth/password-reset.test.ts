// Integration tests for the two password-reset endpoints:
// POST /api/auth/password-reset/request — the no-enumeration surface (design
// Testing Strategy §Reset request; REQ-3, REQ-1.2, REQ-2.7) — and
// POST /api/auth/password-reset/complete — consume → revoke → rewrite (design
// Testing Strategy §Reset completion; REQ-4, D8, D12). Real Postgres via the
// test-setup rollback harness; email config toggled by direct `config.X`
// mutation (the app.split-origin.test.ts pattern — isEmailConfigured() reads
// live); per-test unique emails/IPs dodge the module-level limiter state; the
// mailer's transportOverride seam observes (or hangs) dispatches.

import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { emailTokens, sessions, users } from '@/db/schema';
import { config } from '@/lib/config';
import { initMailer } from '@/lib/mailer';
import { withTransaction } from '@/lib/transaction';

import { insertUser } from './auth.query';
import { consumeEmailToken } from './email-tokens.query';
import * as emailTokensService from './email-tokens.service';

let emailCounter = 0;
function uniqueEmail() {
  return `pw-reset-${++emailCounter}@example.com`;
}

// Unique IP per request so the 5/15-min IP limiter never interferes with the
// per-target assertions (and vice versa).
let ipCounter = 0;
function uniqueIp() {
  return `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
}

function requestReset(email: string, ip = uniqueIp()) {
  return app.request('/api/auth/password-reset/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email }),
  });
}

async function createUser(email: string) {
  return insertUser(db, { email, passwordHash: 'x' });
}

// --- email config toggling (direct mutation + restore; predicate reads live) ---
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

afterEach(() => {
  config.SMTP_HOST = ORIGINAL.SMTP_HOST;
  config.EMAIL_FROM = ORIGINAL.EMAIL_FROM;
  config.WEB_BASE_URL = ORIGINAL.WEB_BASE_URL;
  vi.restoreAllMocks();
});

// --- mailer stub seam (Task 5's transportOverride; call configureEmail() first
// — initMailer no-ops when unconfigured) ---
type SentMail = { to: string; text: string };

function stubTransport() {
  const sendMail = vi.fn().mockResolvedValue({});
  initMailer({ sendMail } as unknown as Transporter);
  return sendMail;
}

function hungTransport() {
  // Never settles — a hung SMTP server. An implementation that awaits the
  // send hangs on this and times the test out.
  const sendMail = vi.fn(() => new Promise<never>(() => undefined));
  initMailer({ sendMail } as unknown as Transporter);
  return sendMail;
}

function tokenFromMail(call: unknown): string {
  const match = /#token=([0-9a-f]{64})/.exec((call as SentMail).text);
  if (!match) throw new Error('reset email carries no #token= link');
  return match[1];
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function countResetRows() {
  return db
    .select()
    .from(emailTokens)
    .where(eq(emailTokens.purpose, 'password_reset'))
    .then((rows) => rows.length);
}

function resetRowsFor(userId: string) {
  return db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'password_reset')));
}

function consume(tokenHash: string) {
  return withTransaction(db, (tx) => consumeEmailToken(tx, tokenHash, 'password_reset'));
}

// Error bodies carry a per-request `requestId`; identity across accounts is
// asserted on everything else (the requestId is random noise, not a signal).
async function errorBodyWithoutRequestId(res: Response) {
  const body = (await res.json()) as { error: Record<string, unknown> };
  expect(body.error.requestId).toBeDefined();
  const rest = { ...body.error };
  delete rest.requestId;
  return rest;
}

describe('POST /api/auth/password-reset/request', () => {
  // 1. Configured + existing account: generic 200, exactly one hashed row,
  //    dispatch invoked through the stub seam (REQ-3.1).
  it('issues one hashed token and dispatches the email for an existing account', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const email = uniqueEmail();
    const user = await createUser(email);

    const res = await requestReset(email);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');

    const rows = await resetRowsFor(user.id);
    expect(rows).toHaveLength(1);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0] as SentMail;
    expect(mail.to).toBe(email);

    // Hashed at rest: the raw token appears only in the emailed link.
    const raw = tokenFromMail(mail);
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(rows[0].tokenHash).toBe(sha256(raw));
    expect(rows[0].consumedAt).toBeNull();
  });

  // 2. Nonexistent account: byte-identical status + body, zero rows, zero
  //    dispatches (REQ-3.2 — asserted, not assumed).
  it('responds byte-identically for a nonexistent account and persists nothing', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const email = uniqueEmail();
    await createUser(email);

    const rowsBefore = await countResetRows();
    const resExisting = await requestReset(email);
    const resNonexistent = await requestReset(uniqueEmail()); // never registered

    expect(resNonexistent.status).toBe(resExisting.status);
    const existingBody = await resExisting.text();
    const nonexistentBody = await resNonexistent.text();
    expect(nonexistentBody).toBe(existingBody);

    // Exactly the one row from the existing account; none for the ghost.
    expect(await countResetRows()).toBe(rowsBefore + 1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  // 3. Hung SMTP (MN-3 / REQ-2.7's named verification): a never-resolving
  //    transport must not delay either response — an awaiting implementation
  //    hangs on the stub and times this test out.
  it('responds promptly and byte-identically for both accounts with a hung SMTP transport', async () => {
    configureEmail();
    const sendMail = hungTransport();
    const email = uniqueEmail();
    await createUser(email);

    const resExisting = await requestReset(email);
    const resNonexistent = await requestReset(uniqueEmail());

    // The send is genuinely in flight (dispatched, unresolved) — the response
    // returned anyway.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(resExisting.status).toBe(200);
    expect(resNonexistent.status).toBe(resExisting.status);
    expect(await resNonexistent.text()).toBe(await resExisting.text());
  });

  // 4. Unconfigured (the vitest env default): 409 EMAIL_NOT_CONFIGURED,
  //    identical for existing and nonexistent targets; no token issuance
  //    (REQ-1.2, D12).
  it('returns an identical 409 EMAIL_NOT_CONFIGURED for both accounts when email is unconfigured', async () => {
    const email = uniqueEmail();
    await createUser(email);

    const rowsBefore = await countResetRows();
    const resExisting = await requestReset(email);
    const resNonexistent = await requestReset(uniqueEmail());

    expect(resExisting.status).toBe(409);
    expect(resNonexistent.status).toBe(409);
    const existingError = await errorBodyWithoutRequestId(resExisting);
    const nonexistentError = await errorBodyWithoutRequestId(resNonexistent);
    expect(existingError.code).toBe('EMAIL_NOT_CONFIGURED');
    expect(nonexistentError).toEqual(existingError);

    expect(await countResetRows()).toBe(rowsBefore);
  });

  // 5. Conflict translation (SF-1): a double-23505 IssuanceConflictError from
  //    the token service still yields the generic 200 — never a 500 that fires
  //    only on the account-exists branch.
  it('translates IssuanceConflictError to the generic 200, never a 500', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const email = uniqueEmail();
    await createUser(email);

    const spy = vi
      .spyOn(emailTokensService, 'issueEmailToken')
      .mockRejectedValue(new emailTokensService.IssuanceConflictError());

    const res = await requestReset(email);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');
    expect(spy).toHaveBeenCalledTimes(1);
    // No token was issued, so nothing may be dispatched.
    expect(sendMail).not.toHaveBeenCalled();
  });

  // 6a. Per-target limiter: the 4th request for one normalized email within
  //     the hour is a 429 — identically for existing and nonexistent targets
  //     (REQ-3.4/3.8; limiter behavior is account-existence-independent).
  it('429s the 4th request per target, identically for existing and nonexistent accounts', async () => {
    configureEmail();
    stubTransport();
    const existing = uniqueEmail();
    await createUser(existing);
    const nonexistent = uniqueEmail();

    for (let i = 0; i < 3; i++) {
      expect((await requestReset(existing)).status).toBe(200);
      expect((await requestReset(nonexistent)).status).toBe(200);
    }
    const blockedExisting = await requestReset(existing);
    const blockedNonexistent = await requestReset(nonexistent);

    expect(blockedExisting.status).toBe(429);
    expect(blockedNonexistent.status).toBe(429);
    expect(blockedExisting.headers.get('Retry-After')).toBeDefined();
    expect(blockedNonexistent.headers.get('Retry-After')).toBeDefined();
    expect(await errorBodyWithoutRequestId(blockedNonexistent)).toEqual(
      await errorBodyWithoutRequestId(blockedExisting),
    );
  });

  // 6b. Case variants share ONE bucket: the key is the schema-normalized
  //     email, never the raw submission (REQ-3.8).
  it('buckets case-variant submissions of one email together', async () => {
    configureEmail();
    stubTransport();
    const victim = uniqueEmail(); // lowercase form
    const shouty = victim.toUpperCase(); // e.g. Victim@… vs victim@…

    for (let i = 0; i < 3; i++) {
      expect((await requestReset(shouty)).status).toBe(200);
    }
    // 4th request via the OTHER case variant: separate buckets would grant it
    // a fresh window (200); one shared normalized bucket blocks it.
    const blocked = await requestReset(victim);
    expect(blocked.status).toBe(429);
  });

  // 7. Newest-wins (REQ-3.5 sequence (b)): a second request leaves exactly one
  //    live row; the first token no longer consumes, the second does.
  it('newest-wins: a second request invalidates the first token', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const email = uniqueEmail();
    const user = await createUser(email);

    expect((await requestReset(email)).status).toBe(200);
    expect((await requestReset(email)).status).toBe(200);

    expect(sendMail).toHaveBeenCalledTimes(2);
    const firstRaw = tokenFromMail(sendMail.mock.calls[0][0]);
    const secondRaw = tokenFromMail(sendMail.mock.calls[1][0]);
    expect(secondRaw).not.toBe(firstRaw);

    const rows = await resetRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256(secondRaw));

    expect(await consume(sha256(firstRaw))).toBeNull();
    expect(await consume(sha256(secondRaw))).toEqual({ userId: user.id });
  });
});

// --- completion helpers (route-level, per-request unique IPs) ---

function completeReset(token: string, password: string, ip = uniqueIp()) {
  return app.request('/api/auth/password-reset/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ token, password }),
  });
}

function registerViaRoute(email: string, password: string, ip = uniqueIp()) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
}

function loginViaRoute(email: string, password: string, ip = uniqueIp()) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
}

// Issue a reset token directly through the Task 6 service — the raw return is
// exactly what the emailed link would carry; no email config needed.
function issueResetToken(userId: string) {
  return emailTokensService.issueEmailToken(
    userId,
    'password_reset',
    emailTokensService.RESET_TOKEN_TTL_MS,
  );
}

function sessionRowsFor(userId: string) {
  return db.select().from(sessions).where(eq(sessions.userId, userId));
}

describe('POST /api/auth/password-reset/complete', () => {
  // 1. Happy path (REQ-4.1): valid token + policy-conforming password ⇒ 200
  //    { success: true }, token consumed, and NO session cookie — no
  //    auto-login (D8); the page routes to login.
  it('completes a reset: 200, token consumed, no session cookie', async () => {
    const email = uniqueEmail();
    const user = await createUser(email);
    const raw = await issueResetToken(user.id);

    const res = await completeReset(raw, 'new-password-123');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');
    expect(res.headers.getSetCookie()).toHaveLength(0);

    // Consumed AND defensively deleted (REQ-4.4): zero outstanding reset rows.
    expect(await resetRowsFor(user.id)).toHaveLength(0);
  });

  // 2. Route-level old/new password verification (REQ-4.6): after completion,
  //    login with the old password fails and login with the new one succeeds.
  it('old password fails, new password logs in (route-level)', async () => {
    const email = uniqueEmail();
    const oldPassword = 'old-password-123';
    const newPassword = 'new-password-456';
    expect((await registerViaRoute(email, oldPassword)).status).toBe(201);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const raw = await issueResetToken(user.id);

    expect((await completeReset(raw, newPassword)).status).toBe(200);

    expect((await loginViaRoute(email, oldPassword)).status).toBe(401);
    expect((await loginViaRoute(email, newPassword)).status).toBe(200);
  });

  // 3. Session revocation (REQ-4.5, D8): every session row is deleted and a
  //    pre-reset cookie stops authenticating — the hijacker's surviving
  //    session is the classic hole this closes.
  it('revokes ALL existing sessions', async () => {
    const email = uniqueEmail();
    const password = 'old-password-123';
    const registerRes = await registerViaRoute(email, password);
    expect(registerRes.status).toBe(201);
    const cookie = registerRes.headers
      .getSetCookie()
      .map((h) => /session=([^;]*)/.exec(h)?.[1])
      .find(Boolean);
    expect(cookie).toBeDefined();
    expect((await loginViaRoute(email, password)).status).toBe(200); // 2nd session

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect((await sessionRowsFor(user.id)).length).toBe(2);

    const raw = await issueResetToken(user.id);
    expect((await completeReset(raw, 'new-password-456')).status).toBe(200);

    expect(await sessionRowsFor(user.id)).toHaveLength(0);
    const meRes = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(meRes.status).toBe(401);
  });

  // 4. Reset⇒verified (REQ-4.5's pinned YES, D8): a completed email-delivered
  //    reset proves mailbox control, so email_verified flips true.
  it('marks the account email-verified', async () => {
    const email = uniqueEmail();
    const user = await createUser(email);
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, user.id));
    const raw = await issueResetToken(user.id);

    expect((await completeReset(raw, 'new-password-123')).status).toBe(200);

    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after.emailVerified).toBe(true);
  });

  // 5. REQ-4.2: consumed, expired, and unknown tokens are indistinguishable —
  //    one generic 400 INVALID_OR_EXPIRED_TOKEN, byte-identical bodies modulo
  //    the per-request requestId.
  it('rejects consumed, expired, and unknown tokens with one indistinguishable 400', async () => {
    const email = uniqueEmail();
    const user = await createUser(email);

    // (a) second use of the same token
    const consumedRaw = await issueResetToken(user.id);
    expect((await completeReset(consumedRaw, 'new-password-123')).status).toBe(200);
    const resConsumed = await completeReset(consumedRaw, 'other-password-123');

    // (b) expired: backdate expires_at (>= 1h — the harness's now() is frozen
    // at test-transaction start, so seconds-level backdating is invisible).
    const expiredRaw = await issueResetToken(user.id);
    await db
      .update(emailTokens)
      .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(emailTokens.tokenHash, sha256(expiredRaw)));
    const resExpired = await completeReset(expiredRaw, 'other-password-123');

    // (c) unknown: well-formed hex that was never issued
    const resUnknown = await completeReset(
      crypto.randomBytes(32).toString('hex'),
      'other-password-123',
    );

    expect(resConsumed.status).toBe(400);
    expect(resExpired.status).toBe(400);
    expect(resUnknown.status).toBe(400);
    const consumedBody = await errorBodyWithoutRequestId(resConsumed);
    expect(consumedBody.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect(await errorBodyWithoutRequestId(resExpired)).toEqual(consumedBody);
    expect(await errorBodyWithoutRequestId(resUnknown)).toEqual(consumedBody);

    // The failed attempts changed nothing: the expired row still exists
    // unconsumed (the 400's transaction rolled back).
    const rows = await resetRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].consumedAt).toBeNull();
  });

  // 6. D12: completion stays fully functional when SMTP config is removed
  //    AFTER issuance — consuming an existing token sends nothing, so an
  //    operator toggling config mid-flow strands nobody holding a live link.
  it('works with SMTP config removed after issuance', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const email = uniqueEmail();
    const user = await createUser(email);

    expect((await requestReset(email)).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const raw = tokenFromMail(sendMail.mock.calls[0][0]);

    // Remove the email config (back to the vitest unconfigured default).
    config.SMTP_HOST = ORIGINAL.SMTP_HOST;
    config.EMAIL_FROM = ORIGINAL.EMAIL_FROM;
    config.WEB_BASE_URL = ORIGINAL.WEB_BASE_URL;

    const res = await completeReset(raw, 'new-password-123');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');
    expect(await resetRowsFor(user.id)).toHaveLength(0);
    // Consumption sent nothing: the only dispatch is the request's.
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
