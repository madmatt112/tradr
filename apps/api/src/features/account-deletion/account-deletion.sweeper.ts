import { db } from '@/db';
import { logger } from '@/lib/logger';

import { claimDueSchedules, sweepStaleSchedules } from './account-deletion.query';
import { fireScheduledDeletion } from './account-deletion.service';

// ---------------------------------------------------------------------------
// The deletion sweeper (design C6). An in-process timer — no worker, no extra
// container (D3) — that each tick releases rows a crash left mid-flight, claims
// due schedules with a lease, and fires each. It reaches users who never return
// and is safe across machines: the claim is a `FOR UPDATE SKIP LOCKED` batch, so
// concurrent sweepers take disjoint work.
//
// TIME NOTE (probe /tmp/scratchpad/acct-del-now-probe.sh): inside one transaction
// `now()` is frozen at the transaction start, so the query layer takes `now` as a
// parameter. `runDeletionSweep` passes one wall-clock instant to every query in
// the run, and a test can drive due-at, lease and overdue comparisons at a chosen
// instant.
// ---------------------------------------------------------------------------

/** Tick interval: every 10 minutes (design C6). */
export const DELETION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Claim lease: 15 minutes. A `firing` row whose lease expired is re-claimable. */
export const DELETION_LEASE_MS = 15 * 60 * 1000;

/** How many due rows one tick claims and fires. */
export const DELETION_SWEEP_BATCH = 20;

/** Warn when a claimed row's `due_at` is over 60 minutes old (an overdue fire). */
export const DELETION_OVERDUE_WARN_MS = 60 * 60 * 1000;

export type SweepResult = {
  /** User ids of stale `pending` rows the run deleted. */
  pendingDeleted: string[];
  /** User ids of stale `cancelling` rows the run reverted to `scheduled`. */
  cancellingReverted: string[];
  /** User ids of the due rows the run claimed and fired. */
  fired: string[];
};

/**
 * One sweep pass at wall-clock `now` (design C6): release stale rows (warn per
 * row), claim the due batch, then fire each claimed row. `fireScheduledDeletion`
 * never throws, so one failing row never stops the batch. Returns the ids touched
 * in each phase so a caller (and a test) can assert the run.
 */
export async function runDeletionSweep(now = new Date()): Promise<SweepResult> {
  const stale = await sweepStaleSchedules(db, now, DELETION_LEASE_MS);
  for (const userId of stale.pendingDeleted) {
    logger.warn('swept a stale pending account-deletion schedule', { userId });
  }
  for (const userId of stale.cancellingReverted) {
    logger.warn('reverted a stale cancelling account-deletion schedule to scheduled', { userId });
  }

  const due = await claimDueSchedules(db, now, DELETION_LEASE_MS, DELETION_SWEEP_BATCH);
  const fired: string[] = [];
  for (const row of due) {
    if (now.getTime() - row.dueAt.getTime() > DELETION_OVERDUE_WARN_MS) {
      logger.warn('firing an overdue scheduled account deletion', {
        userId: row.userId,
        dueAt: row.dueAt.toISOString(),
      });
    }
    await fireScheduledDeletion(row);
    fired.push(row.userId);
  }

  return {
    pendingDeleted: stale.pendingDeleted,
    cancellingReverted: stale.cancellingReverted,
    fired,
  };
}

/**
 * Start the sweeper (design C6): an immediate first run, then one every
 * `intervalMs`. The timer is `unref`'d so it never holds the process open, and an
 * in-process flag skips a tick while the previous one is still running. `main()`
 * calls this after `bootstrap()`; `stop()` clears the timer during shutdown,
 * before the pool is torn down. A tick's own failure is logged, never thrown.
 */
export function startDeletionSweeper(intervalMs = DELETION_SWEEP_INTERVAL_MS): { stop(): void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // an earlier tick is still in flight — skip this one
    running = true;
    try {
      await runDeletionSweep();
    } catch (err) {
      logger.error('account-deletion sweep failed', {
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
