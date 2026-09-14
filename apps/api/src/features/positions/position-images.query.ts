import { and, eq, inArray, sql } from 'drizzle-orm';

import type { PositionImage, StoredContentPart } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { positionImages, positions } from '@/db/schema';

/**
 * Insert one screenshot row and return its generated id and timestamp. The
 * caller stores exactly one image `StoredContentPart` (inline, pointer or
 * unrecoverable) per row (D15).
 */
export async function insertPositionImage(
  tx: Transaction,
  args: { positionId: string; part: StoredContentPart },
): Promise<{ id: string; createdAt: Date }> {
  const [row] = await tx
    .insert(positionImages)
    .values({ positionId: args.positionId, part: args.part })
    .returning({ id: positionImages.id, createdAt: positionImages.createdAt });
  return row;
}

/** Count the screenshots on a position — re-checked under the row lock on upload (REQ-2.5). */
export async function countPositionImages(
  db: Database | Transaction,
  positionId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(positionImages)
    .where(eq(positionImages.positionId, positionId));
  return row?.count ?? 0;
}

/**
 * The screenshot records for a position in creation order, without the stored
 * `part` (REQ-4.2/4.3). `format` and `unavailable` are read from the jsonb:
 * `unavailable` is `true` only for an unrecoverable record and is absent
 * otherwise (never `false`), matching `PositionImageSchema` (D22).
 */
export async function findPositionImagesByPosition(
  db: Database | Transaction,
  positionId: string,
): Promise<PositionImage[]> {
  const rows = await db
    .select({
      id: positionImages.id,
      format: sql<PositionImage['format']>`${positionImages.part}->>'format'`,
      createdAt: positionImages.createdAt,
      unrecoverable: sql<boolean>`${positionImages.part}->'storage'->>'kind' = 'unrecoverable'`,
    })
    .from(positionImages)
    .where(eq(positionImages.positionId, positionId))
    .orderBy(positionImages.createdAt, positionImages.id);
  return rows.map((row) => ({
    id: row.id,
    format: row.format,
    createdAt: row.createdAt.toISOString(),
    ...(row.unrecoverable ? { unavailable: true as const } : {}),
  }));
}

/**
 * The stored `part` of one screenshot, or `null` when the image does not exist,
 * is not on that position, or the position belongs to another user (the cases
 * are deliberately indistinguishable — no IDOR oracle, REQ-5.4). Ownership is
 * enforced in the SQL join on `positions.user_id`, not a column (D16), mirroring
 * `getOwnedMessageParts` (advisor.query.ts:732-751).
 */
export async function findOwnedPositionImage(
  db: Database | Transaction,
  args: { positionId: string; imageId: string; userId: string },
): Promise<StoredContentPart | null> {
  const rows = await db
    .select({ part: positionImages.part })
    .from(positionImages)
    .innerJoin(positions, eq(positionImages.positionId, positions.id))
    .where(
      and(
        eq(positionImages.id, args.imageId),
        eq(positionImages.positionId, args.positionId),
        eq(positions.userId, args.userId),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0].part as StoredContentPart;
}

/**
 * Delete one owned screenshot and return its stored `part`, or `null` when no
 * owned row matched (same ownership predicate as `findOwnedPositionImage`, so a
 * guessed id never touches another user's row). The `part` is returned so the
 * service can reclaim a pointer's object after commit.
 */
export async function deleteOwnedPositionImage(
  tx: Transaction,
  args: { positionId: string; imageId: string; userId: string },
): Promise<StoredContentPart | null> {
  const owned = tx
    .select({ id: positions.id })
    .from(positions)
    .where(and(eq(positions.id, args.positionId), eq(positions.userId, args.userId)));
  const rows = await tx
    .delete(positionImages)
    .where(
      and(
        eq(positionImages.id, args.imageId),
        eq(positionImages.positionId, args.positionId),
        inArray(positionImages.positionId, owned),
      ),
    )
    .returning({ part: positionImages.part });
  if (rows.length === 0) return null;
  return rows[0].part as StoredContentPart;
}

/**
 * Collect the object-storage pointer keys of every screenshot on an owned
 * position (REQ-5.4 reclamation). Ownership is enforced in the join, so a
 * non-owned/guessed id yields no rows. MUST run BEFORE the position is deleted:
 * the FK cascade destroys these rows. Mirrors `collectConversationObjectKeys`
 * (advisor.query.ts:762-785).
 */
export async function collectPositionImageKeys(
  db: Database | Transaction,
  args: { positionId: string; userId: string },
): Promise<string[]> {
  const rows = await db
    .select({ part: positionImages.part })
    .from(positionImages)
    .innerJoin(positions, eq(positionImages.positionId, positions.id))
    .where(and(eq(positionImages.positionId, args.positionId), eq(positions.userId, args.userId)));
  const keys: string[] = [];
  for (const row of rows) {
    const part = row.part as StoredContentPart;
    if ('storage' in part && part.storage.kind === 'object') {
      keys.push(part.storage.key);
    }
  }
  return keys;
}
