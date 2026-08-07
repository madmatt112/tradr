import crypto from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { Database } from '@/db';
import * as schema from '@/db/schema';
import { accounts, fills, ledgerEntries, positions, users } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  postFillLedgerEntries,
} from '@/features/accounting/ledger-hook';
import {
  replaceCloseHook,
  replaceFillHook,
  unregisterCloseHook,
  unregisterFillHook,
} from '@/features/positions/positions.service';

import { seedDemoAccount } from './accounts.demo';
import { createAccount } from './accounts.service';

/**
 * Sample-data / real-account mutual exclusion under REAL concurrency.
 *
 * The rule has two halves — creation refuses while sample data exists, seeding
 * refuses while any account exists — and each half reads what the other writes.
 * Under READ COMMITTED a plain read cannot see the other transaction's
 * uncommitted account row, so without serialization both halves pass their own
 * check and both commit: sample trades then sit inside real aggregates, which
 * nothing filters, by design, and nothing afterwards can separate them out
 * again. So the two paths take a per-user row lock and serialize.
 *
 * The lock is `FOR NO KEY UPDATE`: strong enough that the two paths still block
 * each other, which is what these tests prove, but not so strong that it
 * conflicts with the `FOR KEY SHARE` an ordinary login takes on the same user
 * row while writing its session.
 *
 * The project-wide harness (test-setup.ts) re-points `@/db` at a per-test
 * transaction on a single `max: 1` connection, where two "concurrent" calls
 * become savepoints on one session and no lock can ever be contended. These
 * races therefore run over a dedicated multi-connection pool against committed
 * rows, per the `email-tokens.concurrency.test.ts` precedent — every row is
 * deleted in `finally`, and the pool is `sql.end()`-ed in afterAll.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/tradr_test';

let dedicatedSql: ReturnType<typeof postgres>;
let dedicatedDb: Database;

beforeAll(() => {
  // The seed derives its P&L through the accounting hooks rather than writing
  // it, so the production hooks are installed here — the seed then costs what
  // it costs in production, which is what makes the race window real.
  replaceFillHook('ledger', postFillLedgerEntries);
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);

  // max: 2 — one connection per racer. The harness's beforeAll (setup files run
  // first) has already migrated the schema on its own connection.
  dedicatedSql = postgres(DATABASE_URL, { max: 2 });
  dedicatedDb = drizzle(dedicatedSql, { schema });
});

afterAll(async () => {
  unregisterFillHook('ledger');
  unregisterCloseHook('ledger');
  await dedicatedSql.end();
});

async function createCommittedUser(): Promise<string> {
  const rows = await dedicatedDb
    .insert(users)
    .values({ email: `accounts-race-${crypto.randomUUID()}@example.com`, passwordHash: 'x' })
    .returning({ id: users.id });
  return rows[0].id;
}

/** Committed rows must not outlive the test: children first, then the user. */
async function cleanupCommittedRows(userId: string): Promise<void> {
  const owned = await dedicatedDb
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const accountIds = owned.map((a) => a.id);
  if (accountIds.length > 0) {
    const owis = await dedicatedDb
      .select({ id: positions.id })
      .from(positions)
      .where(inArray(positions.accountId, accountIds));
    const positionIds = owis.map((p) => p.id);
    if (positionIds.length > 0) {
      await dedicatedDb.delete(fills).where(inArray(fills.positionId, positionIds));
    }
    await dedicatedDb.delete(ledgerEntries).where(inArray(ledgerEntries.accountId, accountIds));
    await dedicatedDb.delete(positions).where(inArray(positions.accountId, accountIds));
    await dedicatedDb.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  await dedicatedDb.delete(users).where(eq(users.id, userId));
}

function realAccount(userId: string) {
  return createAccount(
    dedicatedDb,
    userId,
    { name: 'Real Account', currency: 'CAD' },
    { isAdmin: false },
  );
}

/**
 * What the user is left holding. `demo + real` is the state worth failing on:
 * the sample trades are inside the real totals with nothing left to separate
 * them again. (Teardown also leaves the latched display currency alone while a
 * real account survives, but the user can reset that from profile settings, so
 * it is not the half that matters here.)
 */
async function accountKinds(userId: string): Promise<string[]> {
  const rows = await dedicatedDb
    .select({ isDemo: accounts.isDemo })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return rows.map((r) => (r.isDemo ? 'demo' : 'real')).sort();
}

describe('sample data vs real account under real concurrency (committed data)', () => {
  // The ordering the UI makes easy: R9.1 puts "create an account" and "show me
  // sample data" side by side, and the seed's own window is a quarter of a
  // second wide. Creation starts inside it, so its demo-present read runs while
  // the sample account exists but is uncommitted — the exact interleaving that
  // used to let both commit.
  it('seed first, creation into its window: one wins, never both', async () => {
    const userId = await createCommittedUser();
    try {
      const seeding = seedDemoAccount(dedicatedDb, userId);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const creating = realAccount(userId);

      const [seeded, created] = await Promise.allSettled([seeding, creating]);

      expect(await accountKinds(userId)).not.toEqual(['demo', 'real']);
      expect([seeded.status, created.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    } finally {
      await cleanupCommittedRows(userId);
    }
  });

  // The mirror image, and the deadlock check: the two paths take the same lock
  // in the same order whichever starts first, so one waits and neither dies at
  // 40P01. A cycle would surface here as a deadlock-detected rejection rather
  // than the plain conflict this asserts.
  it('creation first, seed into its window: one wins, never both', async () => {
    const userId = await createCommittedUser();
    try {
      const creating = realAccount(userId);
      const seeding = seedDemoAccount(dedicatedDb, userId);

      const [created, seeded] = await Promise.allSettled([creating, seeding]);

      expect(await accountKinds(userId)).not.toEqual(['demo', 'real']);
      expect([created.status, seeded.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      for (const outcome of [created, seeded]) {
        if (outcome.status === 'rejected') {
          expect(String(outcome.reason)).not.toMatch(/deadlock/i);
        }
      }
    } finally {
      await cleanupCommittedRows(userId);
    }
  });
});
