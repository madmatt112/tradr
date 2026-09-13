import { eq, and, sql, inArray } from 'drizzle-orm';

import type { Tag, TagWithCount } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { tags, positionTags, users } from '@/db/schema';

// Category order shared by every tag listing: setups, emotions, mistakes,
// general, then case-insensitive name within each category.
const CATEGORY_ORDER = sql`array_position(ARRAY['setup','emotion','mistake','general']::text[], ${tags.category})`;

/**
 * All of a user's tags with their position counts. Used by `listTags`
 * (tags.service) behind `GET /api/tags`. One statement: a LEFT JOIN so tags
 * with no positions still return a count of 0.
 */
export function findTagsByUser(
  db: Database | Transaction,
  userId: string,
): Promise<TagWithCount[]> {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      category: sql<Tag['category']>`${tags.category}`,
      color: sql<Tag['color']>`${tags.color}`,
      positionCount: sql<number>`count(${positionTags.positionId})::int`,
    })
    .from(tags)
    .leftJoin(positionTags, eq(positionTags.tagId, tags.id))
    .where(eq(tags.userId, userId))
    .groupBy(tags.id)
    .orderBy(CATEGORY_ORDER, sql`lower(${tags.name})`);
}

/** A single owned tag row (or none). Used by `editTag` (tags.service) for its 404 check. */
export function findTagById(db: Database | Transaction, id: string, userId: string) {
  return db
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .limit(1);
}

/** Per-user tag count for the per-user cap in `createTag`/`ensureStarterTagsTx` (tags.service). */
export async function countTagsByUser(db: Database | Transaction, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tags)
    .where(eq(tags.userId, userId));
  return row?.count ?? 0;
}

/** Insert one tag; used by `createTag` (tags.service). */
export function insertTag(
  tx: Transaction,
  data: { userId: string; name: string; category: Tag['category']; color?: Tag['color'] },
) {
  return tx.insert(tags).values(data).returning();
}

/** Update an owned tag and bump `updatedAt`; used by `editTag` (tags.service). */
export function updateTag(
  tx: Transaction,
  id: string,
  userId: string,
  patch: Partial<{ name: string; category: Tag['category']; color: Tag['color'] }>,
) {
  return tx
    .update(tags)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .returning();
}

/** Delete an owned tag (join rows cascade); used by `removeTag` (tags.service). */
export function deleteTag(tx: Transaction, id: string, userId: string) {
  return tx
    .delete(tags)
    .where(and(eq(tags.id, id), eq(tags.userId, userId)))
    .returning();
}

/**
 * Which of `ids` this user actually owns — the single-query ownership check
 * `setPositionTagsTx` (tags.service) runs before the per-position cap. Returns
 * `[]` for an empty input without touching the database.
 */
export async function findOwnedTagIds(
  db: Database | Transaction,
  userId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.id, ids)));
  return rows.map((r) => r.id);
}

/**
 * A position's tags, in the shared category-then-name order. Used by the
 * position detail path and the `PUT /api/positions/:id/tags` result
 * (tags.service / positions.service).
 */
export function findTagsByPosition(db: Database | Transaction, positionId: string): Promise<Tag[]> {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      category: sql<Tag['category']>`${tags.category}`,
      color: sql<Tag['color']>`${tags.color}`,
    })
    .from(positionTags)
    .innerJoin(tags, eq(tags.id, positionTags.tagId))
    .where(eq(positionTags.positionId, positionId))
    .orderBy(CATEGORY_ORDER, sql`lower(${tags.name})`);
}

/**
 * Replace a position's whole tag set. Used by `setPositionTagsTx`
 * (tags.service): delete every existing join row, then one multi-row insert
 * (skipped when the new set is empty).
 */
export async function replacePositionTags(
  tx: Transaction,
  positionId: string,
  tagIds: string[],
): Promise<void> {
  await tx.delete(positionTags).where(eq(positionTags.positionId, positionId));
  if (tagIds.length > 0) {
    await tx.insert(positionTags).values(tagIds.map((tagId) => ({ positionId, tagId })));
  }
}

/**
 * Map of `lower(name)` → tag id for a user. Used by `ensureStarterTagsTx`
 * (tags.service) for the case-insensitive idempotent starter insert and by the
 * demo seed's tag assignments.
 */
export async function findLowerTagNamesByUser(
  db: Database | Transaction,
  userId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: tags.id, lowerName: sql<string>`lower(${tags.name})` })
    .from(tags)
    .where(eq(tags.userId, userId));
  return new Map(rows.map((r) => [r.lowerName, r.id]));
}

/**
 * Stamp `onboarding.starterTagsAnsweredAt`. Used by `recordStarterAnswerTx`
 * (tags.service). The `||`-merge with `COALESCE` is the `setDemoMarker` idiom
 * (accounts.query): it leaves every other onboarding key untouched and keeps
 * the first answer's timestamp, so a later idempotent `accept` does not move it.
 */
export function setStarterTagsAnsweredAt(tx: Transaction, userId: string, iso: string) {
  return tx
    .update(users)
    .set({
      onboarding: sql`${users.onboarding} || jsonb_build_object('starterTagsAnsweredAt', COALESCE(${users.onboarding} ->> 'starterTagsAnsweredAt', ${iso}))`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}
