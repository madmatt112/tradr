import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { withTransaction } from '@/lib/transaction';

import { dbConnections, dbProbeDuration, dbUp } from './metrics.registry';

/**
 * Scrape-time database sampling (REQ-4).
 *
 * `refreshDbMetrics()` is awaited by the `/metrics` handler before
 * serialization, so every scrape is an active database probe (REQ-4.9) — one
 * round trip, one timeout to reason about, rather than three independent
 * `prom-client` `collect()` hooks interleaving unpredictably.
 *
 * It NEVER throws. Every failure — a rejection, a dead socket, a database that
 * simply stops answering — lands on the same path: `tradr_db_up 0`, the elapsed
 * time, and a reset connection gauge.
 */

/**
 * The single authoritative ceiling on the whole scrape, client-side.
 *
 * This is deliberately NOT "the sum of the statement timeouts". `SET LOCAL
 * statement_timeout` binds only statements issued *after* it, so `BEGIN` and
 * the `SET LOCAL` itself run unbounded and the five-statement total is not a
 * bounded quantity. What `statement_timeout = 1000` gives is a 2 s bounded term
 * covering the only two statements that do real work; the remaining ~3 s of
 * this deadline is slack for `BEGIN`, `SET LOCAL`, `COMMIT` and five round
 * trips.
 *
 * 5000 ms is half of Prometheus's default 10 s `scrape_timeout`, so the scrape
 * reports a down database rather than timing out. This is a failure-path
 * ceiling only — the normal probe is well under 100 ms.
 */
const PROBE_DEADLINE_MS = 5000;

/**
 * The bounded label set (REQ-8.2). Enumerated explicitly and NEVER pivoted from
 * whatever `pg_stat_activity` returns: `state` is also `fastpath function
 * call`, `disabled`, or `NULL`, any of which would add unplanned series.
 *
 * These are LABEL values, not Postgres state strings — see `STATE_LABELS`.
 */
const CONNECTION_STATES = ['active', 'idle', 'idle_in_transaction'] as const;

type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * Postgres `pg_stat_activity.state` string → emitted `state` label value.
 *
 * The KEYS are Postgres's own vocabulary, which spells the transaction states
 * with SPACES and no parenthetical-free shorthand: `idle in transaction`, not
 * `idle_in_transaction`. Keying the lookup on the underscored label is the bug
 * this table exists to prevent — it matches nothing, so the series reports 0
 * forever and pool exhaustion stays invisible, which is precisely what REQ-4
 * exists to surface.
 *
 * The VALUES are the bounded label set above, which REQ-8.2 specifies and both
 * the `# HELP` text and the operator docs describe. The mapping is deliberately
 * many-to-one, so the label contract never has to follow Postgres's spelling.
 *
 * `idle in transaction (aborted)` is FOLDED IN rather than excluded or given a
 * fourth label. It is a distinct real state, and this is a stated choice: an
 * aborted-but-open transaction reserves its backend and holds back the xmin
 * horizon exactly as a live one does, so it is the same pool-saturation signal —
 * arguably the worse half of it, since it can never do useful work. Excluding it
 * would rebuild the blind spot one level down; a fourth label would break the
 * three-value contract already published in the help text and the docs. Folding
 * keeps the label set bounded at exactly three.
 *
 * Every other state Postgres can report — `fastpath function call`, `disabled`,
 * and `NULL` — is absent from this table and therefore contributes no series.
 */
const STATE_LABELS = new Map<string, ConnectionState>([
  ['active', 'active'],
  ['idle', 'idle'],
  ['idle in transaction', 'idle_in_transaction'],
  ['idle in transaction (aborted)', 'idle_in_transaction'],
]);

/** One `pg_stat_activity` group. `state` is nullable in Postgres. */
type StateRow = { state: string | null; count: number };

type ProbeResult = { durationSeconds: number; rows: StateRow[] };

/**
 * The single-flight handle: the in-flight probe, or null.
 *
 * This is what bounds the POOL. Without it the client-side deadline below still
 * makes the scrape succeed, so Prometheus keeps its schedule and each scrape
 * orphans another reserved connection until `DB_POOL_SIZE` is exhausted and the
 * application blocks. `postgres.js` cancels its idle timer once `BEGIN`
 * executes, so a JS race alone cannot reclaim them. With the handle, at most
 * one connection is ever orphaned however often Prometheus scrapes.
 */
let inFlight: Promise<ProbeResult> | null = null;

/**
 * One transaction: bound it server-side, probe liveness, then sample state.
 *
 * `SET LOCAL` (never a session-level `SET`) so the GUC auto-cleans on
 * COMMIT/ROLLBACK and the pooled connection returns clean — the
 * `advisor/persistence.ts` idiom. A session-level `SET` would leak the timeout
 * across every later borrower of that connection.
 *
 * `start` is captured OUTSIDE the callback and the elapsed time computed
 * inside, so the reported duration covers the `BEGIN` and the `SET LOCAL` as
 * well. Nothing here writes a gauge: the caller does that, from the race's
 * result.
 */
async function runProbe(): Promise<ProbeResult> {
  const start = performance.now();

  return withTransaction(db, async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 1000`);
    await tx.execute(sql`SELECT 1`);
    const durationSeconds = (performance.now() - start) / 1000;

    const rows = await tx.execute<StateRow>(
      sql`SELECT state, count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() GROUP BY state`,
    );

    return { durationSeconds, rows: [...rows] };
  });
}

function startProbe(): Promise<ProbeResult> {
  const probe = runProbe();
  inFlight = probe;

  // The handle clears from the PROBE's settlement, never the race's: a caller
  // whose deadline fired has abandoned a probe that is still holding a
  // connection, and clearing the handle there would let the next scrape open a
  // second one. The trailing catch keeps a late rejection from surfacing as an
  // unhandled rejection once every racing caller has already settled.
  void probe
    .finally(() => {
      if (inFlight === probe) inFlight = null;
    })
    .catch(() => {
      /* published as tradr_db_up 0 by whichever caller was racing it */
    });

  return probe;
}

/**
 * Sample the database into `tradr_db_up`, `tradr_db_probe_duration_seconds` and
 * `tradr_db_connections`. Never throws.
 *
 * A caller that finds a probe already in flight JOINS it — it never opens a
 * second transaction — and on success publishes THAT probe's result, including
 * the duration that probe measured. Joining and returning silently would leave
 * the previous scrape's values in place for an unbounded number of scrapes and,
 * on the very first concurrent pair, republish the constructor's zero-seeded
 * `tradr_db_up 0` for a perfectly healthy database.
 *
 * Every gauge write happens from the race's RESULT, never inside the
 * transaction callback. A callback that writes gauges would, when its
 * transaction is abandoned and finally answers minutes later, set
 * `tradr_db_up 1` against a database that is down — and could land between a
 * later scrape's `reset()` and serialization, producing `tradr_db_up 1` with no
 * `tradr_db_connections` samples at all, a combination REQ-4.7's doctrine does
 * not define.
 */
export async function refreshDbMetrics(): Promise<void> {
  const start = performance.now();
  const probe = inFlight ?? startProbe();

  // The joiner's deadline is measured from its OWN entry, so no caller ever
  // waits longer than the ceiling.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database probe exceeded ${PROBE_DEADLINE_MS}ms`)),
      PROBE_DEADLINE_MS,
    );
  });

  try {
    const result = await Promise.race([probe, deadline]);

    // Translate Postgres's vocabulary into the label set, dropping every state
    // absent from the table (including NULL). ACCUMULATE rather than assign:
    // the mapping is many-to-one, so both idle-in-transaction states land on one
    // label and a plain `set` would silently discard whichever row came first.
    const counts = new Map<ConnectionState, number>();
    for (const row of result.rows) {
      const label = row.state === null ? undefined : STATE_LABELS.get(row.state);
      if (label !== undefined) counts.set(label, (counts.get(label) ?? 0) + row.count);
    }

    dbUp.set(1);
    dbProbeDuration.set(result.durationSeconds);
    dbConnections.reset();
    for (const state of CONNECTION_STATES) {
      dbConnections.set({ state }, counts.get(state) ?? 0);
    }
  } catch {
    // REQ-4.6: omit rather than report stale. With `tradr_db_up 0` still
    // present, the absent connection series reads as "database down" —
    // REQ-4.7's disambiguation doctrine.
    dbUp.set(0);
    dbProbeDuration.set((performance.now() - start) / 1000);
    dbConnections.reset();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test-only: drop the single-flight handle.
 *
 * A test that exercises the deadline leaves a probe that never settles, so the
 * handle never clears and every later test in the file would join a dead
 * promise and hang. Same shape as `positions.service.ts`'s
 * `unregisterCloseHook`, which `test-setup.ts` consumes for the same reason.
 */
export function resetDbProbeStateForTests(): void {
  inFlight = null;
}
