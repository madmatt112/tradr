import crypto from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';

import { db } from '@/db';
import { loginLockouts } from '@/db/schema';
import { emailHash } from '@/features/account-deletion/account-deletion.service';
import { errorHandler } from '@/middleware/error.middleware';

import { AccountLockedError, lockoutKey } from './lockout';
import {
  clearLockout,
  deleteStaleLockouts,
  recordLoginFailure,
  selectActiveLock,
} from './lockout.query';

// A fresh random key per test case (`loginLockouts.keyHash` is the primary
// key, so cases must not collide). Unrelated to `lockoutKey`'s own formula,
// which is exercised separately below.
function randomKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

describe('lockoutKey', () => {
  // Req 3.1 (normalised address), Req 3.6 (one-way hash of that address) —
  // design C3 pins the formula to account-deletion's emailHash.
  it('equals emailHash of a padded, mixed-case address', () => {
    const email = '  TestUser@Example.com  ';
    expect(lockoutKey(email)).toBe(emailHash(email));
  });
});

describe('AccountLockedError', () => {
  // Req 3.4: locked sign-ins answer 429 ACCOUNT_LOCKED with Retry-After and a
  // message that says when to retry, through the existing errorHandler branch
  // for RateLimitError subclasses (error.middleware.ts:11-19).
  it('answers 429 ACCOUNT_LOCKED with Retry-After through errorHandler', async () => {
    const app = new Hono();
    app.get('/t', () => {
      throw new AccountLockedError(900);
    });
    app.onError(errorHandler);

    const res = await app.request('/t');

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('ACCOUNT_LOCKED');
    expect(body.error.message).toBe('Too many failed sign-ins. Try again in 15 minutes.');
  });
});

describe('recordLoginFailure / selectActiveLock', () => {
  // Req 3.3: ten failures inside the window lock the address; the nine
  // before it do not.
  it('nine failures leave no lock; the tenth locks with lockedNow true once', async () => {
    const key = randomKey();

    for (let i = 0; i < 9; i++) {
      const result = await recordLoginFailure(db, key);
      expect(result.lockedNow).toBe(false);
    }
    expect(await selectActiveLock(db, key)).toBeNull();

    const tenth = await recordLoginFailure(db, key);
    expect(tenth.lockedNow).toBe(true);

    const active = await selectActiveLock(db, key);
    expect(active).not.toBeNull();
    expect(active!.lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  // Req 3.3: a window older than 15 minutes restarts the count rather than
  // accumulating indefinitely.
  it('a window moved back past 15 minutes restarts the count at one', async () => {
    const key = randomKey();

    await recordLoginFailure(db, key);
    await recordLoginFailure(db, key);
    await recordLoginFailure(db, key);

    await db
      .update(loginLockouts)
      .set({ windowStartedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(loginLockouts.keyHash, key));

    await recordLoginFailure(db, key);

    const rows = await db.select().from(loginLockouts).where(eq(loginLockouts.keyHash, key));
    expect(rows).toHaveLength(1);
    expect(rows[0].failureCount).toBe(1);
  });

  // Req 3.7: the lock clears once its time passes.
  it('an expired lock reads as none', async () => {
    const key = randomKey();
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(db, key);
    }
    expect(await selectActiveLock(db, key)).not.toBeNull();

    await db
      .update(loginLockouts)
      .set({ lockedUntil: new Date(Date.now() - 60 * 1000) })
      .where(eq(loginLockouts.keyHash, key));

    expect(await selectActiveLock(db, key)).toBeNull();
  });
});

describe('clearLockout', () => {
  // Req 3.7: signing in (or an unlock path) clears the counter and lock.
  it('removes the row', async () => {
    const key = randomKey();
    await recordLoginFailure(db, key);

    await clearLockout(db, key);

    const rows = await db.select().from(loginLockouts).where(eq(loginLockouts.keyHash, key));
    expect(rows).toHaveLength(0);
  });
});

describe('deleteStaleLockouts', () => {
  // Req 3.8/3.10 (sweeper, D15): a row is removed only once BOTH its lock and
  // its failure window have passed — a live lock or a live window survives.
  it('removes only rows whose lock and window have passed', async () => {
    const staleNoLock = randomKey();
    const expiredLock = randomKey();
    const activeLock = randomKey();
    const recentWindow = randomKey();

    // Never locked, but the window is long past 15 minutes old.
    await recordLoginFailure(db, staleNoLock);
    await db
      .update(loginLockouts)
      .set({ windowStartedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(loginLockouts.keyHash, staleNoLock));

    // Was locked, but both the lock and the window are now in the past.
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(db, expiredLock);
    }
    await db
      .update(loginLockouts)
      .set({
        windowStartedAt: new Date(Date.now() - 20 * 60 * 1000),
        lockedUntil: new Date(Date.now() - 10 * 60 * 1000),
      })
      .where(eq(loginLockouts.keyHash, expiredLock));

    // Currently locked: must survive the sweep.
    for (let i = 0; i < 10; i++) {
      await recordLoginFailure(db, activeLock);
    }

    // Not locked, but the window just started: must survive the sweep.
    await recordLoginFailure(db, recentWindow);

    await deleteStaleLockouts(db);

    const remaining = await db
      .select({ keyHash: loginLockouts.keyHash })
      .from(loginLockouts)
      .where(inArray(loginLockouts.keyHash, [staleNoLock, expiredLock, activeLock, recentWindow]));

    expect(remaining.map((r) => r.keyHash).sort()).toEqual([activeLock, recentWindow].sort());
  });
});
