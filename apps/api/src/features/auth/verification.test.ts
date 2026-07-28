// Integration tests for the two email-verification endpoints:
// POST /api/auth/verify-email — public, gesture-consumed (design Testing
// Strategy §Verification; REQ-5.3, REQ-4.8, D6/D7/D12) — and
// POST /api/auth/verify-email/resend — authenticated-only (D11; REQ-5.4,
// REQ-1.2). Real Postgres via the test-setup rollback harness; email config
// toggled by direct `config.X` mutation (isEmailConfigured() reads live);
// per-test unique emails/IPs dodge the module-level limiter state (the resend
// limiter keys on userId — unique users per test); the mailer's
// transportOverride seam observes dispatches. Verification tokens are minted
// directly through the Task 6 service (the raw return is exactly what the
// emailed link would carry — no email config needed).

import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { emailTokens, users } from '@/db/schema';
import { config } from '@/lib/config';
import { initMailer } from '@/lib/mailer';
import { withTransaction } from '@/lib/transaction';

import { consumeEmailToken } from './email-tokens.query';
import * as emailTokensService from './email-tokens.service';

let emailCounter = 0;
function uniqueEmail() {
  return `verify-${++emailCounter}@example.com`;
}

// Unique IP per request so the 10/15-min verify-email IP limiter (and the
// register limiter behind the session-minting helper) never interferes.
let ipCounter = 0;
function uniqueIp() {
  return `10.30.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
}

function verifyEmailReq(token: string, ip = uniqueIp()) {
  return app.request('/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ token }),
  });
}

function resendReq(cookie?: string, ip = uniqueIp()) {
  return app.request('/api/auth/verify-email/resend', {
    method: 'POST',
    headers: { 'X-Forwarded-For': ip, ...(cookie ? { Cookie: `session=${cookie}` } : {}) },
  });
}

// Register through the real route: mints the user AND the session cookie the
// authed resend endpoint needs. Registers with email UNCONFIGURED (config
// snapshotted and restored) so Task 10's registration-time issuance stays out
// of this suite's assertions: the user lands verified-at-creation (D10) with
// no verification rows and no dispatch — tests flip the flag and issue tokens
// explicitly.
async function registerAuthedUser() {
  const snapshot = {
    SMTP_HOST: config.SMTP_HOST,
    EMAIL_FROM: config.EMAIL_FROM,
    WEB_BASE_URL: config.WEB_BASE_URL,
  };
  unconfigureEmail();
  try {
    const email = uniqueEmail();
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ email, password: 'password-123' }),
    });
    expect(res.status).toBe(201);
    const cookie = res.headers
      .getSetCookie()
      .map((h) => /session=([^;]*)/.exec(h)?.[1])
      .find(Boolean);
    if (!cookie) throw new Error('register set no session cookie');
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return { user, email, cookie };
  } finally {
    config.SMTP_HOST = snapshot.SMTP_HOST;
    config.EMAIL_FROM = snapshot.EMAIL_FROM;
    config.WEB_BASE_URL = snapshot.WEB_BASE_URL;
  }
}

async function markUnverified(userId: string) {
  await db.update(users).set({ emailVerified: false }).where(eq(users.id, userId));
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

function tokenFromMail(call: unknown): string {
  const match = /#token=([0-9a-f]{64})/.exec((call as SentMail).text);
  if (!match) throw new Error('verification email carries no #token= link');
  return match[1];
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Mint a verification token directly through the Task 6 service — no email
// config needed; the raw return is what the emailed link would carry.
function issueVerifyToken(userId: string) {
  return emailTokensService.issueEmailToken(
    userId,
    'email_verification',
    emailTokensService.VERIFY_TOKEN_TTL_MS,
  );
}

function verifyRowsFor(userId: string) {
  return db
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'email_verification')));
}

function consume(tokenHash: string) {
  return withTransaction(db, (tx) => consumeEmailToken(tx, tokenHash, 'email_verification'));
}

async function verifiedFlagOf(userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row.emailVerified;
}

// Error bodies carry a per-request `requestId`; identity is asserted on
// everything else (the requestId is random noise, not a signal).
async function errorBodyWithoutRequestId(res: Response) {
  const body = (await res.json()) as { error: Record<string, unknown> };
  expect(body.error.requestId).toBeDefined();
  const rest = { ...body.error };
  delete rest.requestId;
  return rest;
}

describe('POST /api/auth/verify-email', () => {
  // 1. Happy path (REQ-5.3) — running with SMTP UNCONFIGURED (the vitest
  //    default), which is itself the D12 proof: verification consumes an
  //    existing token and sends nothing, so it needs no email config. Flag
  //    flips true, token consumed.
  it('verifies the account and consumes the token — with SMTP unconfigured (D12)', async () => {
    const { user } = await registerAuthedUser();
    await markUnverified(user.id);
    const raw = await issueVerifyToken(user.id);

    const res = await verifyEmailReq(raw);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');

    expect(await verifiedFlagOf(user.id)).toBe(true);
    const rows = await verifyRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].consumedAt).not.toBeNull();
    // Consumed means consumed: the same token cannot be consumed again.
    expect(await consume(sha256(raw))).toBeNull();
  });

  // 2. REQ-5.3/REQ-4.2 posture: consumed, expired, and unknown tokens are
  //    indistinguishable — one generic 400 INVALID_OR_EXPIRED_TOKEN,
  //    byte-identical bodies modulo the per-request requestId; the failed
  //    attempts write nothing (the 400's transaction rolls back).
  it('rejects consumed, expired, and unknown tokens with one indistinguishable 400', async () => {
    const { user } = await registerAuthedUser();
    await markUnverified(user.id);

    // (a) second use of the same token
    const consumedRaw = await issueVerifyToken(user.id);
    expect((await verifyEmailReq(consumedRaw)).status).toBe(200);
    const resConsumed = await verifyEmailReq(consumedRaw);

    // (b) expired: backdate expires_at (>= 1h — the harness's now() is frozen
    // at test-transaction start, so seconds-level backdating is invisible).
    await markUnverified(user.id);
    const expiredRaw = await issueVerifyToken(user.id);
    await db
      .update(emailTokens)
      .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(emailTokens.tokenHash, sha256(expiredRaw)));
    const resExpired = await verifyEmailReq(expiredRaw);

    // (c) unknown: well-formed hex that was never issued
    const resUnknown = await verifyEmailReq(crypto.randomBytes(32).toString('hex'));

    expect(resConsumed.status).toBe(400);
    expect(resExpired.status).toBe(400);
    expect(resUnknown.status).toBe(400);
    const consumedBody = await errorBodyWithoutRequestId(resConsumed);
    expect(consumedBody.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect(await errorBodyWithoutRequestId(resExpired)).toEqual(consumedBody);
    expect(await errorBodyWithoutRequestId(resUnknown)).toEqual(consumedBody);

    // The failed attempts changed nothing: still unverified, and the expired
    // row still exists unconsumed.
    expect(await verifiedFlagOf(user.id)).toBe(false);
    const rows = await verifyRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].consumedAt).toBeNull();
  });

  // 3. D12's mid-flow edge: a token issued while configured still verifies
  //    after the operator removes SMTP config — nobody holding a live emailed
  //    link is stranded, and consumption dispatches nothing.
  it('works with SMTP config removed after issuance', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const { user, cookie } = await registerAuthedUser();
    await markUnverified(user.id);

    expect((await resendReq(cookie)).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const raw = tokenFromMail(sendMail.mock.calls[0][0]);

    unconfigureEmail();

    const res = await verifyEmailReq(raw);
    expect(res.status).toBe(200);
    expect(await verifiedFlagOf(user.id)).toBe(true);
    // Consumption sent nothing: the only dispatch is the resend's.
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/verify-email/resend', () => {
  // 4. D11: the resend surface is authenticated-only — no cookie ⇒ 401 before
  //    any account-conditional work (no-enumeration by construction).
  it('401s an unauthenticated resend', async () => {
    const res = await resendReq();
    expect(res.status).toBe(401);
    expect((await errorBodyWithoutRequestId(res)).code).toBe('UNAUTHORIZED');
  });

  // 5. Already verified ⇒ 409 ALREADY_VERIFIED (an authed self-fact). Runs
  //    UNCONFIGURED on purpose: the verified check is pinned FIRST in the
  //    handler order, ahead of the config gate (Component 6).
  it('409s ALREADY_VERIFIED for a verified account (checked before the config gate)', async () => {
    const { user, cookie } = await registerAuthedUser(); // verified-at-creation (D10)
    expect(await verifiedFlagOf(user.id)).toBe(true);

    const res = await resendReq(cookie);
    expect(res.status).toBe(409);
    expect((await errorBodyWithoutRequestId(res)).code).toBe('ALREADY_VERIFIED');
  });

  // 6. Unverified on an email-less instance ⇒ 409 EMAIL_NOT_CONFIGURED (the
  //    distinct code — the UI keys on code, SF-2/D12); no token issuance.
  it('409s EMAIL_NOT_CONFIGURED for an unverified account when email is unconfigured', async () => {
    const { user, cookie } = await registerAuthedUser();
    await markUnverified(user.id);

    const res = await resendReq(cookie);
    expect(res.status).toBe(409);
    const error = await errorBodyWithoutRequestId(res);
    expect(error.code).toBe('EMAIL_NOT_CONFIGURED');
    expect(error.message).toBe(
      'This instance has no email configured. Email verification is unavailable and not required.',
    );

    expect(await verifyRowsFor(user.id)).toHaveLength(0);
  });

  // 7. Happy path + newest-wins reissue: each resend leaves exactly ONE live
  //    hashed row; the second resend replaces the first token, which then no
  //    longer consumes (D4/D5 — REQ-3.8's bounded-outstanding-tokens arm).
  it('resends with newest-wins reissue: the second token replaces the first', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const { user, email, cookie } = await registerAuthedUser();
    await markUnverified(user.id);

    const first = await resendReq(cookie);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('{"success":true}');
    expect(sendMail).toHaveBeenCalledTimes(1);
    const firstMail = sendMail.mock.calls[0][0] as SentMail;
    expect(firstMail.to).toBe(email);
    const firstRaw = tokenFromMail(firstMail);

    expect((await resendReq(cookie)).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(2);
    const secondRaw = tokenFromMail(sendMail.mock.calls[1][0]);
    expect(secondRaw).not.toBe(firstRaw);

    // Old row replaced: exactly one live row, hashed from the SECOND raw.
    const rows = await verifyRowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha256(secondRaw));
    expect(rows[0].consumedAt).toBeNull();

    expect(await consume(sha256(firstRaw))).toBeNull();
    expect(await consume(sha256(secondRaw))).toEqual({ userId: user.id });
  });

  // 8. Conflict translation (Component 4's pinned per-caller translation): a
  //    double-23505 IssuanceConflictError yields the same plain 200 — never a
  //    500 (re-clicking resend cures it); nothing is dispatched.
  it('translates IssuanceConflictError to the plain 200, never a 500', async () => {
    configureEmail();
    const sendMail = stubTransport();
    const { user, cookie } = await registerAuthedUser();
    await markUnverified(user.id);

    const spy = vi
      .spyOn(emailTokensService, 'issueEmailToken')
      .mockRejectedValue(new emailTokensService.IssuanceConflictError());

    const res = await resendReq(cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');
    expect(spy).toHaveBeenCalledTimes(1);
    // No token was issued, so nothing may be dispatched.
    expect(sendMail).not.toHaveBeenCalled();
  });
});
