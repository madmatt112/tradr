import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import * as dbModule from '@/db';
import type { Database } from '@/db';
import * as schema from '@/db/schema';
import { emailTokens, users } from '@/db/schema';

import * as emailTokensQuery from './email-tokens.query';
import { consumeEmailToken } from './email-tokens.query';
import { issueEmailToken, RESET_TOKEN_TTL_MS } from './email-tokens.service';

/**
 * Committed-data concurrency spec (REQ-4.3, D4/SF-1, REQ-3.5/3.8).
 *
 * The project-wide rollback harness (test-setup.ts) re-points `dbModule.db` at
 * a per-test transaction on a single `max: 1` connection — under it, two
 * "concurrent" calls serialize as savepoints on one session and a 23505 can
 * never fire, so these races MUST run against committed rows over a dedicated
 * multi-connection pool. Every row created here is committed: each test
 * deletes its rows (tokens, then the user) in `finally`, and the pool is
 * `sql.end()`-ed in afterAll.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';

let dedicatedSql: ReturnType<typeof postgres>;
let dedicatedDb: Database;

beforeAll(() => {
  // max: 2 — one connection per racer. The harness's beforeAll (setup files run
  // first) has already migrated the schema on its own connection.
  dedicatedSql = postgres(DATABASE_URL, { max: 2 });
  dedicatedDb = drizzle(dedicatedSql, { schema });
});

afterAll(async () => {
  await dedicatedSql.end();
});

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function createCommittedUser(): Promise<string> {
  const rows = await dedicatedDb
    .insert(users)
    .values({ email: `concurrency-test-${crypto.randomUUID()}@example.com`, passwordHash: 'x' })
    .returning({ id: users.id });
  return rows[0].id;
}

/** Committed rows must not outlive the test: tokens first, then the user. */
async function cleanupCommittedRows(userId: string): Promise<void> {
  await dedicatedDb.delete(emailTokens).where(eq(emailTokens.userId, userId));
  await dedicatedDb.delete(users).where(eq(users.id, userId));
}

describe('email tokens under real concurrency (committed data)', () => {
  // -------------------------------------------------------------------------
  // (1) Consume race (REQ-4.3/D7): two racing completions with the same token
  // — the single conditional UPDATE serializes on the row lock; exactly one
  // gets the row. `consumeEmailToken` takes a caller-supplied Transaction, so
  // no harness escape is needed: each racer runs in its own real transaction
  // on the dedicated pool.
  // -------------------------------------------------------------------------
  it('two concurrent consumes: exactly one wins, the other gets null', async () => {
    const userId = await createCommittedUser();
    try {
      const raw = crypto.randomBytes(32).toString('hex');
      const tokenHash = sha256(raw);
      await dedicatedDb.insert(emailTokens).values({
        userId,
        purpose: 'password_reset',
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });

      // Barrier: both transactions must be OPEN before either UPDATE fires, so
      // the loser genuinely blocks on the winner's row lock and re-evaluates
      // the predicate after its commit — not merely runs after the fact.
      let openCount = 0;
      let releaseBarrier!: () => void;
      const bothOpen = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      const racer = () =>
        dedicatedDb.transaction(async (tx) => {
          openCount += 1;
          if (openCount === 2) releaseBarrier();
          await bothOpen;
          return consumeEmailToken(tx, tokenHash, 'password_reset');
        });

      const results = await Promise.all([racer(), racer()]);

      expect(results.filter((r) => r !== null)).toEqual([{ userId }]);
      expect(results.filter((r) => r === null)).toHaveLength(1);

      // Third read after both racers settled: consumed exactly once.
      const rows = await dedicatedDb
        .select()
        .from(emailTokens)
        .where(eq(emailTokens.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0].consumedAt).not.toBeNull();
    } finally {
      await cleanupCommittedRows(userId);
    }
  });

  // -------------------------------------------------------------------------
  // (2) Issuance race (D4/SF-1): two concurrent issueEmailToken calls for the
  // same (user, purpose). The collision is FORCED, not left to scheduling
  // luck: the query-module spies (the positions.service.test.ts cross-module
  // seam) hold racer A's transaction open after its INSERT until racer B's
  // first-attempt DELETE has run — B's DELETE therefore cannot see A's
  // uncommitted row, so B's INSERT must hit the partial unique index and
  // receive the 23505 once A commits, driving exactly one full retry.
  // -------------------------------------------------------------------------
  it('two concurrent issuances: forced 23505, one retry, one live row survives', async () => {
    const userId = await createCommittedUser();

    // Capture the real implementations BEFORE spying replaces the properties.
    const realInsert = emailTokensQuery.insertEmailToken;
    const realDelete = emailTokensQuery.deleteEmailTokens;

    let insertCalls = 0;
    let deleteCompletions = 0;
    let releaseGate!: () => void;
    const bothFirstDeletesRan = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // Gate on COMPLETION, not call: the query functions return lazy builders,
    // so only "the second DELETE has executed" proves B's snapshot predates
    // A's commit (a call-time gate would leave the vacuous-pass window open).
    const countedDelete = (async (...args: Parameters<typeof realDelete>) => {
      const result = await realDelete(...args);
      deleteCompletions += 1;
      if (deleteCompletions === 2) releaseGate();
      return result;
    }) as unknown as typeof realDelete;

    const gatedInsert = (async (...args: Parameters<typeof realInsert>) => {
      insertCalls += 1;
      const mine = insertCalls;
      const result = await realInsert(...args);
      // First INSERT to complete = racer A: hold its transaction open (inside
      // the service's withTransaction callback, pre-commit) until both
      // first-attempt DELETEs have run.
      if (mine === 1) await bothFirstDeletesRan;
      return result;
    }) as unknown as typeof realInsert;

    const deleteSpy = vi
      .spyOn(emailTokensQuery, 'deleteEmailTokens')
      .mockImplementation(countedDelete);
    const insertSpy = vi
      .spyOn(emailTokensQuery, 'insertEmailToken')
      .mockImplementation(gatedInsert);

    // issueEmailToken closes over @/db's `db` (D13 — the service owns the
    // transaction; no injectable connection). Re-point the mocked module's
    // export at the dedicated multi-connection instance — the exact per-test
    // mutability the harness itself uses (test-setup.ts beforeEach) — and
    // restore it in finally so the harness's afterEach rollback stays coherent.
    const harnessDb = dbModule.db;
    (dbModule as Record<string, unknown>).db = dedicatedDb;

    try {
      const [rawA, rawB] = await Promise.all([
        issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS),
        issueEmailToken(userId, 'password_reset', RESET_TOKEN_TTL_MS),
      ]);

      // Both calls completed without a surfaced error, each returning a token.
      expect(rawA).toMatch(/^[0-9a-f]{64}$/);
      expect(rawB).toMatch(/^[0-9a-f]{64}$/);

      // The conflict path demonstrably ran: two first attempts + exactly one
      // retry of the whole delete+insert (the 23505 loser's fresh transaction).
      expect(insertSpy).toHaveBeenCalledTimes(3);
      expect(deleteSpy).toHaveBeenCalledTimes(3);

      // Third read after both racers settled: exactly one row for the pair —
      // live — and it is one of the two issued tokens (the loser-then-
      // retrier's; the winner's row was deleted by the retry's DELETE).
      const rows = await dedicatedDb
        .select()
        .from(emailTokens)
        .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'password_reset')));
      expect(rows).toHaveLength(1);
      expect(rows[0].consumedAt).toBeNull();
      expect([sha256(rawA), sha256(rawB)]).toContain(rows[0].tokenHash);
    } finally {
      (dbModule as Record<string, unknown>).db = harnessDb;
      insertSpy.mockRestore();
      deleteSpy.mockRestore();
      await cleanupCommittedRows(userId);
    }
  });
});
