import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Transaction } from '@/db';
import { withTransaction } from '@/lib/transaction';

import { refreshDbMetrics, resetDbProbeStateForTests } from './metrics.collectors';
import { dbConnections, dbProbeDuration, dbUp, registry } from './metrics.registry';

/**
 * The ONLY seam. Deliberately NOT `vi.mock('@/db')`: `test-setup.ts` is the api
 * project's `setupFiles` entry, it already mocks `@/db`, and it reassigns `db`
 * to a live drizzle `Transaction` in every `beforeEach` — AFTER any per-file
 * mock. A per-file `@/db` mock is therefore silently replaced and the
 * "rejects" / "never settles" cases would quietly run real queries against
 * `pg_stat_activity`, passing or failing for the wrong reason.
 *
 * For the same reason nothing here spies on `db.transaction`: by test time that
 * is the live `PgTransaction` `test-setup.ts` installed, whose nested
 * `.transaction()` issues a SAVEPOINT rather than a BEGIN.
 *
 * `@/lib/transaction` is a bare passthrough that `test-setup.ts` never touches.
 */
vi.mock('@/lib/transaction', () => ({ withTransaction: vi.fn() }));

const withTransactionMock = vi.mocked(withTransaction);

const dialect = new PgDialect();

/** Render a drizzle `sql` template the way Postgres would receive it. */
function render(query: unknown): string {
  return dialect.sqlToQuery(query as SQL).sql;
}

/** The same, collapsed to single spaces, so the assertions are not formatting-brittle. */
function renderNormalized(query: unknown): string {
  return render(query).replace(/\s+/g, ' ').trim();
}

type StateRow = { state: string | null; count: number };
type ProbeResult = { durationSeconds: number; rows: StateRow[] };

/**
 * Postgres's OWN vocabulary, verified against a live server below — NOT the
 * emitted label spelling. `pg_stat_activity.state` is `idle in transaction`,
 * three words with spaces; the collector translates that to the
 * `idle_in_transaction` LABEL.
 *
 * These two spellings were once the same string in both the fixture and the
 * code, which is exactly why the mismatch survived: the fixture asserted the
 * code's assumption rather than Postgres's behaviour, so every case passed
 * while the shipped series reported 0 forever.
 */
const HEALTHY_ROWS: StateRow[] = [
  { state: 'active', count: 1 },
  { state: 'idle', count: 2 },
  { state: 'idle in transaction', count: 3 },
];

/**
 * Deferreds created by a case, so `afterEach` can settle every one of them.
 * A probe that never settles never clears the single-flight handle.
 */
const pendingSettlers: Array<() => void> = [];

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pendingSettlers.push(() => reject(new Error('__afterEach_settle__')));
  return { promise, resolve };
}

/**
 * Make `withTransaction` actually RUN the collector's callback against a fake
 * transaction whose `execute` is a spy. A plain `mockResolvedValue({...})`
 * never runs the callback, so nothing would notice if the `SET LOCAL` were
 * dropped.
 */
function stubTransaction(rows: StateRow[]): { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn();
  execute.mockResolvedValueOnce([]); // SET LOCAL statement_timeout
  execute.mockResolvedValueOnce([{ ok: 1 }]); // SELECT 1
  execute.mockResolvedValueOnce(rows); // pg_stat_activity aggregate

  withTransactionMock.mockImplementation(async (_db, callback) =>
    callback({ execute } as unknown as Transaction),
  );

  return { execute };
}

async function readUp(): Promise<number | undefined> {
  return (await dbUp.get()).values[0]?.value;
}

async function readProbeDuration(): Promise<number | undefined> {
  return (await dbProbeDuration.get()).values[0]?.value;
}

async function readConnections(): Promise<Array<{ state: string; value: number }>> {
  const { values } = await dbConnections.get();
  return values.map((v) => ({ state: String(v.labels.state), value: v.value }));
}

/**
 * Drive ONE successful probe, and assert it landed.
 *
 * Every failure case must start here. `prom-client` seeds a label-free gauge to
 * `0` at construction and a labelled one to `values: []`, so `tradr_db_up 0`
 * with zero `tradr_db_connections` samples is EXACTLY the state of a registry
 * the collector has never run against — an empty `refreshDbMetrics()` body
 * satisfies every failure assertion written the naive way. Only the transition
 * is evidence.
 */
async function driveSuccessfulProbe(): Promise<void> {
  stubTransaction(HEALTHY_ROWS);
  await refreshDbMetrics();

  expect(await readUp()).toBe(1);
  expect(await readConnections()).toHaveLength(3);

  withTransactionMock.mockReset();
}

beforeEach(() => {
  withTransactionMock.mockReset();
  resetDbProbeStateForTests();
  registry.resetMetrics();
});

afterEach(async () => {
  // Settle every deferred the case created — the deadline case's probe by
  // definition never settles, which would otherwise wedge the single-flight
  // handle for the rest of the file — then flush the microtasks its `.finally`
  // runs on.
  for (const settle of pendingSettlers.splice(0)) settle();
  await Promise.resolve();
  await Promise.resolve();

  // Leaving fake timers installed can also hang `test-setup.ts`'s `sql.end()`.
  vi.useRealTimers();
  resetDbProbeStateForTests();
});

describe('refreshDbMetrics (REQ-4)', () => {
  it('flips a healthy probe to tradr_db_up 0 with no connection samples when it rejects', async () => {
    await driveSuccessfulProbe();

    withTransactionMock.mockRejectedValue(new Error('CONNECTION_ENDED'));
    await expect(refreshDbMetrics()).resolves.toBeUndefined();

    expect(await readUp()).toBe(0);
    expect(await readConnections()).toHaveLength(0);
  });

  it('trips the 5000 ms deadline when the probe never settles and lands on the same failure path', async () => {
    await driveSuccessfulProbe();

    const stuck = createDeferred<ProbeResult>();
    withTransactionMock.mockReturnValue(stuck.promise);

    vi.useFakeTimers();
    const scrape = refreshDbMetrics();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(scrape).resolves.toBeUndefined();

    expect(await readUp()).toBe(0);
    expect(await readConnections()).toHaveLength(0);
  });

  it('joins an in-flight probe and PUBLISHES its result, taking tradr_db_up 0 → 1', async () => {
    // The one shape that can fail. Asserting only the call count, or asserting
    // the exposition after both callers succeed, proves nothing: join-and-
    // publish and join-and-return produce byte-identical output there, because
    // the starter writes the values the joiner would. So the starter must
    // already have TIMED OUT when the probe lands.
    await driveSuccessfulProbe();

    const probe = createDeferred<ProbeResult>();
    withTransactionMock.mockReturnValue(probe.promise);
    vi.useFakeTimers();

    const starter = refreshDbMetrics(); // t=0, its deadline fires at t=5000
    await vi.advanceTimersByTimeAsync(1000);
    const joiner = refreshDbMetrics(); // t=1000, its own deadline is t=6000

    expect(withTransactionMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4000); // t=5000 — the STARTER's deadline
    await starter;
    expect(await readUp()).toBe(0);

    probe.resolve({ durationSeconds: 0.25, rows: HEALTHY_ROWS });
    await joiner;

    // Under join-and-return this stays 0.
    expect(await readUp()).toBe(1);
    expect(await readConnections()).toHaveLength(3);
    // …and the joiner published the duration THAT probe measured, not its own.
    expect(await readProbeDuration()).toBe(0.25);
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('does not open a second transaction for a caller arriving AFTER the starter’s deadline fired', async () => {
    // The pool-orphan property, and the ONLY case that can see it. The handle
    // must clear from the PROBE promise's settlement, never from the race's:
    // the starter's race settles at its 5000 ms deadline while the probe still
    // holds a reserved connection, so clearing there lets the next scrape open
    // a second one — and every scrape after that another, until DB_POOL_SIZE is
    // exhausted and the application's own request path blocks. Case 3 cannot
    // catch it: its joiner arrives at t=1000, before any race has settled, so
    // both readings join. Only a caller entering after the starter timed out
    // and while the probe is still unsettled distinguishes them.
    await driveSuccessfulProbe();

    const probe = createDeferred<ProbeResult>();
    withTransactionMock.mockReturnValue(probe.promise);
    vi.useFakeTimers();

    const starter = refreshDbMetrics(); // t=0, deadline t=5000
    await vi.advanceTimersByTimeAsync(5000); // the STARTER's deadline fires
    await starter;
    expect(await readUp()).toBe(0);

    // The probe is STILL unsettled — its connection is still reserved.
    const late = refreshDbMetrics();

    // 1 under the correct implementation (the late caller joined); 2 if the
    // handle was cleared from the race, i.e. a second orphaned connection.
    expect(withTransactionMock).toHaveBeenCalledTimes(1);

    probe.resolve({ durationSeconds: 0.5, rows: HEALTHY_ROWS });
    await late;

    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    // The late caller joined AND published: 0 → 1, with that probe's duration.
    expect(await readUp()).toBe(1);
    expect(await readProbeDuration()).toBe(0.5);
    expect(await readConnections()).toHaveLength(3);
  });

  it('issues SET LOCAL statement_timeout = 1000 as the transaction’s first statement', async () => {
    // The only coverage the server-side half of REQ-4.8 gets. Without it,
    // dropping the statement — or writing it as a session-level SET, which
    // leaks the GUC onto a pooled connection — would red nothing.
    const { execute } = stubTransaction(HEALTHY_ROWS);
    await refreshDbMetrics();

    expect(render(execute.mock.calls[0]?.[0])).toBe('SET LOCAL statement_timeout = 1000');
    expect(await readUp()).toBe(1);
  });

  it('issues the pg_stat_activity aggregate with the ::int cast and GROUP BY state', async () => {
    // The whole aggregate, not just its WHERE clause. `GROUP BY state` is what
    // makes the row set per-state at all, and the `::int` cast is what stops
    // Postgres returning `count(*)` as a bigint — which `postgres.js` delivers
    // as a STRING, so `dbConnections.set()` throws on a non-number and EVERY
    // scrape reports `tradr_db_up 0` for a perfectly healthy database.
    const { execute } = stubTransaction(HEALTHY_ROWS);
    await refreshDbMetrics();

    expect(renderNormalized(execute.mock.calls[2]?.[0])).toBe(
      'SELECT state, count(*)::int AS count FROM pg_stat_activity ' +
        'WHERE datname = current_database() GROUP BY state',
    );
    expect(await readUp()).toBe(1);
  });

  it('does not let a late-resolving abandoned probe overwrite the failure values', async () => {
    await driveSuccessfulProbe();

    const abandoned = createDeferred<ProbeResult>();
    withTransactionMock.mockReturnValue(abandoned.promise);

    vi.useFakeTimers();
    const scrape = refreshDbMetrics();
    await vi.advanceTimersByTimeAsync(5000);
    await scrape;

    expect(await readUp()).toBe(0);
    const failureDuration = await readProbeDuration();

    abandoned.resolve({ durationSeconds: 42, rows: HEALTHY_ROWS });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(await readUp()).toBe(0);
    expect(await readConnections()).toHaveLength(0);
    expect(await readProbeDuration()).toBe(failureDuration);
    expect(await readProbeDuration()).not.toBe(42);
  });

  it('bounds the label set to the three enumerated states, dropping unexpected and NULL states', async () => {
    stubTransaction([
      { state: 'active', count: 3 },
      { state: 'fastpath function call', count: 7 },
      { state: null, count: 11 },
      { state: 'disabled', count: 13 },
      { state: 'idle', count: 4 },
      { state: 'idle in transaction', count: 1 },
    ]);
    await refreshDbMetrics();

    expect(await readConnections()).toEqual([
      { state: 'active', value: 3 },
      { state: 'idle', value: 4 },
      { state: 'idle_in_transaction', value: 1 },
    ]);
  });

  it('maps Postgres’s "idle in transaction" (SPACES) onto the idle_in_transaction label', async () => {
    // The regression this file previously could not see. The collector once
    // looked its states up by the LABEL spelling, so this row — the literal
    // string a real Postgres returns — matched nothing and the series read 0
    // forever, hiding the pool-exhaustion precursor REQ-4 exists to surface.
    //
    // Asserted as a literal, and deliberately NOT re-derived from the
    // collector's own mapping table: comparing the output against the table
    // that produced it would pass for any spelling at all, which is precisely
    // the fixture-shares-the-bug failure that let this ship.
    stubTransaction([{ state: 'idle in transaction', count: 9 }]);
    await refreshDbMetrics();

    expect(await readConnections()).toEqual([
      { state: 'active', value: 0 },
      { state: 'idle', value: 0 },
      { state: 'idle_in_transaction', value: 9 },
    ]);
  });

  it('folds "idle in transaction (aborted)" into the same label by SUMMING, not overwriting', async () => {
    // The stated choice: an aborted-but-open transaction reserves its backend
    // and pins the xmin horizon exactly as a live one does, so it is the same
    // saturation signal and is counted. Because the mapping is many-to-one, the
    // two rows must ACCUMULATE — a plain assignment would silently drop
    // whichever arrived first and under-report by that amount.
    stubTransaction([
      { state: 'idle in transaction', count: 2 },
      { state: 'idle in transaction (aborted)', count: 5 },
    ]);
    await refreshDbMetrics();

    expect(await readConnections()).toEqual([
      { state: 'active', value: 0 },
      { state: 'idle', value: 0 },
      { state: 'idle_in_transaction', value: 7 },
    ]);
  });

  it('defaults a state the query returned no row for to 0', async () => {
    stubTransaction([{ state: 'active', count: 5 }]);
    await refreshDbMetrics();

    expect(await readConnections()).toEqual([
      { state: 'active', value: 5 },
      { state: 'idle', value: 0 },
      { state: 'idle_in_transaction', value: 0 },
    ]);
  });
});

/**
 * The vocabulary check that no hand-written fixture can give.
 *
 * Every case above still feeds the collector strings THIS FILE typed. That is
 * the shape of the original defect: the fixture and the code shared one wrong
 * assumption about what Postgres returns, so the suite was green while the
 * shipped metric read 0. Re-typing the strings correctly fixes today's bug and
 * leaves tomorrow's — nothing here is anchored to the database.
 *
 * So this case never writes a state string down. It parks two real backends in
 * the two transaction states on a dedicated connection, asks Postgres what it
 * calls them, and feeds THOSE strings to the collector. If Postgres's spelling
 * ever differs from the collector's table — today's underscore bug, a future
 * rename, a fixture retyped wrong — this reds and the others do not.
 *
 * Deterministic, not timing-dependent: the states are created by this test
 * rather than observed ambiently, and the lookup is by `pid`, so a concurrent
 * worker's connections cannot influence it. The short retry covers only the one
 * documented race — Postgres marks a backend idle just AFTER it flushes
 * ReadyForQuery, so the client can observe itself a few microseconds early.
 */
describe('pg_stat_activity vocabulary (live database)', () => {
  const DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/tradr_test';

  it('maps the state strings Postgres ITSELF reports, not ones this file wrote', async () => {
    // `max: 3` — two parked backends plus the observer. Its own client, never
    // the shared test connection, which is inside test-setup.ts's per-test
    // transaction and would deadlock on itself.
    const client = postgres(DATABASE_URL, { max: 3 });

    const release: Array<() => void> = [];
    const parked: Array<Promise<unknown>> = [];

    /** Park a backend inside a transaction and hand back the pid Postgres gave it. */
    async function park(abort: boolean): Promise<number> {
      let ready!: (pid: number) => void;
      const pidReady = new Promise<number>((resolve) => (ready = resolve));

      parked.push(
        client
          .begin(async (tx) => {
            // `.unsafe()`, not the template tag: postgres.js declares
            // `TransactionSql` as `Omit<Sql, …>`, and `Omit` strips an
            // interface's CALL signature, so `tx` type-checks as non-callable
            // even though it works at runtime. No interpolation happens here.
            const [row] = await tx.unsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            // Poison the transaction so Postgres reports the ABORTED variant.
            if (abort) await tx.unsafe('SELECT 1 / 0').catch(() => undefined);
            ready(row!.pid);
            await new Promise<void>((resolve) => release.push(resolve));
          })
          .catch(() => undefined),
      );

      return pidReady;
    }

    try {
      const idlePid = await park(false);
      const abortedPid = await park(true);

      /** What Postgres calls this backend right now, once it has gone idle. */
      async function stateOf(pid: number): Promise<string> {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const [row] = await client<Array<{ state: string | null }>>`
            SELECT state FROM pg_stat_activity WHERE pid = ${pid}`;
          if (row?.state != null && row.state !== 'active') return row.state;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`backend ${pid} never reported a settled state`);
      }

      const idleState = await stateOf(idlePid);
      const abortedState = await stateOf(abortedPid);

      // Guard the guard: if these ever came back equal, or as the label
      // spelling, the case below would prove nothing.
      expect(idleState).not.toBe(abortedState);
      expect(idleState).not.toContain('_');

      // Postgres's strings, straight into the collector. Counts are arbitrary
      // and distinct so a fold that overwrites rather than sums is visible.
      stubTransaction([
        { state: idleState, count: 4 },
        { state: abortedState, count: 3 },
      ]);
      await refreshDbMetrics();

      expect(await readConnections()).toEqual([
        { state: 'active', value: 0 },
        { state: 'idle', value: 0 },
        { state: 'idle_in_transaction', value: 7 },
      ]);
    } finally {
      for (const resolve of release) resolve();
      await Promise.all(parked);
      await client.end({ timeout: 5 });
    }
  });
});
