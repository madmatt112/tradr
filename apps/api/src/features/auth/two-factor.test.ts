import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { loginChallenges, loginLockouts, userBackupCodes, userTwoFactor } from '@/db/schema';
import { encrypt, loadEncryptionKeyMaterial } from '@/lib/encryption';
import { logger } from '@/lib/logger';

import { lockoutKey } from './lockout';
import { base32Decode, base32Encode, generateTotpSecret, hashBackupCode, totpAt } from './totp';
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
    // Email is unconfigured in the test env, so a freshly registered account is
    // emailVerified: true (the auth.test.ts unconfigured-register precedent at
    // :423/:508); the second step carries that live login-shape flag (design C4
    // "200 { user } in the login shape").
    expect(body.user).toMatchObject({ email, isAdmin: false, emailVerified: true });
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

// Design C5 (task 8): the five authenticated two-factor management routes on
// the same router task 7 created — status, enrol, confirm, regenerate and
// disable. Every test drives the real HTTP seam (`app.request`) with a real
// session cookie against the real database inside the per-test rolled-back
// transaction; no collaborator of the route/service is mocked.

function authHeaders(cookie: string): Record<string, string> {
  return { Cookie: `session=${cookie}`, 'Content-Type': 'application/json' };
}

async function twoFactorStatus(cookie: string) {
  return app.request('/api/auth/two-factor', { headers: authHeaders(cookie) });
}

async function enrol(cookie: string) {
  return app.request('/api/auth/two-factor/enrol', {
    method: 'POST',
    headers: authHeaders(cookie),
  });
}

async function confirmEnrol(cookie: string, code: string) {
  return app.request('/api/auth/two-factor/enrol/confirm', {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ code }),
  });
}

async function regenerateBackupCodes(cookie: string, code: string) {
  return app.request('/api/auth/two-factor/backup-codes', {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ code }),
  });
}

async function disableTwoFactor(cookie: string, password: string, code: string) {
  return app.request('/api/auth/two-factor/disable', {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ password, code }),
  });
}

/** Register a fresh user and sign in (no two-factor yet, so a plain 200 with
 * a session cookie), the shared starting point for every management case. */
async function registerAndLogin(): Promise<{
  email: string;
  password: string;
  userId: string;
  cookie: string;
}> {
  const email = uniqueEmail();
  const password = 'password123';
  const registerRes = await registerUser(email, password);
  const { user } = await registerRes.json();

  const loginRes = await passwordLogin(email, password);
  expect(loginRes.status).toBe(200);
  const cookie = getCookieValue(loginRes, 'session');
  if (!cookie) throw new Error('expected a session cookie from password login');

  return { email, password, userId: user.id, cookie };
}

describe('Two-factor management endpoints (task 8)', () => {
  /**
   * Contract:
   * - Pre-condition: a freshly registered, signed-in user with no two-factor
   *   enrolment (Req 1.1: off until turned on).
   * - Test: `twoFactorStatus(cookie)` before enrolling, then again after a
   *   full enrol + confirm with the current TOTP code.
   * - Observable result: `{ enabled: false }` first, `{ enabled: true }`
   *   after confirm.
   * - Source of expected value: design C5 (`GET /two-factor → { enabled:
   *   boolean }`) and Req 1.10 ("the settings page SHALL show whether
   *   two-factor is on").
   */
  it('status reads false before enrolment and true once confirmed (Req 1.1, 1.10)', async () => {
    const { cookie } = await registerAndLogin();

    const before = await twoFactorStatus(cookie);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ enabled: false });

    const enrolRes = await enrol(cookie);
    const { secret } = await enrolRes.json();
    const code = totpAt(base32Decode(secret), Math.floor(Date.now() / 30000));
    const confirmRes = await confirmEnrol(cookie, code);
    expect(confirmRes.status).toBe(200);

    const after = await twoFactorStatus(cookie);
    expect(await after.json()).toEqual({ enabled: true });
  });

  /**
   * Contract:
   * - Pre-condition: a signed-in user with no pending enrolment.
   * - Test: `enrol(cookie)`.
   * - Observable result: 200 with a `secret` string and an `otpauthUri`
   *   containing that same secret; the RAW `secret_envelope` row this writes
   *   does not contain the secret as a substring.
   * - Source of expected value: Req 1.5 ("store the secret only as an
   *   envelope ... a test SHALL read the raw stored value and assert it does
   *   not contain the secret") and design C5 (`POST /enrol → { secret,
   *   otpauthUri }`).
   */
  it('enrol returns the secret and URI but stores only an encrypted envelope (Req 1.5)', async () => {
    const { userId, cookie } = await registerAndLogin();

    const res = await enrol(cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.secret).toBe('string');
    expect(typeof body.otpauthUri).toBe('string');
    expect(body.otpauthUri).toContain(body.secret);

    const [row] = await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, userId));
    expect(row.secretEnvelope).not.toContain(body.secret);
  });

  /**
   * Contract:
   * - Pre-condition: a signed-in user who started enrolment but never
   *   confirmed it.
   * - Test: `passwordLogin(email, password)` after `enrol(cookie)` alone.
   * - Observable result: 200 (the password-only shape), not the 202
   *   two-factor challenge.
   * - Source of expected value: Req 1.4 ("SHALL NOT turn two-factor on until
   *   the user submits a valid code ... an abandoned enrolment SHALL leave
   *   sign-in unchanged").
   */
  it('an abandoned enrolment (no confirm) leaves login answering 200 (Req 1.4)', async () => {
    const { email, password, cookie } = await registerAndLogin();
    const enrolRes = await enrol(cookie);
    expect(enrolRes.status).toBe(200);

    const loginRes = await passwordLogin(email, password);
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json();
    expect(body.user).toBeDefined();
  });

  /**
   * Contract:
   * - Pre-condition: a signed-in user with a pending (unconfirmed) enrolment.
   * - Test: `confirmEnrol(cookie, '000000')` — a wrong code.
   * - Observable result: 400 `INVALID_TWO_FACTOR_CODE`, and the status
   *   afterwards still reads `{ enabled: false }`.
   * - Source of expected value: design C5 ("400 INVALID_TWO_FACTOR_CODE")
   *   and Req 1.4 (two-factor stays off until a valid code confirms it).
   */
  it('confirm with a wrong code is 400 and enables nothing', async () => {
    const { cookie } = await registerAndLogin();
    await enrol(cookie);

    const res = await confirmEnrol(cookie, '000000');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_TWO_FACTOR_CODE');

    const status = await twoFactorStatus(cookie);
    expect(await status.json()).toEqual({ enabled: false });
  });

  /**
   * Contract:
   * - Pre-condition: a signed-in user with no pending enrolment at all.
   * - Test: `confirmEnrol(cookie, '123456')`.
   * - Observable result: 409 `TWO_FACTOR_NOT_PENDING`.
   * - Source of expected value: design C5 ("`POST /enrol/confirm` ... → 409
   *   `TWO_FACTOR_NOT_PENDING`").
   */
  it('confirm with no pending enrolment is 409 TWO_FACTOR_NOT_PENDING', async () => {
    const { cookie } = await registerAndLogin();

    const res = await confirmEnrol(cookie, '123456');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('TWO_FACTOR_NOT_PENDING');
  });

  /**
   * Contract:
   * - Pre-condition: a user signed in twice (session A from the first login,
   *   session B from a second), with a pending enrolment confirmed USING
   *   session B's cookie.
   * - Test: `confirmEnrol(cookieB, code)`, then `/api/auth/me` with each of
   *   cookie A and cookie B.
   * - Observable result: confirm returns exactly 10 distinct `backupCodes`;
   *   afterwards cookie A no longer authenticates (401) and cookie B still
   *   does (200).
   * - Source of expected value: Req 1.6 ("show 10 single-use backup codes
   *   once") and Req 1.9 ("end every other session of that user and keep the
   *   current one"), with design C5's confirm step ("deleting the user's
   *   sessions except the one matching the request cookie").
   */
  it('confirm returns 10 backup codes and ends every other session but the current one (Req 1.6, 1.9)', async () => {
    const { email, password, cookie: cookieA } = await registerAndLogin();
    const secondLoginRes = await passwordLogin(email, password);
    expect(secondLoginRes.status).toBe(200);
    const cookieB = getCookieValue(secondLoginRes, 'session');
    if (!cookieB) throw new Error('expected a second session cookie');

    const enrolRes = await enrol(cookieB);
    const { secret } = await enrolRes.json();
    const code = totpAt(base32Decode(secret), Math.floor(Date.now() / 30000));

    const confirmRes = await confirmEnrol(cookieB, code);
    expect(confirmRes.status).toBe(200);
    const body = await confirmRes.json();
    expect(body.backupCodes).toHaveLength(10);
    expect(new Set(body.backupCodes).size).toBe(10);

    const meA = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${cookieA}` },
    });
    expect(meA.status).toBe(401);

    const meB = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${cookieB}` },
    });
    expect(meB.status).toBe(200);
  });

  /**
   * Contract:
   * - Pre-condition: a user already enrolled (enabled) with one backup code
   *   inserted directly as the fixture (`enrollTotp` + `insertBackupCode`,
   *   same precedent as the task-7 tests above).
   * - Test: `regenerateBackupCodes(cookie, currentTotpCode(secret))`, then a
   *   real two-factor login attempt with the OLD code and with the first NEW
   *   code.
   * - Observable result: regenerate answers 200 with 10 new codes that do
   *   not include the old one; the old code is then refused
   *   `INVALID_TWO_FACTOR_CODE` on a fresh challenge, and a new code signs in
   *   (200).
   * - Source of expected value: Req 1.7 ("every earlier code SHALL stop
   *   working and 10 new codes SHALL be shown once").
   */
  it('regenerating backup codes voids every earlier code (Req 1.7)', async () => {
    const secret = generateTotpSecret();
    const { email, password, userId, cookie } = await registerAndLogin();
    await enrollTotp(userId, secret);
    const oldRawCode = 'aaaaa-bbbbb';
    await insertBackupCode(userId, oldRawCode);

    const regenRes = await regenerateBackupCodes(cookie, currentTotpCode(secret));
    expect(regenRes.status).toBe(200);
    const { backupCodes: newCodes } = await regenRes.json();
    expect(newCodes).toHaveLength(10);
    expect(newCodes).not.toContain(oldRawCode);

    const firstLogin = await passwordLogin(email, password);
    expect(firstLogin.status).toBe(202);
    const { challenge: firstChallenge } = await firstLogin.json();
    const oldAttempt = await twoFactorLogin(firstChallenge, oldRawCode);
    expect(oldAttempt.status).toBe(400);
    expect((await oldAttempt.json()).error.code).toBe('INVALID_TWO_FACTOR_CODE');

    const secondLogin = await passwordLogin(email, password);
    const { challenge: secondChallenge } = await secondLogin.json();
    const newAttempt = await twoFactorLogin(secondChallenge, newCodes[0]);
    expect(newAttempt.status).toBe(200);
  });

  /**
   * Contract:
   * - Pre-condition: a user already enrolled (enabled) via the `enrollTotp`
   *   fixture.
   * - Test: `disableTwoFactor` with a wrong password AND a wrong code, then
   *   with the right password but a wrong code, then with both right.
   * - Observable result: the first two calls are each 400
   *   `INVALID_CREDENTIALS`; the third is 200, and a subsequent
   *   `passwordLogin` then answers 200 (password alone signs in again).
   * - Source of expected value: Req 1.8 ("require the password and a valid
   *   TOTP or backup code, then delete the secret and all backup codes") and
   *   design C5 ("failure → 400 INVALID_CREDENTIALS").
   */
  it('disable requires both password and code, then password alone signs in (Req 1.8)', async () => {
    const secret = generateTotpSecret();
    const { email, password, userId, cookie } = await registerAndLogin();
    await enrollTotp(userId, secret);

    const bothWrong = await disableTwoFactor(cookie, 'wrong-password', '000000');
    expect(bothWrong.status).toBe(400);
    expect((await bothWrong.json()).error.code).toBe('INVALID_CREDENTIALS');

    const wrongCodeOnly = await disableTwoFactor(cookie, password, '000000');
    expect(wrongCodeOnly.status).toBe(400);
    expect((await wrongCodeOnly.json()).error.code).toBe('INVALID_CREDENTIALS');

    const ok = await disableTwoFactor(cookie, password, currentTotpCode(secret));
    expect(ok.status).toBe(200);

    const loginRes = await passwordLogin(email, password);
    expect(loginRes.status).toBe(200);
    const body = await loginRes.json();
    expect(body.user).toBeDefined();
    expect(getCookieValue(loginRes, 'session')).toBeDefined();
  });

  /**
   * Contract:
   * - Pre-condition: a user already enrolled (enabled) via the `enrollTotp`
   *   fixture.
   * - Test: `enrol(cookie)`.
   * - Observable result: 409 `TWO_FACTOR_ALREADY_ENABLED`.
   * - Source of expected value: design C5 ("`POST /enrol` → 409
   *   `TWO_FACTOR_ALREADY_ENABLED` when on").
   */
  it('enrol while two-factor is already enabled is 409 TWO_FACTOR_ALREADY_ENABLED', async () => {
    const { userId, cookie } = await registerAndLogin();
    await enrollTotp(userId, generateTotpSecret());

    const res = await enrol(cookie);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('TWO_FACTOR_ALREADY_ENABLED');
  });

  /**
   * Contract:
   * - Pre-condition: a single signed-in user, no prior management requests.
   * - Test: 10 `enrol(cookie)` POSTs from that user, then an 11th.
   * - Observable result: none of the first 10 is 429; the 11th is 429 with
   *   `Retry-After`.
   * - Source of expected value: design D19 ("Management endpoints carry a
   *   per-user limit of 10 per 15 minutes") and C5 (`keyGenerator: (c) =>
   *   c.get('userId')`).
   */
  it('the 11th management POST from one user in the window is 429', async () => {
    const { cookie } = await registerAndLogin();

    for (let i = 0; i < 10; i++) {
      const res = await enrol(cookie);
      expect(res.status).not.toBe(429);
    }

    const res = await enrol(cookie);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
  });

  /**
   * Contract:
   * - Pre-condition: a signed-in user driving each of the four management
   *   POST routes, success and failure alike.
   * - Test: `enrol`, `confirmEnrol`, `regenerateBackupCodes` and
   *   `disableTwoFactor`, one call each.
   * - Observable result: every one of the four responses carries
   *   `Cache-Control: no-store`.
   * - Source of expected value: design C5 ("the POSTs add ... `Cache-Control:
   *   no-store`").
   */
  it('every two-factor management POST sets Cache-Control: no-store', async () => {
    const { cookie } = await registerAndLogin();

    const enrolRes = await enrol(cookie);
    expect(enrolRes.status).toBe(200);
    expect(enrolRes.headers.get('Cache-Control')).toBe('no-store');
    const { secret } = await enrolRes.json();

    const confirmRes = await confirmEnrol(
      cookie,
      totpAt(base32Decode(secret), Math.floor(Date.now() / 30000)),
    );
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.headers.get('Cache-Control')).toBe('no-store');

    const regenRes = await regenerateBackupCodes(cookie, '000000');
    expect(regenRes.headers.get('Cache-Control')).toBe('no-store');

    const disableRes = await disableTwoFactor(cookie, 'wrong', '000000');
    expect(disableRes.headers.get('Cache-Control')).toBe('no-store');
  });
});
