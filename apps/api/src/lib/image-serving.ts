// Shared helpers for the image proxies (advisor message images and position
// images). One content-type map, one cache-control constant, one 404-vs-503
// discriminator and one buffer copy so both proxies stay in step (design D19).

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// Browser-cacheable but never by a shared cache — the bytes are per-user
// (design §Component 2).
export const IMAGE_CACHE_CONTROL = 'private, max-age=300';

/**
 * Whether an `ObjectUnreachableError.cause` denotes a genuinely-absent object
 * (S3/R2 `NoSuchKey` / HTTP 404) rather than a transport outage. Task 5's
 * adapter folds object-gone INTO `ObjectUnreachableError` but preserves the raw
 * SDK error on `.cause`, so the proxy inspects it to discriminate 404 (gone)
 * from 503 (store down).
 */
export function isMissingObject(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const c = cause as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return c.name === 'NoSuchKey' || c.$metadata?.httpStatusCode === 404;
}

/** Copy the bytes' backing region into a standalone ArrayBuffer for the response. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
