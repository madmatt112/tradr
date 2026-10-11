import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { loginChallenges, loginLockouts, users } from '@/db/schema';

import { startAuthSweeper } from './auth.sweeper';
import { LOCKOUT_WINDOW_MS, lockoutKey } from './lockout';

// `startAuthSweeper` is the auth-lockout/challenge analogue of
// `startDeletionSweeper` (account-deletion.sweeper.ts, design C16/D15): an
// in-process timer with an immediate first tick, then one every `intervalMs`.
// These tests drive the real export against real Postgres (the test-setup.ts
// per-test rolled-back transaction) — nothing in auth.sweeper.ts is mocked.

let seq = 0;
const uniq = (tag: string): string => `${tag}-${Date.now()}-${++seq}`;

async function seedUser(): Promise<{ id: string }> {
  const [row] = await db
    .insert(users)
    .values({ email: `${uniq('auth-sweeper')}@example.com`, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id });
  return row;
}

function randomTokenHash(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Poll `check` until it resolves true, or throw after `timeoutMs`. The
 * sweeper's first tick is fire-and-forget (`void tick()`): `startAuthSweeper`
 * returns before it settles, so observing its effect means waiting for it.
 */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for the auth sweeper tick');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startAuthSweeper — one tick', () => {
  /**
   * Contract:
   * - Pre-condition: one `login_lockouts` row whose lock and window have both
   *   passed (stale) and one whose lock is still in the future (live); one
   *   `login_challenges` row that is expired, one that is already consumed
   *   (both dead), and one that is unconsumed and unexpired (live).
   * - Test: `startAuthSweeper(60_000)`, waiting for the tick's effect.
   * - Observable result: the stale lock row and both dead challenge rows are
   *   gone; the live lock row and the live challenge row remain.
   * - Source of expected value: design C16/D15 ("deletes stale locks ... and
   *   challenges that are consumed or expired") and REQ-3.10 ("remove lockout
   *   rows whose lock and window have passed").
   */
  it('removes a stale lock and a dead challenge, keeps a live lock and a live challenge', async () => {
    const now = Date.now();
    const staleKey = lockoutKey(`${uniq('stale')}@example.com`);
    const liveKey = lockoutKey(`${uniq('live')}@example.com`);

    await db.insert(loginLockouts).values([
      {
        keyHash: staleKey,
        failureCount: 3,
        windowStartedAt: new Date(now - LOCKOUT_WINDOW_MS - 60_000),
        lockedUntil: new Date(now - 60_000),
      },
      {
        keyHash: liveKey,
        failureCount: 10,
        windowStartedAt: new Date(now),
        lockedUntil: new Date(now + 10 * 60_000),
      },
    ]);

    const user = await seedUser();
    const [expiredChallenge] = await db
      .insert(loginChallenges)
      .values({
        userId: user.id,
        tokenHash: randomTokenHash(),
        expiresAt: new Date(now - 60_000),
      })
      .returning({ id: loginChallenges.id });
    const [consumedChallenge] = await db
      .insert(loginChallenges)
      .values({
        userId: user.id,
        tokenHash: randomTokenHash(),
        expiresAt: new Date(now + 5 * 60_000),
        consumedAt: new Date(now),
      })
      .returning({ id: loginChallenges.id });
    const [liveChallenge] = await db
      .insert(loginChallenges)
      .values({
        userId: user.id,
        tokenHash: randomTokenHash(),
        expiresAt: new Date(now + 5 * 60_000),
      })
      .returning({ id: loginChallenges.id });

    const sweeper = startAuthSweeper(60_000);
    try {
      await waitFor(async () => {
        const rows = await db
          .select()
          .from(loginLockouts)
          .where(eq(loginLockouts.keyHash, staleKey));
        return rows.length === 0;
      });

      expect(
        await db.select().from(loginLockouts).where(eq(loginLockouts.keyHash, liveKey)),
      ).toHaveLength(1);

      expect(
        await db.select().from(loginChallenges).where(eq(loginChallenges.id, expiredChallenge.id)),
      ).toHaveLength(0);
      expect(
        await db.select().from(loginChallenges).where(eq(loginChallenges.id, consumedChallenge.id)),
      ).toHaveLength(0);
      expect(
        await db.select().from(loginChallenges).where(eq(loginChallenges.id, liveChallenge.id)),
      ).toHaveLength(1);
    } finally {
      sweeper.stop();
    }
  });
});

describe('startAuthSweeper — stop()', () => {
  /**
   * Contract:
   * - Pre-condition: a sweeper started with `startAuthSweeper`.
   * - Test: `sweeper.stop()`.
   * - Observable result: `clearInterval` is called exactly once (not at all
   *   before `stop()` runs).
   * - Source of expected value: design C16 ("started and stopped beside the
   *   deletion sweeper"), the `startDeletionSweeper` precedent's `stop()`
   *   (`account-deletion.sweeper.ts:106`, `clearInterval(timer)`).
   */
  it("clears the sweeper's interval timer", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const sweeper = startAuthSweeper(60_000);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    sweeper.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
