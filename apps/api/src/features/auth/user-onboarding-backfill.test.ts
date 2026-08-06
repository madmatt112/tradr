import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { OnboardingStateSchema } from '@tradr/shared';
import type { StoredOnboardingState } from '@tradr/shared';

import { db } from '@/db';
import { accounts, positions, users } from '@/db/schema';

// Migration 0028 — "users who predate onboarding start out already onboarded"
// (user-onboarding R3.6).
//
// The statement under test is the migration FILE itself, read from disk and
// executed, not a hand-copied paraphrase of it. A paraphrase would pass while
// the shipped SQL said something else, which is the only failure mode that
// matters for a one-shot backfill nobody can re-run by hand.
//
// It is safe to execute here because the statement is idempotent by
// construction (it only touches rows whose `onboarding` is still `'{}'`), and
// this project's test setup wraps every test in a transaction that rolls back,
// so the fixture rows and the re-run both disappear afterwards.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../db/migrations/0028_onboarding_backfill_existing_users.sql',
);

/** Runs the migration and reports how many rows it actually wrote. */
async function runBackfill(): Promise<number> {
  const ddl = await readFile(MIGRATION_PATH, 'utf8');
  const result = await db.execute(sql.raw(ddl));
  return (result as unknown as { count: number }).count;
}

let seq = 0;
const runId = Date.now();

/** A row as it exists before the backfill: `onboarding` still the 0027 default. */
async function makeUser(): Promise<{ id: string; email: string }> {
  const email = `onb-backfill-${runId}-${++seq}@example.com`;
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: 'x'.repeat(60) })
    .returning({ id: users.id, email: users.email });
  return row;
}

async function makeAccount(userId: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ userId, name: `acct-${++seq}`, currency: 'USD' })
    .returning({ id: accounts.id });
  return row.id;
}

async function makePosition(userId: string, accountId: string): Promise<void> {
  // performance-charts §8.2 audit: the default status 'draft' is CHECK-safe
  // (positions_closed_at_when_closed_chk only constrains 'closed'), and the
  // backfill's EXISTS reads no column but user_id.
  // eslint-disable-next-line no-restricted-syntax
  await db
    .insert(positions)
    .values({ userId, accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' });
}

function storedOnboarding(id: string) {
  return db
    .select({ onboarding: users.onboarding })
    .from(users)
    .where(eq(users.id, id))
    .then((rows) => rows[0]?.onboarding as Record<string, unknown> | undefined);
}

function setStoredOnboarding(id: string, value: Record<string, unknown>) {
  return db
    .update(users)
    .set({ onboarding: value as StoredOnboardingState })
    .where(eq(users.id, id));
}

describe('migration 0028 — onboarding backfill for pre-existing users', () => {
  it('marks a user with history as done, so the zero-state cannot come back (R3.6)', async () => {
    // The user R3.6 is about: years of history, and `{}` in the column because
    // the 0027 fast default put every existing row at 'pending'. Left alone,
    // deleting their last account shows them "Welcome to Tradr".
    const user = await makeUser();
    const accountId = await makeAccount(user.id);
    await makePosition(user.id, accountId);
    expect(await storedOnboarding(user.id)).toEqual({});

    await runBackfill();

    expect(await storedOnboarding(user.id)).toEqual({ status: 'done' });
    // And it resolves through the shared schema like any other stored state —
    // `jsonb_set` writing one key must not disturb the rest of the defaulting.
    expect(OnboardingStateSchema.parse(await storedOnboarding(user.id))).toEqual({
      status: 'done',
      coachMarksSeen: [],
    });
  });

  it('marks a user whose only history is an account', async () => {
    // Deleting the last account is R3.6's own scenario, and the account is the
    // history that proves they are not new. Positions are not required.
    const user = await makeUser();
    await makeAccount(user.id);

    await runBackfill();

    expect(await storedOnboarding(user.id)).toEqual({ status: 'done' });
  });

  it('marks a user whose only history is a position', async () => {
    // The second arm of the OR. Today it cannot fire on its own —
    // positions.account_id is ON DELETE RESTRICT and the accounts service
    // refuses to delete an account that still has positions, so a position
    // implies an account — and this fixture reaches the shape only by booking
    // the position against another user's account. That is the point: the arm
    // is here so a future relaxation of that FK cannot quietly narrow the rule,
    // and an untested arm would not survive the next refactor.
    const other = await makeUser();
    const otherAccount = await makeAccount(other.id);
    const user = await makeUser();
    await makePosition(user.id, otherAccount);

    await runBackfill();

    expect(await storedOnboarding(user.id)).toEqual({ status: 'done' });
  });

  it('leaves a user with no history alone — a minute-old registration is genuinely new', async () => {
    // The trap in dating "pre-existing" by `created_at`: every row that exists
    // when the migration runs was created before it, so a timestamp comparison
    // marks the whole table, this user included. They have no accounts and no
    // positions, so the zero-state is the accurate screen for them and 'pending'
    // is the correct status.
    const user = await makeUser();

    await runBackfill();

    expect(await storedOnboarding(user.id)).toEqual({});
    expect(OnboardingStateSchema.parse(await storedOnboarding(user.id)).status).toBe('pending');
  });

  it('never overwrites a preference the user has already expressed', async () => {
    // A dismissal (R4.5) is recoverable and a `skipped` user still reaches the
    // zero-state and its reopen row. Backfilling over it would retire the
    // checklist behind their back and delete the only way back.
    const skipped = await makeUser();
    await makeAccount(skipped.id);
    await setStoredOnboarding(skipped.id, { status: 'skipped' });

    // And a row whose only key is one the PATCH endpoint wrote: not '{}', so
    // not a pre-existing row, even though it has no `status` yet.
    const marked = await makeUser();
    await makeAccount(marked.id);
    await setStoredOnboarding(marked.id, { coachMarksSeen: ['csv-import'] });

    await runBackfill();

    expect(await storedOnboarding(skipped.id)).toEqual({ status: 'skipped' });
    expect(await storedOnboarding(marked.id)).toEqual({ coachMarksSeen: ['csv-import'] });
  });

  it('is idempotent — a second run changes nothing', async () => {
    // Migrations are journalled and run once, but a backfill that is only
    // correct on its first application is a trap for anyone replaying it
    // against a restored dump. The `onboarding = '{}'` guard is what makes the
    // re-run a no-op: a backfilled row is no longer '{}'.
    const withHistory = await makeUser();
    await makeAccount(withHistory.id);
    const withoutHistory = await makeUser();

    const firstCount = await runBackfill();
    expect(firstCount).toBeGreaterThan(0);
    const first = await storedOnboarding(withHistory.id);

    // Zero rows written, not merely the same values afterwards: an UPDATE that
    // rewrote the row with an identical value would satisfy the weaker claim.
    expect(await runBackfill()).toBe(0);
    expect(await storedOnboarding(withHistory.id)).toEqual(first);
    expect(await storedOnboarding(withoutHistory.id)).toEqual({});
  });
});
