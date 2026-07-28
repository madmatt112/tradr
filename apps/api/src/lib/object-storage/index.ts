import { randomUUID } from 'node:crypto';

import { config, isObjectStorageConfigured } from '../config';
import { AppError } from '../errors';

import { S3ObjectStorage } from './s3-storage';

/**
 * Thrown when an object-storage transport operation fails (network / auth error,
 * or a read whose object cannot be fetched). `get` MUST throw this rather than
 * return null on failure, so callers can surface a contained error (proxy → 503,
 * `resolveForProvider` → `[image unavailable]`) instead of silently emitting a
 * bytes-less image (REQ-2.6). Extends `AppError(503)` so the error middleware
 * maps it to a 503 automatically.
 */
export class ObjectUnreachableError extends AppError {
  constructor(message = 'Object storage is unreachable', cause?: unknown) {
    super(503, 'OBJECT_UNREACHABLE', message);
    this.name = 'ObjectUnreachableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Backend-agnostic object store for advisor images. Absent (getObjectStorage →
 * null) when unconfigured — self-host parity, images stay inline (REQ-1 / REQ-2.1);
 * an S3-compatible adapter (Cloudflare R2 / AWS S3 / MinIO) otherwise.
 */
export interface ObjectStorage {
  /** Write `bytes` under `key`. Throws ObjectUnreachableError on transport failure. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /**
   * Read the object at `key`. Throws ObjectUnreachableError on transport failure
   * (never returns null) so an unfetchable object is a contained error, not a
   * bytes-less success (REQ-2.6).
   */
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Best-effort, idempotent delete — deleting a missing key is not an error (REQ-2.4). */
  delete(key: string): Promise<void>;
  /** List objects under `prefix`, for the age-guarded gc sweep (Component 9). */
  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>>;
}

/**
 * The configured object-storage backend, or `null` when unconfigured (REQ-1
 * self-host parity, REQ-2.1). Mirrors the `isStripeConfigured()` graceful-absence
 * idiom: every object-storage caller branches on this single null check and falls
 * back to inline base64 when it is null.
 */
export function getObjectStorage(): ObjectStorage | null {
  if (!isObjectStorageConfigured()) return null;
  return new S3ObjectStorage({
    // isObjectStorageConfigured() guarantees endpoint + bucket + credentials are
    // present; the predicate cannot narrow the config types across the call.
    endpoint: config.OBJECT_STORAGE_ENDPOINT!,
    region: config.OBJECT_STORAGE_REGION ?? 'auto',
    bucket: config.OBJECT_STORAGE_BUCKET!,
    accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: config.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
    forcePathStyle: config.OBJECT_STORAGE_FORCE_PATH_STYLE,
  });
}

/**
 * The bucket key for a new advisor image: `advisor/{userId}/{randomUUID()}` (D9).
 * The id is random and generated at the write seam; resolution and gc never parse
 * it for identity, so it needs no messageId / conversationId and is available
 * before persistence with no signature change.
 */
export function advisorImageKey(userId: string): string {
  return `advisor/${userId}/${randomUUID()}`;
}
