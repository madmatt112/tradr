import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db';
import { accountDeletions, accountDeletionSchedules, adminAuditLog, users } from '@/db/schema';
import { withTransaction } from '@/lib/transaction';

import {
  claimDueSchedules,
  claimForCancel,
  deleteSchedule,
  deleteUserRow,
  insertTombstone,
  lockFiringSchedule,
  markScheduled,
  revertToScheduled,
  rewriteAuditEmails,
  selectPasswordHashById,
  selectSchedule,
  selectUserForDeletion,
  sweepStaleSchedules,
  updateTombstonePurge,
  upsertPendingSchedule,
} from './account-deletion.query';

// Design C3 queries against real tradr_test, each test rolled back by the
// single-connection harness (test-setup.ts). Inside that one transaction `now()`
// is frozen (probe /tmp/scratchpad/acct-del-now-probe.sh), so every test that
// leans on a token or a lease seeds and passes EXPLICIT timestamps rather than
// trusting the clock to advance.

let seq = 0;
async function seedUser(
  overrides: Partial<{ email: string; passwordHash: string; isAdmin: boolean }> = {},
): Promise<{ id: string; email: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `acct-del-q-${Date.now()}-${++seq}@example.com`,
      passwordHash: overrides.passwordHash ?? 'x'.repeat(60),
      isAdmin: overrides.isAdmin ?? false,
    })
    .returning({ id: users.id, email: users.email });
  return row;
}

type ScheduleSeed = Partial<typeof accountDeletionSchedules.$inferInsert>;
async function seedSchedule(
  userId: string,
  values: ScheduleSeed = {},
): Promise<typeof accountDeletionSchedules.$inferSelect> {
  const [row] = await db
    .insert(accountDeletionSchedules)
    .values({
      userId,
      state: values.state ?? 'scheduled',
      dueAt: values.dueAt ?? new Date(),
      stripeSubscriptionIds: values.stripeSubscriptionIds ?? [],
      ...(values.claimedAt !== undefined ? { claimedAt: values.claimedAt } : {}),
      ...(values.createdAt !== undefined ? { createdAt: values.createdAt } : {}),
      ...(values.updatedAt !== undefined ? { updatedAt: values.updatedAt } : {}),
    })
    .returning();
  return row;
}

describe('upsertPendingSchedule', () => {
  it('inserts a fresh pending row and reports inserted true', async () => {
    const user = await seedUser();
    const dueAt = new Date('2030-01-01T00:00:00.000Z');

    const result = await upsertPendingSchedule(db, {
      userId: user.id,
      dueAt,
      renewingIds: ['sub_a'],
    });

    expect(result).toEqual({ inserted: true });
    const row = await selectSchedule(db, user.id);
    expect(row?.state).toBe('pending');
    expect(row?.dueAt.getTime()).toBe(dueAt.getTime());
    expect(row?.stripeSubscriptionIds).toEqual(['sub_a']);
  });

  it('over a scheduled row keeps the state, updates due_at and unions the ids', async () => {
    const user = await seedUser();
    const firstDue = new Date('2030-01-01T00:00:00.000Z');
    const secondDue = new Date('2030-02-02T00:00:00.000Z');

    await upsertPendingSchedule(db, { userId: user.id, dueAt: firstDue, renewingIds: ['sub_a'] });
    await markScheduled(db, user.id);

    const result = await upsertPendingSchedule(db, {
      userId: user.id,
      dueAt: secondDue,
      renewingIds: ['sub_b'],
    });

    expect(result).toEqual({ inserted: false });
    const row = await selectSchedule(db, user.id);
    expect(row?.state).toBe('scheduled');
    expect(row?.dueAt.getTime()).toBe(secondDue.getTime());
    expect([...(row?.stripeSubscriptionIds ?? [])].sort()).toEqual(['sub_a', 'sub_b']);
  });

  it('returns null when the existing row is cancelling or firing', async () => {
    const cancelling = await seedUser();
    await seedSchedule(cancelling.id, { state: 'cancelling', claimedAt: new Date() });
    const firing = await seedUser();
    await seedSchedule(firing.id, { state: 'firing', claimedAt: new Date() });

    expect(
      await upsertPendingSchedule(db, {
        userId: cancelling.id,
        dueAt: new Date('2030-01-01T00:00:00.000Z'),
        renewingIds: ['sub_a'],
      }),
    ).toBeNull();
    expect(
      await upsertPendingSchedule(db, {
        userId: firing.id,
        dueAt: new Date('2030-01-01T00:00:00.000Z'),
        renewingIds: ['sub_a'],
      }),
    ).toBeNull();

    // Untouched by the refused upsert.
    expect((await selectSchedule(db, cancelling.id))?.state).toBe('cancelling');
    expect((await selectSchedule(db, firing.id))?.state).toBe('firing');
  });
});

describe('claimForCancel', () => {
  it('claims a scheduled row once; a second claim returns null', async () => {
    const user = await seedUser();
    await seedSchedule(user.id, { state: 'scheduled' });

    const first = await claimForCancel(db, user.id);
    expect(first?.state).toBe('cancelling');
    expect(first?.claimedAt).not.toBeNull();

    const second = await claimForCancel(db, user.id);
    expect(second).toBeNull();
  });
});

describe('revertToScheduled', () => {
  it('reverts only for the matching claim token', async () => {
    const user = await seedUser();
    const token = new Date('2030-03-03T03:03:03.000Z');
    await seedSchedule(user.id, { state: 'cancelling', claimedAt: token });

    const wrong = await revertToScheduled(db, user.id, new Date('2030-03-03T03:03:04.000Z'));
    expect(wrong).toBeNull();
    expect((await selectSchedule(db, user.id))?.state).toBe('cancelling');

    const right = await revertToScheduled(db, user.id, token);
    expect(right?.state).toBe('scheduled');
    expect(right?.claimedAt).toBeNull();
  });
});

describe('markScheduled', () => {
  it('moves a pending row to scheduled', async () => {
    const user = await seedUser();
    await seedSchedule(user.id, { state: 'pending' });

    await markScheduled(db, user.id);

    expect((await selectSchedule(db, user.id))?.state).toBe('scheduled');
  });
});

describe('deleteSchedule', () => {
  it('deletes only the row matching the claim token', async () => {
    const user = await seedUser();
    const token = new Date('2030-04-04T00:00:00.000Z');
    await seedSchedule(user.id, { state: 'cancelling', claimedAt: token });

    await deleteSchedule(db, user.id, { claimedAt: new Date('2030-04-04T00:00:01.000Z') });
    expect(await selectSchedule(db, user.id)).not.toBeNull();

    await deleteSchedule(db, user.id, { claimedAt: token });
    expect(await selectSchedule(db, user.id)).toBeNull();
  });

  it('deletes unconditionally with no opts', async () => {
    const user = await seedUser();
    await seedSchedule(user.id, { state: 'scheduled' });

    await deleteSchedule(db, user.id);

    expect(await selectSchedule(db, user.id)).toBeNull();
  });
});

describe('claimDueSchedules', () => {
  it('claims due scheduled rows and lease-expired firing rows only', async () => {
    const now = new Date('2030-06-01T12:00:00.000Z');
    const leaseMs = 15 * 60 * 1000;

    const due = await seedUser();
    await seedSchedule(due.id, { state: 'scheduled', dueAt: new Date(now.getTime() - 1000) });
    const future = await seedUser();
    await seedSchedule(future.id, {
      state: 'scheduled',
      dueAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const firingExpired = await seedUser();
    await seedSchedule(firingExpired.id, {
      state: 'firing',
      dueAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      claimedAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const firingFresh = await seedUser();
    await seedSchedule(firingFresh.id, {
      state: 'firing',
      dueAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      claimedAt: new Date(now.getTime() - 60 * 1000),
    });
    const pending = await seedUser();
    await seedSchedule(pending.id, { state: 'pending', dueAt: new Date(now.getTime() - 1000) });

    const claimed = await claimDueSchedules(db, now, leaseMs, 10);

    expect(claimed.map((r) => r.userId).sort()).toEqual([due.id, firingExpired.id].sort());
    for (const row of claimed) {
      expect(row.state).toBe('firing');
      expect(row.claimedAt?.getTime()).toBe(now.getTime());
    }
    // The rows outside the due/expired window keep their prior state.
    expect((await selectSchedule(db, future.id))?.state).toBe('scheduled');
    expect((await selectSchedule(db, firingFresh.id))?.claimedAt?.getTime()).toBe(
      now.getTime() - 60 * 1000,
    );
    expect((await selectSchedule(db, pending.id))?.state).toBe('pending');
  });
});

describe('sweepStaleSchedules', () => {
  it('deletes stale pending rows and reverts stale cancelling rows', async () => {
    const now = new Date('2030-07-01T12:00:00.000Z');
    const leaseMs = 15 * 60 * 1000;
    const stale = new Date(now.getTime() - 60 * 60 * 1000);
    const fresh = new Date(now.getTime() - 60 * 1000);

    const stalePending = await seedUser();
    await seedSchedule(stalePending.id, { state: 'pending', updatedAt: stale });
    const freshPending = await seedUser();
    await seedSchedule(freshPending.id, { state: 'pending', updatedAt: fresh });
    const staleCancelling = await seedUser();
    await seedSchedule(staleCancelling.id, { state: 'cancelling', claimedAt: stale });
    const freshCancelling = await seedUser();
    await seedSchedule(freshCancelling.id, { state: 'cancelling', claimedAt: fresh });

    const result = await sweepStaleSchedules(db, now, leaseMs);

    expect(result.pendingDeleted).toEqual([stalePending.id]);
    expect(result.cancellingReverted).toEqual([staleCancelling.id]);
    expect(await selectSchedule(db, stalePending.id)).toBeNull();
    expect((await selectSchedule(db, freshPending.id))?.state).toBe('pending');
    expect((await selectSchedule(db, staleCancelling.id))?.state).toBe('scheduled');
    expect((await selectSchedule(db, staleCancelling.id))?.claimedAt).toBeNull();
    expect((await selectSchedule(db, freshCancelling.id))?.state).toBe('cancelling');
  });
});

describe('lockFiringSchedule', () => {
  it('returns the firing row for the matching token, null otherwise', async () => {
    const user = await seedUser();
    const token = new Date('2030-08-08T00:00:00.000Z');
    await seedSchedule(user.id, { state: 'firing', claimedAt: token });

    await withTransaction(db, async (tx) => {
      const locked = await lockFiringSchedule(tx, user.id, token);
      expect(locked?.userId).toBe(user.id);
      expect(locked?.state).toBe('firing');
      expect(locked?.claimedAt?.getTime()).toBe(token.getTime());

      expect(
        await lockFiringSchedule(tx, user.id, new Date('2030-08-08T00:00:01.000Z')),
      ).toBeNull();
    });
  });

  it('returns null when the row is not firing', async () => {
    const user = await seedUser();
    const token = new Date('2030-08-08T00:00:00.000Z');
    await seedSchedule(user.id, { state: 'scheduled', claimedAt: token });

    await withTransaction(db, async (tx) => {
      expect(await lockFiringSchedule(tx, user.id, token)).toBeNull();
    });
  });
});

describe('selectUserForDeletion', () => {
  it('returns the locked user fields, or null when absent', async () => {
    const user = await seedUser({ isAdmin: true });

    await withTransaction(db, async (tx) => {
      const locked = await selectUserForDeletion(tx, user.id);
      expect(locked).toEqual({ id: user.id, email: user.email, isAdmin: true });

      expect(await selectUserForDeletion(tx, '00000000-0000-0000-0000-000000000000')).toBeNull();
    });
  });
});

describe('selectPasswordHashById', () => {
  it('returns the hash, or null for an unknown id', async () => {
    const hash = 'y'.repeat(60);
    const user = await seedUser({ passwordHash: hash });

    expect(await selectPasswordHashById(db, user.id)).toBe(hash);
    expect(await selectPasswordHashById(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('insertTombstone / updateTombstonePurge', () => {
  it('inserts a pending tombstone and sets its terminal outcome', async () => {
    const user = await seedUser();

    const id = await withTransaction(db, (tx) =>
      insertTombstone(tx, {
        userId: user.id,
        emailHash: 'a'.repeat(64),
        tier: 'pro',
        initiator: 'self',
      }),
    );
    expect(typeof id).toBe('string');

    const [inserted] = await db.select().from(accountDeletions).where(eq(accountDeletions.id, id));
    expect(inserted.userId).toBe(user.id);
    expect(inserted.tier).toBe('pro');
    expect(inserted.initiator).toBe('self');
    expect(inserted.purgeOutcome).toBe('pending');

    await updateTombstonePurge(db, id, 'complete');
    const [updated] = await db
      .select({ purgeOutcome: accountDeletions.purgeOutcome })
      .from(accountDeletions)
      .where(eq(accountDeletions.id, id));
    expect(updated.purgeOutcome).toBe('complete');
  });
});

describe('rewriteAuditEmails', () => {
  it('rewrites only the target user snapshots, leaving other rows intact', async () => {
    const subject = await seedUser();
    const other = await seedUser();
    const marker = `deleted:${'f'.repeat(64)}`;

    // subject is the actor here...
    await db.insert(adminAuditLog).values({
      action: 'admin_toggle',
      actorUserId: subject.id,
      actorEmail: 'subject-actor@example.com',
      targetUserId: other.id,
      targetEmail: 'other-target@example.com',
      oldValue: false,
      newValue: true,
    });
    // ...and the target here.
    await db.insert(adminAuditLog).values({
      action: 'admin_toggle',
      actorUserId: other.id,
      actorEmail: 'other-actor@example.com',
      targetUserId: subject.id,
      targetEmail: 'subject-target@example.com',
      oldValue: true,
      newValue: false,
    });
    // Unrelated row: subject appears nowhere.
    await db.insert(adminAuditLog).values({
      action: 'admin_toggle',
      actorUserId: other.id,
      actorEmail: 'unrelated-actor@example.com',
      targetUserId: null,
      targetEmail: 'unrelated-target@example.com',
      oldValue: false,
      newValue: true,
    });

    await withTransaction(db, (tx) => rewriteAuditEmails(tx, subject.id, marker));

    const rows = await db.select().from(adminAuditLog);
    const asActor = rows.find((r) => r.actorUserId === subject.id);
    const asTarget = rows.find((r) => r.targetUserId === subject.id);
    const unrelated = rows.find((r) => r.actorEmail === 'unrelated-actor@example.com');

    expect(asActor?.actorEmail).toBe(marker);
    expect(asActor?.targetEmail).toBe('other-target@example.com');
    expect(asTarget?.targetEmail).toBe(marker);
    expect(asTarget?.actorEmail).toBe('other-actor@example.com');
    expect(unrelated?.actorEmail).toBe('unrelated-actor@example.com');
    expect(unrelated?.targetEmail).toBe('unrelated-target@example.com');
  });
});

describe('deleteUserRow', () => {
  it('deletes the user and returns the row count', async () => {
    const user = await seedUser();

    const count = await withTransaction(db, (tx) => deleteUserRow(tx, user.id));
    expect(count).toBe(1);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row).toBeUndefined();
  });

  it('returns 0 for an unknown id', async () => {
    const count = await withTransaction(db, (tx) =>
      deleteUserRow(tx, '00000000-0000-0000-0000-000000000000'),
    );
    expect(count).toBe(0);
  });
});
