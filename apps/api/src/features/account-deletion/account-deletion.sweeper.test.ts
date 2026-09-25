import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { accountDeletions, accountDeletionSchedules, subscriptions, users } from '@/db/schema';
import { logger } from '@/lib/logger';

import { claimDueSchedules, claimForCancel } from './account-deletion.query';
import { cancelScheduledDeletion } from './account-deletion.service';
import { DELETION_LEASE_MS, runDeletionSweep } from './account-deletion.sweeper';

// runDeletionSweep + fireScheduledDeletion (design C6) against real tradr_test,
// each test rolled back by the single-connection harness (test-setup.ts). Nothing
// optional is configured, so the fire's post-commit purge and PostHog steps take
// their graceful-absence no-op path (Req 9.1).
//
// The sweep's queries take `now` as an explicit parameter (the harness freezes
// transaction `now()`), so each test drives due-at, lease and overdue comparisons
// at chosen instants. Stripe is reached through `getStripeClient()`; stubbing the
// `./stripe-client` seam drives the fire's guard/cancel branches DB-side.

const stripeMock = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/features/billing/stripe-client', () => ({
  getStripeClient: () => stripeMock.client,
}));

beforeEach(() => {
  stripeMock.client = null;
});

let seq = 0;
const uniq = (tag: string): string => `${tag}-${Date.now()}-${++seq}`;
const FUTURE = new Date('2035-01-01T00:00:00.000Z');

async function seedUser(
  overrides: Partial<{ email: string; isAdmin: boolean }> = {},
): Promise<{ id: string; email: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `${uniq('acct-del-sweep')}@example.com`,
      passwordHash: 'x'.repeat(60),
      isAdmin: overrides.isAdmin ?? false,
    })
    .returning({ id: users.id, email: users.email });
  return row;
}

/** A non-terminal `subscriptions` mirror row — trips the Req 2.3 guard when Stripe is down. */
async function seedActiveMirror(userId: string): Promise<void> {
  await db.insert(subscriptions).values({
    userId,
    stripeCustomerId: 'cus_seed',
    stripeSubscriptionId: uniq('sub'),
    status: 'active',
    currentPeriodEnd: FUTURE,
    stripeCreatedAt: new Date(),
    lastEventCreated: new Date(),
  });
}

async function readSchedule(
  userId: string,
): Promise<typeof accountDeletionSchedules.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(accountDeletionSchedules)
    .where(eq(accountDeletionSchedules.userId, userId));
  return row;
}

describe('runDeletionSweep — fires a due schedule', () => {
  it('deletes the user with initiator self when now is past due_at (Req 3.4)', async () => {
    const user = await seedUser();
    const dueAt = new Date(Date.now() - 24 * 60 * 60 * 1000); // a day overdue
    await db
      .insert(accountDeletionSchedules)
      .values({ userId: user.id, state: 'scheduled', dueAt, stripeSubscriptionIds: [] });

    const result = await runDeletionSweep(new Date());

    expect(result.fired).toContain(user.id);
    // The user row is gone, with exactly one tombstone attributed to `self`.
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
    const tombstones = await db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, user.id));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].initiator).toBe('self');
    // The schedule row went with the user cascade.
    expect(await readSchedule(user.id)).toBeUndefined();
  });
});

describe('runDeletionSweep — a fire failure', () => {
  it('reverts the row to scheduled and logs one error with the user id and due_at', async () => {
    const user = await seedUser();
    const dueAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .insert(accountDeletionSchedules)
      .values({ userId: user.id, state: 'scheduled', dueAt, stripeSubscriptionIds: [] });
    // Stripe unconfigured (stripeMock.client null) but a live mirror remains → the
    // fire's Req 2.3 guard trips, so the fire fails and reverts.
    await seedActiveMirror(user.id);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const result = await runDeletionSweep(new Date());

    // Nothing fired to completion; the user survives.
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
    // The row is back to `scheduled`, claim released — the next sweep retries.
    const row = await readSchedule(user.id);
    expect(row?.state).toBe('scheduled');
    expect(row?.claimedAt).toBeNull();
    expect(result.fired).toContain(user.id);

    expect(errorSpy).toHaveBeenCalledWith(
      'scheduled account deletion failed',
      expect.objectContaining({ userId: user.id, dueAt: dueAt.toISOString() }),
    );
    errorSpy.mockRestore();
  });
});

describe('runDeletionSweep — a cancelled row is never fired', () => {
  it('leaves a cancelling row untouched and deletes no user', async () => {
    const user = await seedUser();
    const dueAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .insert(accountDeletionSchedules)
      .values({ userId: user.id, state: 'scheduled', dueAt, stripeSubscriptionIds: ['sub_A'] });

    // Cancel claims the row first (state → cancelling), with a fresh claim so it
    // is not stale for this sweep.
    const now = new Date();
    const claimed = await claimForCancel(db, user.id, now);
    expect(claimed?.state).toBe('cancelling');

    const result = await runDeletionSweep(now);

    // The fire never touches a cancelling row.
    expect(result.fired).not.toContain(user.id);
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
    expect((await readSchedule(user.id))?.state).toBe('cancelling');
  });
});

describe('cancel after a fire claim', () => {
  it('answers 409 DELETION_IN_PROGRESS and makes no Stripe call', async () => {
    const user = await seedUser();
    await db
      .insert(accountDeletionSchedules)
      .values({
        userId: user.id,
        state: 'scheduled',
        dueAt: FUTURE,
        stripeSubscriptionIds: ['sub_A'],
      });

    // The fire's claim step moves the row to `firing`.
    const due = await claimDueSchedules(
      db,
      new Date('2040-01-01T00:00:00.000Z'),
      DELETION_LEASE_MS,
      20,
    );
    expect(due.some((r) => r.userId === user.id)).toBe(true);

    const updateCalls: string[] = [];
    stripeMock.client = {
      subscriptions: {
        update: async (id: string) => {
          updateCalls.push(id);
          return {};
        },
      },
    };

    await expect(cancelScheduledDeletion(user.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DELETION_IN_PROGRESS',
    });
    // Cancel lost the claim before reaching Stripe.
    expect(updateCalls).toHaveLength(0);
    expect((await readSchedule(user.id))?.state).toBe('firing');
  });
});

describe('runDeletionSweep — stale rows', () => {
  it('deletes a stale pending row and reverts a stale cancelling row', async () => {
    const pendingUser = await seedUser();
    const cancellingUser = await seedUser();
    const now = new Date();
    const stale = new Date(now.getTime() - DELETION_LEASE_MS - 60 * 1000); // past the lease

    // A pending row whose Stripe call never landed (updated_at past the lease).
    await db.insert(accountDeletionSchedules).values({
      userId: pendingUser.id,
      state: 'pending',
      dueAt: FUTURE,
      stripeSubscriptionIds: [],
      updatedAt: stale,
    });
    // A cancelling row a crash left mid-flight (claimed_at past the lease).
    await db.insert(accountDeletionSchedules).values({
      userId: cancellingUser.id,
      state: 'cancelling',
      dueAt: FUTURE,
      stripeSubscriptionIds: [],
      claimedAt: stale,
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await runDeletionSweep(now);

    expect(result.pendingDeleted).toContain(pendingUser.id);
    expect(result.cancellingReverted).toContain(cancellingUser.id);
    // The stale pending row is gone; the stale cancelling row is back to scheduled.
    expect(await readSchedule(pendingUser.id)).toBeUndefined();
    const reverted = await readSchedule(cancellingUser.id);
    expect(reverted?.state).toBe('scheduled');
    expect(reverted?.claimedAt).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
