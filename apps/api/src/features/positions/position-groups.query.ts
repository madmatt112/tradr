import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { positionGroups, positions } from '@/db/schema';
import { ConflictError } from '@/lib/errors';

import { findPositionForUpdate } from './positions.query';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = Record<string, any>;

export function insertPositionGroup(
  tx: Transaction,
  data: { userId: string; labelOverride: string | null },
) {
  return tx.insert(positionGroups).values(data).returning();
}

export function findPositionGroupById(db: Database | Transaction, id: string, userId: string) {
  return db
    .select()
    .from(positionGroups)
    .where(and(eq(positionGroups.id, id), eq(positionGroups.userId, userId)))
    .limit(1);
}

/** A group's current leg ids, ascending (the Lock rule's ordering). */
export async function findGroupLegIds(
  db: Database | Transaction,
  groupId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.groupId, groupId))
    .orderBy(asc(positions.id));
  return rows.map((r) => r.id);
}

/**
 * Locks a given id list with `findPositionForUpdate`, ascending, in one pass
 * (design.md "Lock rule") — the one ordering every multi-lock flow shares, so
 * no AB/BA pair exists. A foreign or other-user id simply has no row in the
 * result; callers compare the result's length against the input to detect
 * one (NFR Security — never resolved, just absent).
 */
export async function lockLegs(tx: Transaction, userId: string, ids: string[]): Promise<RawRow[]> {
  const sortedUnique = [...new Set(ids)].sort();
  const rows: RawRow[] = [];
  for (const id of sortedUnique) {
    const found = (await findPositionForUpdate(tx, id, userId)) as RawRow[];
    if (found.length > 0) rows.push(found[0] as RawRow);
  }
  return rows;
}

/**
 * Reads a group's leg ids, locks them all via `lockLegs`, then re-reads
 * membership — throwing `ConflictError` (Error Handling #6) if it changed
 * under the lock (design.md "Lock rule"). Callers are expected to have
 * already confirmed the group exists and is owned by `userId`.
 */
export async function lockGroupLegs(
  tx: Transaction,
  userId: string,
  groupId: string,
): Promise<RawRow[]> {
  const legIds = await findGroupLegIds(tx, groupId);
  const rows = await lockLegs(tx, userId, legIds);
  const reread = await findGroupLegIds(tx, groupId);
  if (reread.length !== legIds.length || reread.some((id, i) => id !== legIds[i])) {
    throw new ConflictError('The group changed; try again.');
  }
  return rows;
}

/**
 * Sets (or clears) one position's `group_id` only — deliberately not
 * `updatePosition`, which always bumps `updated_at`. Linking leaves it alone
 * (design D6, AC 1.4).
 */
export function setPositionGroupLink(tx: Transaction, positionId: string, groupId: string | null) {
  return tx.update(positions).set({ groupId }).where(eq(positions.id, positionId)).returning();
}

export function deletePositionGroup(tx: Transaction, groupId: string, userId: string) {
  return tx
    .delete(positionGroups)
    .where(and(eq(positionGroups.id, groupId), eq(positionGroups.userId, userId)))
    .returning();
}

/**
 * After a leg leaves a group, dissolves it into a plain position once one
 * leg or fewer remains (design C4, AC 1.5): clears the last leg's link (it
 * is already locked by the caller's `lockGroupLegs`) and deletes the group
 * row. `position_groups` itself is never row-locked (D5) — this only ever
 * touches legs the caller already holds.
 */
export async function dissolveGroupIfSingleton(
  tx: Transaction,
  groupId: string,
  userId: string,
): Promise<void> {
  const legIds = await findGroupLegIds(tx, groupId);
  if (legIds.length > 1) return;
  for (const id of legIds) {
    await setPositionGroupLink(tx, id, null);
  }
  await deletePositionGroup(tx, groupId, userId);
}

/** Every group a user owns (design C7: account/user teardown must not strand one). */
export function deletePositionGroupsByUser(tx: Transaction, userId: string) {
  return tx.delete(positionGroups).where(eq(positionGroups.userId, userId)).returning();
}

/**
 * Every group whose legs live in the given account, found through the legs'
 * `account_id` while they still exist — `position_groups` itself has no
 * account reference. Must run before the account's positions are deleted
 * (design C7, `teardownDemoAccount` order).
 */
export async function deletePositionGroupsByAccount(tx: Transaction, accountId: string) {
  const legs = await tx
    .select({ groupId: positions.groupId })
    .from(positions)
    .where(and(eq(positions.accountId, accountId), isNotNull(positions.groupId)));
  const groupIds = [
    ...new Set(legs.map((l) => l.groupId).filter((id): id is string => id !== null)),
  ];
  if (groupIds.length === 0) return [];
  return tx.delete(positionGroups).where(inArray(positionGroups.id, groupIds)).returning();
}

export function updateGroupLabelOverride(
  db: Database,
  groupId: string,
  userId: string,
  labelOverride: string | null,
) {
  return db
    .update(positionGroups)
    .set({ labelOverride })
    .where(and(eq(positionGroups.id, groupId), eq(positionGroups.userId, userId)))
    .returning();
}
