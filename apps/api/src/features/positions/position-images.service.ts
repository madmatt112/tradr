// Position screenshots service (design §Component 4). The ONE place that orders
// bucket and database work for the three operations: upload, serve and remove.
//
// Upload runs put-before-persist with NO pooled DB connection held across the
// bucket round-trip (REQ-2.7, mirrors streaming.ts:1252-1267), and takes NO
// compensating object delete when a step after the put fails — the orphan is
// reclaimed by the age-guarded gc (D20). Serving mirrors the advisor image proxy
// branch for branch (image-proxy.handler.ts): one shared 404 for missing,
// not-owned, unrecoverable, storage-off and gone-object; a 503 with a warn for a
// store outage (Error Handling item 7). The positions slice never imports from
// advisor — the shared seams live in `lib/` (D19).

import {
  POSITION_IMAGE_MAX_COUNT,
  type PositionImage,
  type StoredContentPart,
} from '@tradr/shared';

import type { Database } from '@/db';
import { ImageFormatMismatchError, NotFoundError, PositionImageLimitError } from '@/lib/errors';
import { matchesContainerSignature, stripImageMetadata } from '@/lib/image-metadata';
import { IMAGE_CONTENT_TYPES, isMissingObject } from '@/lib/image-serving';
import { logger } from '@/lib/logger';
import { getObjectStorage, ObjectUnreachableError, positionImageKey } from '@/lib/object-storage';
import { withTransaction } from '@/lib/transaction';

import {
  countPositionImages,
  deleteOwnedPositionImage,
  findOwnedPositionImage,
  insertPositionImage,
} from './position-images.query';
import { findPositionById, findPositionForUpdate } from './positions.query';

// Re-exported for the positions DELETE route (design §Component 4 / §Component 8):
// the route collects an owned position's pointer keys before the cascade delete.
export { collectPositionImageKeys } from './position-images.query';

/**
 * Store one screenshot for a position the caller owns and return its record
 * (design §Component 4). Order is load-bearing:
 *
 * 1. decode `dataBase64`;
 * 2. the declared `format` must carry its own container signature else
 *    `ImageFormatMismatchError` (REQ-2.3 / D5) — nothing is stored;
 * 3. strip container metadata (no re-encode, REQ-3.5);
 * 4. a cheap ownership pre-check with `findPositionById` OUTSIDE any transaction,
 *    before any bucket write (Error Handling item 4), so no pooled connection is
 *    held across the put (REQ-2.7);
 * 5. `getObjectStorage()` — when configured, put the bytes and persist a pointer;
 *    inline base64 when null (self-host parity, REQ-3.1 / 3.2);
 * 6. under the position's row lock, re-check ownership and the count cap, insert.
 *
 * No compensating object delete when the lock or cap step fails after the put:
 * the orphan is a gc reclaim, and the error path stays one round-trip (D20).
 */
export async function uploadPositionImage(
  db: Database,
  args: { positionId: string; userId: string; format: PositionImage['format']; dataBase64: string },
): Promise<{ id: string; format: PositionImage['format']; createdAt: string }> {
  const { positionId, userId, format, dataBase64 } = args;

  // (1) decode
  const bytes = Buffer.from(dataBase64, 'base64');

  // (2) the declared format must match the bytes' container signature.
  if (!matchesContainerSignature(format, bytes)) throw new ImageFormatMismatchError();

  // (3) strip container metadata (returns the input unchanged when nothing safe
  // to strip).
  const stripped = stripImageMetadata(format, bytes);

  // (4) ownership pre-check before any bucket write, outside any transaction.
  const [position] = await findPositionById(db, positionId, userId);
  if (!position) throw new NotFoundError('Position', positionId);

  // (5) put-before-persist: write the bytes and persist a pointer; inline when
  // storage is unconfigured.
  const storage = getObjectStorage();
  let part: StoredContentPart;
  if (storage) {
    const key = positionImageKey(userId);
    await storage.put(key, stripped, IMAGE_CONTENT_TYPES[format]);
    part = { type: 'image', format, storage: { kind: 'object', key } };
  } else {
    part = { type: 'image', format, dataBase64: stripped.toString('base64') };
  }

  // (6) re-check the position under its row lock, enforce the count cap, insert.
  const row = await withTransaction(db, async (tx) => {
    const lockRows = await findPositionForUpdate(tx, positionId, userId);
    if ((lockRows as unknown[]).length === 0) throw new NotFoundError('Position', positionId);

    const count = await countPositionImages(tx, positionId);
    if (count >= POSITION_IMAGE_MAX_COUNT) {
      throw new PositionImageLimitError(POSITION_IMAGE_MAX_COUNT);
    }

    return insertPositionImage(tx, { positionId, part });
  });

  return { id: row.id, format, createdAt: row.createdAt.toISOString() };
}

/**
 * The bytes and content type of one screenshot the caller owns, for the serving
 * route (design §Component 4). Follows the advisor image proxy branch for branch
 * (image-proxy.handler.ts:44-83): a `null` part, an `unrecoverable` record and a
 * pointer with storage off all throw the one `NotFoundError('Image', imageId)`
 * (no existence oracle, REQ-5.4); a pointer `get` whose `cause` passes
 * `isMissingObject` becomes that same 404; any other `ObjectUnreachableError` is
 * warn-logged and rethrown as a 503 (Error Handling item 7).
 */
export async function getPositionImage(
  db: Database,
  args: { positionId: string; userId: string; imageId: string },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { positionId, userId, imageId } = args;

  // A missing/not-owned image and an unknown id share one 404 (no oracle).
  const notFound = () => new NotFoundError('Image', imageId);

  // Single ownership-scoped read: null ⇒ missing OR not owned (indistinguishable).
  const part = await findOwnedPositionImage(db, { positionId, imageId, userId });
  if (part === null || part.type !== 'image') throw notFound();

  // Pointer: read the bytes server-side (the key never leaves the server).
  if ('storage' in part) {
    if (part.storage.kind === 'unrecoverable') throw notFound();
    const storage = getObjectStorage();
    // A pointer with storage unconfigured is unresolvable — treat as gone.
    if (storage === null) throw notFound();
    try {
      return await storage.get(part.storage.key);
    } catch (err) {
      // The adapter folds object-gone into ObjectUnreachableError; inspect
      // `.cause` to separate a genuinely-missing object (→ 404) from a store
      // outage (→ 503).
      if (err instanceof ObjectUnreachableError && isMissingObject(err.cause)) {
        throw notFound();
      }
      logger.warn('object store unreachable serving position image', {
        event: 'object-store-unreachable',
        positionId,
        imageId,
      });
      throw err; // ObjectUnreachableError → 503 via the error middleware.
    }
  }

  // Inline / legacy: decode the base64 bytes in hand.
  const bytes = Buffer.from(part.dataBase64, 'base64');
  return {
    bytes,
    contentType: IMAGE_CONTENT_TYPES[part.format] ?? 'application/octet-stream',
  };
}

/**
 * Delete one screenshot the caller owns (design §Component 4). The row is
 * deleted in a transaction; a `null` return (no owned row matched) is a 404
 * (Error Handling item 8). After the commit, when the deleted part was a live
 * pointer and storage is configured, the object is deleted best-effort — a
 * failure is warn-logged and NEVER fatal (the request still returns 204), with
 * the age-guarded gc as the backstop (crud.handler.ts:139-153).
 */
export async function removePositionImage(
  db: Database,
  args: { positionId: string; userId: string; imageId: string },
): Promise<void> {
  const { positionId, userId, imageId } = args;

  const part = await withTransaction(db, async (tx) => {
    const deleted = await deleteOwnedPositionImage(tx, { positionId, imageId, userId });
    if (deleted === null) throw new NotFoundError('Image', imageId);
    return deleted;
  });

  if ('storage' in part && part.storage.kind === 'object') {
    const storage = getObjectStorage();
    if (storage) {
      const { key } = part.storage;
      try {
        await storage.delete(key);
      } catch (err) {
        logger.warn('position image reclamation delete failed', {
          event: 'object-store-unreachable',
          userId,
          positionId,
          imageId,
          key,
          error: (err as Error).message,
        });
      }
    }
  }
}
