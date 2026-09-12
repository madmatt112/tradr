import { STARTER_TAGS, TAG_LIMITS } from '@tradr/shared/constants/tags';
import type {
  CreateTagInput,
  StarterAnswer,
  StarterAnswerResult,
  Tag,
  TagWithCount,
  UpdateTagInput,
} from '@tradr/shared/schemas/tag';

import type { Database, Transaction } from '@/db';
import { findPositionById } from '@/features/positions/positions.query';
import { NotFoundError, TagLimitError, TagNameTakenError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  countTagsByUser,
  deleteTag,
  findLowerTagNamesByUser,
  findOwnedTagIds,
  findTagById,
  findTagsByPosition,
  findTagsByUser,
  insertTag,
  replacePositionTags,
  setStarterTagsAnsweredAt,
  updateTag,
} from './tags.query';

// The module-private Postgres-error shape and guard, copied from
// brokerages.service.ts:5-12: the query layer surfaces driver errors raw so the
// service can map a unique-index (23505) or FK (23503) violation to a domain 409/404.
interface PgError {
  code?: string;
  constraint_name?: string;
  detail?: string;
}
function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

// The insert/update queries return the full Drizzle row, whose `category`/`color`
// columns are plain `string`/`string | null`. Narrow them to the wire `Tag`.
function toTag(row: { id: string; name: string; category: string; color: string | null }): Tag {
  return {
    id: row.id,
    name: row.name,
    category: row.category as Tag['category'],
    color: row.color as Tag['color'],
  };
}

/** `GET /api/tags`: the user's tags, each with its position count. */
export async function listTags(db: Database, userId: string): Promise<TagWithCount[]> {
  return findTagsByUser(db, userId);
}

/**
 * Create a tag. Enforces the per-user cap and maps a case-insensitive name
 * collision to a 409. The count-then-insert accepts the same small
 * concurrent-overshoot posture the positions cap does.
 */
export async function createTag(db: Database, userId: string, input: CreateTagInput): Promise<Tag> {
  const tag = await withTransaction(db, async (tx) => {
    if ((await countTagsByUser(tx, userId)) >= TAG_LIMITS.perUser) {
      throw new TagLimitError(TAG_LIMITS.perUser);
    }
    try {
      const [row] = await insertTag(tx, {
        userId,
        name: input.name,
        category: input.category,
        color: input.color ?? null,
      });
      return toTag(row);
    } catch (err: unknown) {
      if (isPgError(err) && err.code === '23505') throw new TagNameTakenError();
      throw err;
    }
  });
  // Fire-and-forget business event after commit: the category enum only, never
  // the tag name (REQ-9.1). Guarded so a telemetry fault never fails the create.
  try {
    captureServerEvent('tag_created', {
      distinctId: userId,
      properties: { category: tag.category },
    });
  } catch {
    // ignore — capture is fire-and-forget
  }
  return tag;
}

/**
 * Rename/recolour/recategorise an owned tag. A foreign id is a 404; a name
 * collision is a 409. A case-only or whitespace-only self-rename cannot collide
 * because the unique index never compares the row with itself.
 */
export async function editTag(
  db: Database,
  id: string,
  userId: string,
  patch: UpdateTagInput,
): Promise<Tag> {
  return withTransaction(db, async (tx) => {
    const [existing] = await findTagById(tx, id, userId);
    if (!existing) throw new NotFoundError('Tag', id);
    try {
      const [row] = await updateTag(tx, id, userId, patch);
      return toTag(row);
    } catch (err: unknown) {
      if (isPgError(err) && err.code === '23505') throw new TagNameTakenError();
      throw err;
    }
  });
}

/** Delete an owned tag; join rows cascade. Zero rows → 404. Never refused for being in use. */
export async function removeTag(db: Database, id: string, userId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const deleted = await deleteTag(tx, id, userId);
    if (deleted.length === 0) throw new NotFoundError('Tag', id);
  });
}

/** Replace a position's whole tag set; owns its transaction. */
export async function setPositionTags(
  db: Database,
  positionId: string,
  userId: string,
  tagIds: string[],
): Promise<Tag[]> {
  return withTransaction(db, (tx) => setPositionTagsTx(tx, positionId, userId, tagIds));
}

/**
 * Replace a position's tag set inside a caller-supplied transaction (the demo
 * seed calls this directly). Ownership is checked before the cap (REQ-2.2), and
 * the delete-then-insert is the pinned atomicity mechanism: a partial set is
 * never observable.
 */
export async function setPositionTagsTx(
  tx: Transaction,
  positionId: string,
  userId: string,
  tagIds: string[],
): Promise<Tag[]> {
  const [position] = await findPositionById(tx, positionId, userId);
  if (!position) throw new NotFoundError('Position', positionId);

  const distinct = Array.from(new Set(tagIds));
  const owned = new Set(await findOwnedTagIds(tx, userId, distinct));
  const missing = distinct.find((id) => !owned.has(id));
  if (missing) throw new NotFoundError('Tag', missing);

  if (distinct.length > TAG_LIMITS.perPosition) throw new TagLimitError(TAG_LIMITS.perPosition);

  try {
    await replacePositionTags(tx, positionId, distinct);
  } catch (err: unknown) {
    // A tag deleted between the ownership check and the insert (23503 on tag_id).
    if (isPgError(err) && err.code === '23503' && err.detail?.includes('tag_id')) {
      throw new NotFoundError('Tag', 'deleted');
    }
    throw err;
  }

  return findTagsByPosition(tx, positionId);
}

/**
 * Insert the starter tags the user does not yet have, idempotent by name
 * (case-insensitive). Returns the merged `lower(name)` → id map and the rows
 * this call created. Throws the per-user cap before inserting anything.
 */
export async function ensureStarterTagsTx(
  tx: Transaction,
  userId: string,
): Promise<{ byLowerName: Map<string, string>; created: Tag[] }> {
  const byLowerName = await findLowerTagNamesByUser(tx, userId);
  const missing = STARTER_TAGS.filter((t) => !byLowerName.has(t.name.toLowerCase()));
  if (missing.length === 0) return { byLowerName, created: [] };

  if (byLowerName.size + missing.length > TAG_LIMITS.perUser) {
    throw new TagLimitError(TAG_LIMITS.perUser);
  }

  const created: Tag[] = [];
  for (const entry of missing) {
    const [row] = await insertTag(tx, {
      userId,
      name: entry.name,
      category: entry.category,
      color: null,
    });
    const tag = toTag(row);
    created.push(tag);
    byLowerName.set(entry.name.toLowerCase(), tag.id);
  }
  return { byLowerName, created };
}

/** Stamp the starter-offer answer time (first answer wins). */
export async function recordStarterAnswerTx(
  tx: Transaction,
  userId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await setStarterTagsAnsweredAt(tx, userId, now);
}

/**
 * Answer the one-shot starter-tags offer. `accept` ensures the starter set
 * exists; both branches record the answer time. After commit, a guarded
 * fire-and-forget event carries the outcome only, never a tag name (REQ-9.1).
 */
export async function answerStarterOffer(
  db: Database,
  userId: string,
  answer: StarterAnswer['answer'],
): Promise<StarterAnswerResult> {
  const result = await withTransaction(db, async (tx) => {
    let created: Tag[] = [];
    if (answer === 'accept') {
      ({ created } = await ensureStarterTagsTx(tx, userId));
    }
    await recordStarterAnswerTx(tx, userId);
    return { answer, created };
  });
  try {
    captureServerEvent('starter_tags_answered', {
      distinctId: userId,
      properties: { outcome: answer === 'accept' ? 'accepted' : 'declined' },
    });
  } catch {
    // ignore — capture is fire-and-forget
  }
  return result;
}
