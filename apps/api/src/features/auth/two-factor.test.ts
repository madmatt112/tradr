import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { loginChallenges, loginLockouts, userBackupCodes, userTwoFactor } from '@/db/schema';
import { encrypt, loadEncryptionKeyMaterial } from '@/lib/encryption';
import { logger } from '@/lib/logger';

import { lockoutKey } from './lockout';
import { base32Encode, generateTotpSecret, hashBackupCode, totpAt } from './totp';
import * as twoFactorQuery from './two-factor.query';

// Design C4 step two (task 7): `POST /api/auth/login/two-factor` turns a live
// challenge into a session with a valid TOTP or unused backup code. Every test
// drives the real HTTP seam (`app.request`) against the real database inside
// the per-test rolled-back transaction (test-setup.ts) — no collaborator of
// the route/service is mocked, except the one test that forces a concurrent
// zero-row consume (T7), which spies on the query layer precisely the way the
// task prompt directs ("spy on the query").

let testCounter = 0;
function uniqueEmail(): string {
  return `two-factor-test${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp(): string {
  return `10.0.1.${++ipCounter}`;
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerUser(email: string, password = 'password123', ip = uniqueIp()) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
}

async function passwordLogin(email: string, password = 'password123', ip = uniqueIp()) {
  return app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  });
}

async function twoFactorLogin(challenge: string, code: string, ip = uniqueIp()) {
  return app.request('/api/auth/login/two-factor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ challenge, code }),
  });
}

/** Enrol a user with two-factor ENABLED, storing `secret` as the encryption
 * envelope `decrypt` must reverse (design C4 step 3). */
async function enrollTotp(userId: string, secret: Buffer): Promise<void> {
  await db.insert(userTwoFactor).values({
    userId,
    secretEnvelope: encrypt(base32Encode(secret)),
    enabledAt: new Date(),
  });
}

async function insertBackupCode(userId: string, rawCode: string): Promise<void> {
  await db.insert(userBackupCodes).values({
    userId,
    codeHash: hashBackupCode(rawCode),
  });
}

function currentTotpCode(secret: Buffer): string {
  return totpAt(secret, Math.floor(Date.now() / 30000));
}

/** Register, enrol with a known secret, and run step one to obtain a live
 * challenge — the shared setup every TOTP-driven case starts from. */
async function registerEnrolledAndChallenge(
  secret: Buffer,
): Promise<{ email: string; password: string; userId: string; challenge: string }> {
  const email = uniqueEmail();
  const password = 'password123';
  const registerRes = await registerUser(email, password);
  const { user } = await registerRes.json();
  await enrollTotp(user.id, secret);

  const loginRes = await passwordLogin(email, password);
  expect(loginRes.status).toBe(202);
  const { challenge } = await loginRes.json();

  return { email, password, userId: user.id, challenge };
}

beforeAll(() => {
  // Same precedent as auth.test.ts: drive the encryption module directly so
  // fixtures can seed an already-encrypted secret envelope.
  loadEncryptionKeyMaterial();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/auth/login/two-factor (task 7)', () => {
  /**
   * Contract:
   * - Pre-condition: a registered user enrolled with a known TOTP secret;
   *   login step one returned a live challenge.
   * - Test: `twoFactorLogin(challenge, currentTotpCode(secret))`.
   * - Observable result: 200, a `session` cookie, and `body.user` with the
   *   login shape (`id`, `email`, `isAdmin`, `emailVerified`).
   * - Source of expected value: design C4 step 6 ("else clear the lock,
   *   startSession, cookie, 200 { user } in the login shape") and Req 2.4.
   */
  it('a valid TOTP code signs in once with a session cookie and the login user body', async () => {
    const secret = generateTotpSecret();
    const { email, challenge } = await registerEnrolledAndChallenge(secret);

    const res = await twoFactorLogin(challenge, currentTotpCode(secret));
    expect(res.status).toBe(200);

    const sessionCookie = getCookieValue(res, 'session');
    expect(sessionCookie).toBeDefined();

    const body = await res.json();
    expect(body.user).toMatchObject({ email, isAdmin: false, emailVerified: false });
    expect(body.user.id).toBeDefined();

    const meRes = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    expect(meRes.status).toBe(200);
  });

  /**
   * Contract:
   * - Pre-condition: a TOTP code already used to complete one sign-in.
   * - Test: a second, different challenge answered with the SAME code value.
   * - Observable result: 400 `INVALID_TWO_FACTOR_CODE`.
   * - Source of expected value: Req 1.3 ("reject a code for a step already
   *   accepted for that user") and design C4 step 4 ("zero rows is a
   *   replay, so wrong").
   */
  it('the same TOTP code, once used, is refused on a later challenge', async () => {
    const secret = generateTotpSecret();
    const { email, password, challenge } = await registerEnrolledAndChallenge(secret);
    const code = currentTotpCode(secret);

    const first = await twoFactorLogin(challenge, code);
    expect(first.status).toBe(200);

    const secondLogin = await passwordLogin(email, password);
    expect(secondLogin.status).toBe(202);
    const { challenge: secondChallenge } = await secondLogin.json();

    const replay = await twoFactorLogin(secondChallenge, code);
    expect(replay.status).toBe(400);
    const body = await replay.json();
    expect(body.error.code).toBe('INVALID_TWO_FACTOR_CODE');
  });

  /**
   * Contract:
   * - Pre-condition: a registered, enrolled user with one unused backup code.
   * - Test: `twoFactorLogin(challenge, rawBackupCode)`, then a fresh
   *   challenge answered with the same backup code again.
   * - Observable result: the first call is 200 with a session cookie; the
   *   second is 400 `INVALID_TWO_FACTOR_CODE`.
   * - Source of expected value: Req 2.4 ("mark a used backup code spent")
   *   and Req 2.5 (a now-wrong code is refused).
   */
  it('a backup code signs in once and is then refused', async () => {
    const email = uniqueEmail();
    const password = 'password123';
    const registerRes = await registerUser(email, password);
    const { user } = await registerRes.json();
    await enrollTotp(user.id, generateTotpSecret());
    const rawCode = 'abcde-fghij';
    await insertBackupCode(user.id, rawCode);

    const firstLogin = await passwordLogin(email, password);
    const { challenge: firstChallenge } = await firstLogin.json();
    const first = await twoFactorLogin(firstChallenge, rawCode);
    expect(first.status).toBe(200);
    expect(getCookieValue(first, 'session')).toBeDefined();

    const secondLogin = await passwordLogin(email, password);
    const { challenge: secondChallenge } = await secondLogin.json();
    const second = await twoFactorLogin(secondChallenge, rawCode);
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body.error.code).toBe('INVALID_TWO_FACTOR_CODE');
  });

  /**
   * Contract:
   * - Pre-condition: a live challenge for an enrolled user; the lockout
   *   counter for that address already sits at 9 failures inside the window.
   * - Test: `twoFactorLogin(challenge, '000000')` (wrong code).
   * - Observable result: 400 `INVALID_TWO_FACTOR_CODE`, AND the address's
   *   `login_lockouts` row now reads `failureCount: 10` with a non-null
   *   `lockedUntil` — the wrong second-step code was the failure that locked
   *   it.
   * - Source of expected value: Req 2.5 ("count the failure toward
   *   Requirement 3"), Req 3.2 ("a wrong second-step code" is a failure) and
   *   Req 3.3 (ten failures in the window lock for 15 minutes).
   */
  it('a wrong code is 400 and counts as a failure toward the per-address lock', async () => {
    const secret = generateTotpSecret();
    const { email, challenge } = await registerEnrolledAndChallenge(secret);

    const key = lockoutKey(email);
    await db.insert(loginLockouts).values({
      keyHash: key,
      failureCount: 9,
      windowStartedAt: new Date(),
      lockedUntil: null,
    });

    const res = await twoFactorLogin(challenge, '000000');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_TWO_FACTOR_CODE');

    const [row] = await db.select().from(loginLockouts).where(eq(loginLockouts.keyHash, key));
    expect(row.failureCount).toBe(10);
    expect(row.lockedUntil).not.toBeNull();
  });

  /**
   * Contract:
   * - Pre-condition: a live challenge; five prior wrong-code attempts
   *   already spent against it (status 400 each).
   * - Test: a sixth submission, THIS TIME with the genuinely correct TOTP
   *   code.
   * - Observable result: 400 `CHALLENGE_EXPIRED` even though the code is
   *   correct, and no session cookie.
   * - Source of expected value: Req 2.3 ("allow at most 5 code attempts")
   *   and design C4 step 1 ("live challenge (unconsumed, unexpired, under 5
   *   attempts) or 400 CHALLENGE_EXPIRED").
   */
  it('the 6th attempt against a challenge is CHALLENGE_EXPIRED even with the correct code', async () => {
    const secret = generateTotpSecret();
    const { challenge } = await registerEnrolledAndChallenge(secret);

    for (let i = 0; i < 5; i++) {
      const wrong = await twoFactorLogin(challenge, '000000');
      expect(wrong.status).toBe(400);
    }

    const sixth = await twoFactorLogin(challenge, currentTotpCode(secret));
    expect(sixth.status).toBe(400);
    const body = await sixth.json();
    expect(body.error.code).toBe('CHALLENGE_EXPIRED');
    expect(getCookieValue(sixth, 'session')).toBeUndefined();
  });

  /**
   * Contract:
   * - Pre-condition: a live challenge whose row's `expires_at` is moved into
   *   the past.
   * - Test: `twoFactorLogin(challenge, currentTotpCode(secret))`.
   * - Observable result: 400 `CHALLENGE_EXPIRED`, no session cookie.
   * - Source of expected value: Req 2.3 ("expire 5 minutes after issue") and
   *   design C4 step 1.
   */
  it('an expired challenge is CHALLENGE_EXPIRED', async () => {
    const secret = generateTotpSecret();
    const { challenge } = await registerEnrolledAndChallenge(secret);

    await db
      .update(loginChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(loginChallenges.tokenHash, sha256(challenge)));

    const res = await twoFactorLogin(challenge, currentTotpCode(secret));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CHALLENGE_EXPIRED');
    expect(getCookieValue(res, 'session')).toBeUndefined();
  });

  /**
   * Contract:
   * - Pre-condition: a challenge already consumed by a successful sign-in.
   * - Test: the SAME challenge token submitted again (any code).
   * - Observable result: 400 `CHALLENGE_EXPIRED`, no session cookie — distinct
   *   from the replay case (T2), which reuses the CODE on a FRESH challenge
   *   and gets `INVALID_TWO_FACTOR_CODE` instead.
   * - Source of expected value: Req 2.3 ("single-use") and design C4 step 1
   *   ("live challenge (unconsumed...)").
   */
  it('a challenge already used for a sign-in is CHALLENGE_EXPIRED', async () => {
    const secret = generateTotpSecret();
    const { challenge } = await registerEnrolledAndChallenge(secret);

    const first = await twoFactorLogin(challenge, currentTotpCode(secret));
    expect(first.status).toBe(200);

    const reused = await twoFactorLogin(challenge, '000000');
    expect(reused.status).toBe(400);
    const body = await reused.json();
    expect(body.error.code).toBe('CHALLENGE_EXPIRED');
    expect(getCookieValue(reused, 'session')).toBeUndefined();
  });

  /**
   * Contract:
   * - Pre-condition: the user's `secret_envelope` is seeded with a value
   *   `decrypt` cannot parse (too short to be a real envelope).
   * - Test: `twoFactorLogin(challenge, '000000')`.
   * - Observable result: 500, `body.error.code === 'TWO_FACTOR_UNAVAILABLE'`,
   *   `logger.error` called with `'two_factor_decrypt_failed'` and an extras
   *   object equal to `{ userId }` (userId only), and no session cookie.
   * - Source of expected value: Req 1.11 ("fail closed with a server error
   *   and a logged event") and design Error Handling item 4
   *   ("two_factor_decrypt_failed logged with userId only").
   */
  it('an undecryptable secret envelope answers 500 with the decrypt-failure log line and no session', async () => {
    const email = uniqueEmail();
    const password = 'password123';
    const registerRes = await registerUser(email, password);
    const { user } = await registerRes.json();
    await db.insert(userTwoFactor).values({
      userId: user.id,
      secretEnvelope: Buffer.from('too-short').toString('base64'),
      enabledAt: new Date(),
    });

    const loginRes = await passwordLogin(email, password);
    expect(loginRes.status).toBe(202);
    const { challenge } = await loginRes.json();

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const res = await twoFactorLogin(challenge, '000000');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('TWO_FACTOR_UNAVAILABLE');
    expect(getCookieValue(res, 'session')).toBeUndefined();

    const decryptFailureCall = errorSpy.mock.calls.find(
      ([event]) => event === 'two_factor_decrypt_failed',
    );
    expect(decryptFailureCall).toBeDefined();
    expect(decryptFailureCall?.[1]).toEqual({ userId: user.id });
  });

  /**
   * Contract:
   * - Pre-condition: an enrolled user with one unused backup code and a live
   *   challenge; the query that conditionally consumes the challenge is
   *   forced, for this one call, to report zero rows (a concurrent sign-in
   *   won the single-use row) — "spy on the query" per the task's success
   *   criteria.
   * - Test: `twoFactorLogin(challenge, rawBackupCode)` while the consume
   *   query is forced to `null`.
   * - Observable result: 400 `CHALLENGE_EXPIRED`, no session cookie, AND the
   *   backup code's `used_at` stays NULL — the step-4 backup-code write
   *   rolled back with the failed step-6 consume.
   * - Source of expected value: design C4 ("Run steps 4 and 6 and the
   *   session start in one transaction, so a zero-row challenge consume
   *   rolls back the step-4 TOTP-step or backup-code write") and step 6
   *   ("0 rows ... -> 400 CHALLENGE_EXPIRED, no session"), with the
   *   zero-rows-is-null contract of the conditional-UPDATE consume this
   *   design reuses (`email-tokens.query.ts:27-45`, `consumeEmailToken`).
   */
  it('a forced zero-row challenge consume leaves the backup code unused', async () => {
    const email = uniqueEmail();
    const password = 'password123';
    const registerRes = await registerUser(email, password);
    const { user } = await registerRes.json();
    await enrollTotp(user.id, generateTotpSecret());
    const rawCode = 'klmno-pqrst';
    await insertBackupCode(user.id, rawCode);

    const loginRes = await passwordLogin(email, password);
    const { challenge } = await loginRes.json();

    const consumeSpy = vi
      .spyOn(twoFactorQuery, 'consumeLoginChallenge')
      .mockResolvedValueOnce(null);

    const res = await twoFactorLogin(challenge, rawCode);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CHALLENGE_EXPIRED');
    expect(getCookieValue(res, 'session')).toBeUndefined();
    expect(consumeSpy).toHaveBeenCalled();

    const [backupRow] = await db
      .select()
      .from(userBackupCodes)
      .where(eq(userBackupCodes.userId, user.id));
    expect(backupRow.usedAt).toBeNull();
  });

  /**
   * Contract:
   * - Pre-condition: a live challenge for an enrolled user; separately, the
   *   address locks (a lockout row with a future `locked_until`) between step
   *   one and step two.
   * - Test: `twoFactorLogin(challenge, currentTotpCode(secret))`.
   * - Observable result: 429, `body.error.code === 'ACCOUNT_LOCKED'`.
   * - Source of expected value: design C4 ("active lock -> 429") and Req
   *   3.4 ("every sign-in for it ... SHALL be refused with status 429,
   *   error code ACCOUNT_LOCKED").
   */
  it('a locked address at step two is 429 ACCOUNT_LOCKED', async () => {
    const secret = generateTotpSecret();
    const { email, challenge } = await registerEnrolledAndChallenge(secret);

    await db.insert(loginLockouts).values({
      keyHash: lockoutKey(email),
      failureCount: 10,
      windowStartedAt: new Date(),
      lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
    });

    const res = await twoFactorLogin(challenge, currentTotpCode(secret));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('ACCOUNT_LOCKED');
  });

  /**
   * Contract:
   * - Pre-condition: none (the limiter counts requests regardless of body
   *   validity, the `/api/auth/login` precedent at `auth.test.ts:313-327`).
   * - Test: 10 requests to the second-step endpoint from one IP, then an
   *   11th.
   * - Observable result: none of the first 10 is 429; the 11th is 429 with
   *   `Retry-After`.
   * - Source of expected value: Req 2.6 ("carry a per-IP limiter with the
   *   login budget (10 per 15 minutes, fallback 5)").
   */
  it('the 11th request from one IP in the window is 429', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) {
      const res = await twoFactorLogin('a'.repeat(64), '123456', ip);
      expect(res.status).not.toBe(429);
    }

    const res = await twoFactorLogin('a'.repeat(64), '123456', ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
  });
});
