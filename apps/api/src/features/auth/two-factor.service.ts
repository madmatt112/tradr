import { createHash } from 'node:crypto';

import bcrypt from 'bcrypt';

import { db } from '@/db';
import { decrypt, encrypt, EncryptionError } from '@/lib/encryption';
import { AppError, UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { selectUserById } from './auth.query';
import { startSession } from './auth.service';
import { AccountLockedError, lockoutKey, LOCKOUT_DURATION_MS } from './lockout';
import { clearLockout, recordLoginFailure, selectActiveLock } from './lockout.query';
import { sendUnlockEmail } from './lockout.service';
import {
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  matchTotp,
  otpauthUri,
} from './totp';
import {
  advanceLastUsedStep,
  consumeBackupCode,
  consumeLoginChallenge,
  deleteBackupCodes,
  deleteSessionsExcept,
  deleteTwoFactor,
  enableTwoFactor,
  incrementChallengeAttempts,
  insertBackupCodes,
  selectEnabledTwoFactor,
  selectEnabledTwoFactorSecret,
  selectLiveLoginChallenge,
  selectPendingTwoFactor,
  selectTwoFactorForLogin,
  selectUnusedBackupCode,
  upsertPendingTwoFactor,
} from './two-factor.query';

// Design C4 step two: turn a live challenge into a session with a valid TOTP
// code or an unused backup code. The codes it pins are `CHALLENGE_EXPIRED`,
// `INVALID_TWO_FACTOR_CODE` (both 400, design D3) and `TWO_FACTOR_UNAVAILABLE`
// (500, design D4 / Req 1.11); an active lock answers 429 `ACCOUNT_LOCKED`.

// A six-digit value is a TOTP code; anything else is a backup code (design C4
// step 4). Backup codes are two base32 groups, never six bare digits.
const TOTP_CODE = /^[0-9]{6}$/;

/**
 * A wrong code rolls the success transaction back so a partial backup-code or
 * TOTP-step write never commits, then the failure bookkeeping (attempts +
 * lockout) commits OUTSIDE that transaction (tasks D2). This private sentinel
 * carries the wrong-code outcome out of the transaction callback.
 */
class WrongTwoFactorCodeError extends Error {}

function challengeExpired(): AppError {
  return new AppError(
    400,
    'CHALLENGE_EXPIRED',
    'This sign-in challenge is no longer valid. Start again from the password step.',
  );
}

/**
 * Complete the second sign-in step (design C4). Resolves to the started session
 * ({ user, token }) the route turns into a cookie + 200, or throws the pinned
 * `AppError` for every refusal. Decrypts the secret on every attempt and fails
 * closed on a decrypt error (Req 1.11); runs the code check, the single-use
 * challenge consume and the session start in one transaction so a lost race
 * rolls the code write back (R1-2, tasks D2).
 */
export async function completeTwoFactorLogin(
  challenge: string,
  code: string,
): Promise<{ user: Awaited<ReturnType<typeof startSession>>['user']; token: string }> {
  const tokenHash = createHash('sha256').update(challenge).digest('hex');

  // (1) A live challenge, or 400 CHALLENGE_EXPIRED.
  const live = await selectLiveLoginChallenge(db, tokenHash);
  if (!live) throw challengeExpired();
  const { userId } = live;

  const user = await selectUserById(db, userId);
  // The account vanished between the two steps — the challenge no longer points
  // at a signable user, so it is dead like any other.
  if (!user) throw challengeExpired();
  const key = lockoutKey(user.email);

  // (2) An active lock refuses the second step too (Req 3.4).
  if (await selectActiveLock(db, key)) {
    throw new AccountLockedError(LOCKOUT_DURATION_MS / 1000);
  }

  // (3) Decrypt the secret on every attempt, backup codes included. A decrypt
  // failure fails closed: 500 with a logged event carrying the userId only, and
  // never a password-only fallback (Req 1.11, design D4).
  const twoFactor = await selectTwoFactorForLogin(db, userId);
  if (!twoFactor) throw challengeExpired();
  let secret: Buffer;
  try {
    secret = base32Decode(decrypt(twoFactor.secretEnvelope));
  } catch (err) {
    if (err instanceof EncryptionError) {
      logger.error('two_factor_decrypt_failed', { userId });
      throw new AppError(
        500,
        'TWO_FACTOR_UNAVAILABLE',
        'Two-factor sign-in is temporarily unavailable. Use the CLI to recover the account.',
      );
    }
    throw err;
  }

  // (4) + (6) + session start in one transaction (design C4, D2).
  try {
    const session = await db.transaction(async (tx) => {
      // (4) Verify the factor. A matched TOTP step must still win the row-level
      // replay guard; a backup code must still be unused.
      let factorOk: boolean;
      if (TOTP_CODE.test(code)) {
        const step = matchTotp(secret, code, Date.now(), twoFactor.lastUsedStep);
        factorOk = step !== null && (await advanceLastUsedStep(tx, userId, step)) !== null;
      } else {
        factorOk = (await consumeBackupCode(tx, userId, hashBackupCode(code))) !== null;
      }
      if (!factorOk) throw new WrongTwoFactorCodeError();

      // (6) Consume the single-use challenge FIRST. Zero rows means a concurrent
      // factor already consumed it — roll the step-4 write back, no session.
      if (!(await consumeLoginChallenge(tx, tokenHash))) throw challengeExpired();

      await clearLockout(tx, key);
      return startSession(user, tx);
    });

    return { user: session.user, token: session.token };
  } catch (err) {
    if (err instanceof WrongTwoFactorCodeError) {
      // D2: the success transaction has rolled back; commit the failure
      // bookkeeping on its own so a wrong code always counts toward the lock.
      await incrementChallengeAttempts(db, tokenHash);
      const { lockedNow } = await recordLoginFailure(db, key);
      if (lockedNow) void sendUnlockEmail(user.id, user.email);
      throw new AppError(
        400,
        'INVALID_TWO_FACTOR_CODE',
        'That code is not valid. Check your authenticator app or use a backup code.',
      );
    }
    throw err;
  }
}

// Design C5: the five authenticated two-factor management operations the router
// wraps — status, enrol, confirm, regenerate and disable. The codes they pin are
// `TWO_FACTOR_ALREADY_ENABLED` / `TWO_FACTOR_NOT_PENDING` (409),
// `INVALID_TWO_FACTOR_CODE` (400) and `INVALID_CREDENTIALS` (400, disable only).

function invalidTwoFactorCode(): AppError {
  return new AppError(
    400,
    'INVALID_TWO_FACTOR_CODE',
    'That code is not valid. Check your authenticator app or use a backup code.',
  );
}

/** Whether two-factor is on for the user (design C5 GET, Req 1.1/1.10). */
export async function getTwoFactorStatus(userId: string): Promise<{ enabled: boolean }> {
  return { enabled: (await selectEnabledTwoFactor(db, userId)) !== null };
}

/**
 * Start enrolment (design C5, Req 1.2/1.5). 409 `TWO_FACTOR_ALREADY_ENABLED` when
 * already on; else store a fresh ≥160-bit secret as an encryption envelope in a
 * pending row and return the base32 secret and its `otpauth://` URI once. Nothing
 * turns on until a code confirms it (Req 1.4).
 */
export async function enrolTwoFactor(
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  if (await selectEnabledTwoFactor(db, userId)) {
    throw new AppError(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor is already enabled.');
  }
  // The route is behind authMiddleware, so the user exists; the guard keeps the
  // email lookup total and never enrols against a vanished account.
  const user = await selectUserById(db, userId);
  if (!user) throw new UnauthorizedError();

  const secret = base32Encode(generateTotpSecret());
  await upsertPendingTwoFactor(db, userId, encrypt(secret));
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

/**
 * Confirm enrolment with a TOTP code (design C5, Req 1.4/1.6/1.9). 409
 * `TWO_FACTOR_NOT_PENDING` when nothing is pending, 400 `INVALID_TWO_FACTOR_CODE`
 * on a wrong code; otherwise, in one transaction, turn two-factor on, replace the
 * backup codes with 10 fresh ones (returned once) and end every OTHER session of
 * the user — `currentSessionTokenHash` is the SHA-256 of the request's own session
 * cookie, hashed as auth.middleware.ts:24-27 does (D11).
 */
export async function confirmTwoFactorEnrolment(
  userId: string,
  code: string,
  currentSessionTokenHash: string,
): Promise<{ backupCodes: string[] }> {
  const pending = await selectPendingTwoFactor(db, userId);
  if (!pending) {
    throw new AppError(
      409,
      'TWO_FACTOR_NOT_PENDING',
      'There is no pending two-factor enrolment to confirm.',
    );
  }

  const secret = base32Decode(decrypt(pending.secretEnvelope));
  const step = matchTotp(secret, code, Date.now(), null);
  if (step === null) throw invalidTwoFactorCode();

  const backupCodes = generateBackupCodes();
  await db.transaction(async (tx) => {
    await enableTwoFactor(tx, userId, step);
    await deleteBackupCodes(tx, userId);
    await insertBackupCodes(
      tx,
      userId,
      backupCodes.map((codeValue) => hashBackupCode(codeValue)),
    );
    await deleteSessionsExcept(tx, userId, currentSessionTokenHash);
  });

  return { backupCodes };
}

/**
 * Regenerate backup codes (design C5, Req 1.7). Needs a valid TOTP — a backup code
 * is refused, since `matchTotp` only matches a 6-digit value. Replaces every
 * earlier code with 10 fresh ones in one transaction and advances the replay guard
 * so the regenerating code cannot then be used at the login step (Req 1.3).
 */
export async function regenerateBackupCodes(
  userId: string,
  code: string,
): Promise<{ backupCodes: string[] }> {
  const row = await selectEnabledTwoFactorSecret(db, userId);
  if (!row) throw invalidTwoFactorCode();

  const secret = base32Decode(decrypt(row.secretEnvelope));
  const step = matchTotp(secret, code, Date.now(), row.lastUsedStep);
  if (step === null) throw invalidTwoFactorCode();

  const backupCodes = generateBackupCodes();
  await db.transaction(async (tx) => {
    await advanceLastUsedStep(tx, userId, step);
    await deleteBackupCodes(tx, userId);
    await insertBackupCodes(
      tx,
      userId,
      backupCodes.map((codeValue) => hashBackupCode(codeValue)),
    );
  });

  return { backupCodes };
}

/**
 * Turn two-factor off (design C5, Req 1.8). Requires the account password AND a
 * valid TOTP or unused backup code; either wrong is a single 400
 * `INVALID_CREDENTIALS` (both checks always run, so the response never leaks which
 * failed). On success deletes the secret row and every backup code in one
 * transaction, so the account signs in with the password alone again.
 */
export async function disableTwoFactor(
  userId: string,
  password: string,
  code: string,
): Promise<void> {
  const user = await selectUserById(db, userId);
  const passwordOk = user ? await bcrypt.compare(password, user.passwordHash) : false;
  const codeOk = await verifyManagementCode(userId, code);
  if (!passwordOk || !codeOk) {
    throw new AppError(400, 'INVALID_CREDENTIALS', 'Password or code is not valid.');
  }

  await db.transaction(async (tx) => {
    await deleteBackupCodes(tx, userId);
    await deleteTwoFactor(tx, userId);
  });
}

/**
 * Verify a TOTP or an unused backup code against the user's ENABLED enrolment
 * (design C5 disable). A 6-digit value is a TOTP matched in the ±1 step window
 * against the stored replay guard; anything else is checked against the unused
 * backup-code hashes. No enabled secret ⇒ false.
 */
async function verifyManagementCode(userId: string, code: string): Promise<boolean> {
  const row = await selectEnabledTwoFactorSecret(db, userId);
  if (!row) return false;

  if (TOTP_CODE.test(code)) {
    const secret = base32Decode(decrypt(row.secretEnvelope));
    return matchTotp(secret, code, Date.now(), row.lastUsedStep) !== null;
  }

  return (await selectUnusedBackupCode(db, userId, hashBackupCode(code))) !== null;
}
