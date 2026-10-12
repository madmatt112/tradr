// Integration tests for POST /api/auth/unlock (design C6, Task 9; Req 3.7,
// 4.7, 4.8). Real Postgres via the test-setup rollback harness (per-test
// SAVEPOINT isolation, see src/test-setup.ts); tokens are issued directly
// through `issueEmailToken` (Task 6's service) rather than via the emailed
// link, per the task prompt — this endpoint needs no email config and sends
// no mail. Unique emails/IPs per test dodge both the module-level rate
// limiter state and the lockout row's primary key.
//
// Contract, one block per success criterion (from the task 9 prompt's
// "Success:" line):
//
// 1. valid token clears the lock + correct password signs in
//    Pre-condition: a registered account is locked (10 recorded failures
//      produce a real `login_lockouts` row via `recordLoginFailure`, the same
//      primitive the login route itself drives — Req 3.3).
//    Test: POST /api/auth/unlock { token: <raw account_unlock token> }
//    Observable: 200 { success: true }; the `login_lockouts` row for the
//      address is gone; a subsequent POST /api/auth/login with the correct
//      password returns 200.
//    Source: task prompt Success clause 1; Req 3.7 (clear on unlock path).
//
// 2. the same token a second time is 400 INVALID_OR_EXPIRED_TOKEN
//    Pre-condition: the token from (1) was already consumed by one prior
//      POST /api/auth/unlock.
//    Test: POST /api/auth/unlock with the identical raw token again.
//    Observable: 400, body.error.code === 'INVALID_OR_EXPIRED_TOKEN'.
//    Source: task prompt Success clause 2; design C6 (400
//      INVALID_OR_EXPIRED_TOKEN on zero consumed rows).
//
// 3. an expired token is refused
//    Pre-condition: a live `account_unlock` token whose `expires_at` has been
//      backdated into the past (the password-reset.test.ts expiry pattern).
//    Test: POST /api/auth/unlock with that token's raw value.
//    Observable: 400, body.error.code === 'INVALID_OR_EXPIRED_TOKEN'.
//    Source: task prompt Success clause 3 (first half); design C6.
//
// 4. a `password_reset` token is refused
//    Pre-condition: a live token issued with purpose `password_reset`
//      (Task 6's `issueEmailToken`), never `account_unlock`.
//    Test: POST /api/auth/unlock with that token's raw value.
//    Observable: 400, body.error.code === 'INVALID_OR_EXPIRED_TOKEN'.
//    Source: task prompt Success clause 3 (second half); email-tokens.query.ts
//      consumeEmailToken's purpose predicate.
//
// 5. an unlock for an address with no lock still answers 200
//    Pre-condition: a registered account with no `login_lockouts` row at all.
//    Test: POST /api/auth/unlock with a live token for that account.
//    Observable: 200 { success: true }.
//    Source: task prompt Success clause 4; design C6 (the transaction
//      consumes the token and clears the lock for the user's address — a
//      clear of nothing is still a success).
//
// 6. the 11th request from one IP is 429
//    Pre-condition: none beyond a shared IP across all 11 calls.
//    Test: 11 consecutive POST /api/auth/unlock calls from one
//      X-Forwarded-For IP (never-issued but well-formed 64-hex tokens).
//    Observable: the 11th response is 429.
//    Source: task prompt Success clause 5; design C6 limiter
//      { name: 'unlock', max: 10, windowMs: 15 * 60 * 1000, fallbackMax: 5 }.

import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { emailTokens, loginLockouts, users } from '@/db/schema';

import { issueEmailToken, RESET_TOKEN_TTL_MS, UNLOCK_TOKEN_TTL_MS } from './email-tokens.service';
import { lockoutKey } from './lockout';
import { recordLoginFailure } from './lockout.query';

let testCounter = 0;
function uniqueEmail() {
  return `unlock-route-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.30.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
}

async function registerUser(email: string, password = 'password123', ip = uniqueIp()) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
}

async function loginUser(email: string, password = 'password123', ip = uniqueIp()) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
}

function unlock(token: string, ip = uniqueIp()) {
  return app.request('/api/auth/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ token }),
  });
}

async function lockoutRowsFor(email: string) {
  return db
    .select()
    .from(loginLockouts)
    .where(eq(loginLockouts.keyHash, lockoutKey(email)));
}

async function userByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email));
  const user = rows[0];
  if (!user) throw new Error('test setup: user was not persisted');
  return user;
}

async function lockAddress(email: string) {
  const key = lockoutKey(email);
  for (let i = 0; i < 10; i++) {
    await recordLoginFailure(db, key);
  }
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

describe('POST /api/auth/unlock', () => {
  it('a valid token clears the lock and the correct password then signs in', async () => {
    const email = uniqueEmail();
    const password = 'password123';
    await registerUser(email, password);
    const registered = await userByEmail(email);
    await lockAddress(email);
    expect(await lockoutRowsFor(email)).toHaveLength(1);

    const raw = await issueEmailToken(registered.id, 'account_unlock', UNLOCK_TOKEN_TTL_MS);

    const res = await unlock(raw);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');
    expect(await lockoutRowsFor(email)).toHaveLength(0);

    const loginRes = await loginUser(email, password);
    expect(loginRes.status).toBe(200);
  });

  it('the same token a second time is 400 INVALID_OR_EXPIRED_TOKEN', async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const registered = await userByEmail(email);
    await lockAddress(email);
    const raw = await issueEmailToken(registered.id, 'account_unlock', UNLOCK_TOKEN_TTL_MS);

    expect((await unlock(raw)).status).toBe(200);
    const second = await unlock(raw);

    expect(second.status).toBe(400);
    expect(await errorCode(second)).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('an expired token is refused', async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const registered = await userByEmail(email);
    await lockAddress(email);
    const raw = await issueEmailToken(registered.id, 'account_unlock', UNLOCK_TOKEN_TTL_MS);
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    await db
      .update(emailTokens)
      .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(emailTokens.tokenHash, tokenHash));

    const res = await unlock(raw);

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('a password_reset token is refused', async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const registered = await userByEmail(email);
    await lockAddress(email);
    const raw = await issueEmailToken(registered.id, 'password_reset', RESET_TOKEN_TTL_MS);

    const res = await unlock(raw);

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('an unlock for an address with no lock still answers 200', async () => {
    const email = uniqueEmail();
    await registerUser(email);
    const registered = await userByEmail(email);
    expect(await lockoutRowsFor(email)).toHaveLength(0);
    const raw = await issueEmailToken(registered.id, 'account_unlock', UNLOCK_TOKEN_TTL_MS);

    const res = await unlock(raw);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"success":true}');
  });

  it('the 11th request from one IP is 429', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) {
      const token = crypto.randomBytes(32).toString('hex'); // well-formed, never issued
      const res = await unlock(token, ip);
      expect(res.status).toBe(400);
    }

    const eleventh = await unlock(crypto.randomBytes(32).toString('hex'), ip);

    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get('Retry-After')).toBeDefined();
  });
});
