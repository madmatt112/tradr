import { db } from '@/db';
import { logger } from '@/lib/logger';

import { deleteStaleLockouts } from './lockout.query';
import { deleteDeadLoginChallenges } from './two-factor.query';

// ---------------------------------------------------------------------------
// The auth-lockout/challenge sweeper (design C16/D15). An in-process timer — the
// `startDeletionSweeper` precedent (account-deletion.sweeper.ts) — that each tick
// removes `login_lockouts` rows whose lock and window have both passed (Req 3.10)
// and `login_challenges` rows that are consumed or expired. Both deletes only
// reclaim rows the live paths already ignore, so a tick is safe to repeat and
// safe to skip.
// ---------------------------------------------------------------------------

/** Tick interval: every 15 minutes (design D15). */
export const AUTH_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * One sweep pass: drop stale locks and dead challenges (design C16/D15). Kept
 * separate from the timer so a test can drive it directly.
 */
export async function runAuthSweep(): Promise<void> {
  await deleteStaleLockouts(db);
  await deleteDeadLoginChallenges(db);
}

/**
 * Start the sweeper (design C16/D15): an immediate first run, then one every
 * `intervalMs`. The timer is `unref`'d so it never holds the process open, and an
 * in-process flag skips a tick while the previous one is still running. `main()`
 * starts it beside the deletion sweeper; `stop()` clears the timer during
 * shutdown, before the pool is torn down. A tick's own failure is logged, never
 * thrown.
 */
export function startAuthSweeper(intervalMs = AUTH_SWEEP_INTERVAL_MS): { stop(): void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // an earlier tick is still in flight — skip this one
    running = true;
    try {
      await runAuthSweep();
    } catch (err) {
      logger.error('auth lockout/challenge sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  void tick(); // immediate first run
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
