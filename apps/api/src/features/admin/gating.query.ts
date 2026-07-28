import { and, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { advisorImageCounters, advisorTurnCounters } from '@/db/schema';

// ---------------------------------------------------------------------------
// Per-user monthly-counter query layer (admin-platform design Component 7,
// REQ-6.2, REQ-6.7; plan-tiers D11 / REQ-8.3, REQ-8.5, REQ-9.1).
//
// PER-USER-SCOPED functions only — cross-user system queries live exclusively
// in `admin.query.ts` (REQ-1.5 binds those, not these). Type rules
// (structure.md): the write takes `Transaction`; the read accepts
// `Database | Transaction`.
// ---------------------------------------------------------------------------

/**
 * Current UTC calendar-month period key, `'YYYY-MM'` (REQ-6.2/6.8 — pinned:
 * UTC, not user-local; one deterministic boundary for all users). Lives here
 * beside its two consumers (the gate read and the persistTurn increment) —
 * one home, no drift.
 */
export function currentPeriodKeyUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Committed-turn count for the user in the given period — a single PK lookup
 * on `advisor_turn_counters (user_id, period_key)`: O(1), no scan over
 * message history (REQ-6.2/6.7, Performance NFR). A missing row reads as `0`.
 */
export async function getTurnCount(
  db: Database | Transaction,
  userId: string,
  periodKey: string,
): Promise<number> {
  const rows = await db
    .select({ turnCount: advisorTurnCounters.turnCount })
    .from(advisorTurnCounters)
    .where(
      and(eq(advisorTurnCounters.userId, userId), eq(advisorTurnCounters.periodKey, periodKey)),
    )
    .limit(1);
  return rows[0]?.turnCount ?? 0;
}

/**
 * Increment the user's committed-turn counter for the period (REQ-6.2;
 * plan-tiers D11 / REQ-8.3 — PLATFORM turns only from plan-tiers on; the sole
 * caller is `persistTurn`'s billing block). `INSERT … ON CONFLICT (user_id,
 * period_key) DO UPDATE` performs the read-modify-write inside the
 * index-locked upsert, so concurrent turn commits serialize on the counter
 * row and no increment is lost. When `allowance` is set the SAME upsert also
 * increments `allowance_turns` (a within-allowance subsidized platform turn,
 * REQ-8.5) — one statement sets both columns. No decrement/delete path exists
 * anywhere (non-evasion).
 */
export async function incrementTurnCounter(
  tx: Transaction,
  userId: string,
  periodKey: string,
  opts: { allowance: boolean },
): Promise<void> {
  const allowanceDelta = opts.allowance ? 1 : 0;
  await tx
    .insert(advisorTurnCounters)
    .values({ userId, periodKey, turnCount: 1, allowanceTurns: allowanceDelta })
    .onConflictDoUpdate({
      target: [advisorTurnCounters.userId, advisorTurnCounters.periodKey],
      set: {
        turnCount: sql`${advisorTurnCounters.turnCount} + 1`,
        allowanceTurns: sql`${advisorTurnCounters.allowanceTurns} + ${allowanceDelta}`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Committed within-allowance platform-turn count for the user in the given
 * period (plan-tiers D10/D11) — a single PK lookup reading the committed
 * `allowance_turns` column. A missing row reads as `0`. The allowance
 * eligibility read; the REQ-8.7 overshoot posture applies (in-flight turns
 * may pass).
 */
export async function getAllowanceUsage(
  db: Database | Transaction,
  userId: string,
  periodKey: string,
): Promise<number> {
  const rows = await db
    .select({ allowanceTurns: advisorTurnCounters.allowanceTurns })
    .from(advisorTurnCounters)
    .where(
      and(eq(advisorTurnCounters.userId, userId), eq(advisorTurnCounters.periodKey, periodKey)),
    )
    .limit(1);
  return rows[0]?.allowanceTurns ?? 0;
}

/**
 * Increment the user's committed image counter for the period by `count`
 * (plan-tiers REQ-9.1 — ALL credential sources, BYOK included; called from
 * `persistTurn`'s inserted branch only, so deduped replays never
 * double-count). Same serialized-upsert pattern as the turn counter; no
 * decrement/delete path (non-evasion). Lock order: acquired beside the turn
 * counter, BEFORE any `wallets` FOR UPDATE lock (structure.md).
 */
export async function incrementImageCounter(
  tx: Transaction,
  userId: string,
  periodKey: string,
  count: number,
): Promise<void> {
  await tx
    .insert(advisorImageCounters)
    .values({ userId, periodKey, imageCount: count })
    .onConflictDoUpdate({
      target: [advisorImageCounters.userId, advisorImageCounters.periodKey],
      set: {
        imageCount: sql`${advisorImageCounters.imageCount} + ${count}`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Committed image count for the user in the given period (plan-tiers REQ-9.1)
 * — a single PK lookup on `advisor_image_counters`. A missing row reads as `0`.
 */
export async function getImageCount(
  db: Database | Transaction,
  userId: string,
  periodKey: string,
): Promise<number> {
  const rows = await db
    .select({ imageCount: advisorImageCounters.imageCount })
    .from(advisorImageCounters)
    .where(
      and(eq(advisorImageCounters.userId, userId), eq(advisorImageCounters.periodKey, periodKey)),
    )
    .limit(1);
  return rows[0]?.imageCount ?? 0;
}
