// Ownership-scoped advisor image proxy (hosted-platform Task 9; design
// §Component 2, D1; REQ-2.4/12.3).
//
// A side-effect-free GET that streams the bytes of the image content-part at a
// given index on a message the authenticated user owns. Object access is
// proxy-through-API (D1) — there are NO presigned URLs and the object-storage
// key is resolved SERVER-SIDE and never appears in the URL or any response (no
// IDOR leak). A missing/not-owned conversation-or-message, an out-of-range or
// non-image index, an `unrecoverable` marker, and a genuinely-absent object all
// return the identical 404 (no existence oracle). A transient object-store
// outage returns 503 (OBJECT_UNREACHABLE) plus a §19 warn.

import type { Context } from 'hono';

import type { StoredContentPart } from '@tradr/shared';

import { NotFoundError } from '@/lib/errors';
import {
  IMAGE_CACHE_CONTROL,
  IMAGE_CONTENT_TYPES,
  isMissingObject,
  toArrayBuffer,
} from '@/lib/image-serving';
import { logger } from '@/lib/logger';
import { getObjectStorage, ObjectUnreachableError } from '@/lib/object-storage';

import { getOwnedMessageParts } from './advisor.service';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

export async function getMessageImageHandler(c: Context<AuthEnv>) {
  const userId = c.get('userId');
  const conversationId = c.req.param('conversationId') as string;
  const messageId = c.req.param('messageId') as string;
  const indexRaw = c.req.param('index') as string;
  const index = Number(indexRaw);

  // A missing/not-owned resource and a bad index share one 404 (no oracle).
  const notFound = () => new NotFoundError('Image', `${messageId}/${indexRaw}`);

  if (!Number.isInteger(index) || index < 0) throw notFound();

  // Single ownership-scoped read: null ⇒ missing OR not owned (indistinguishable).
  const parts = await getOwnedMessageParts({ conversationId, messageId, userId });
  if (parts === null) throw notFound();

  const part = parts[index] as StoredContentPart | undefined;
  if (!part || part.type !== 'image') throw notFound();

  // Pointer: read the bytes server-side (the key never leaves the server).
  if ('storage' in part) {
    if (part.storage.kind === 'unrecoverable') throw notFound();
    const storage = getObjectStorage();
    // A pointer with storage unconfigured is unresolvable — treat as gone.
    if (storage === null) throw notFound();
    try {
      const { bytes, contentType } = await storage.get(part.storage.key);
      return c.body(toArrayBuffer(bytes), 200, {
        'Content-Type': contentType,
        'Cache-Control': IMAGE_CACHE_CONTROL,
      });
    } catch (err) {
      // Task 5 folds object-gone into ObjectUnreachableError; inspect `.cause`
      // to separate a genuinely-missing object (→ 404) from a store outage.
      if (err instanceof ObjectUnreachableError && isMissingObject(err.cause)) {
        throw notFound();
      }
      logger.warn('object store unreachable serving image proxy', {
        event: 'object-store-unreachable',
        conversationId,
        messageId,
        index,
      });
      throw err; // ObjectUnreachableError → 503 via the error middleware.
    }
  }

  // Inline / legacy: decode the base64 bytes in hand.
  const bytes = Buffer.from(part.dataBase64, 'base64');
  return c.body(toArrayBuffer(bytes), 200, {
    'Content-Type': IMAGE_CONTENT_TYPES[part.format] ?? 'application/octet-stream',
    'Cache-Control': IMAGE_CACHE_CONTROL,
  });
}
