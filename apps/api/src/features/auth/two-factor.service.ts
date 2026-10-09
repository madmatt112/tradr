import { createHash } from 'node:crypto';

import { db } from '@/db';
import { decrypt, EncryptionError } from '@/lib/encryption';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { selectUserById } from './auth.query';
import { startSession } from './auth.service';
import { AccountLockedError, lockoutKey, LOCKOUT_DURATION_MS } from './lockout';
import { clearLockout, recordLoginFailure, selectActiveLock } from './lockout.query';
import { sendUnlockEmail } from './lockout.service';
import { base32Decode, hashBackupCode, matchTotp } from './totp';
import {
  advanceLastUsedStep,
  consumeBackupCode,
  consumeLoginChallenge,
  incrementChallengeAttempts,
  selectLiveLoginChallenge,
  selectTwoFactorForLogin,
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
