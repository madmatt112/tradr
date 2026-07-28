import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { logger } from '../logger';

import { ObjectUnreachableError, type ObjectStorage } from './index';

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * S3-compatible object store (Cloudflare R2 / AWS S3 / MinIO). All addressing is
 * via `{ endpoint, region, credentials, forcePathStyle }` — `forcePathStyle` is
 * required for MinIO and path-style S3. Bytes are proxied through the API; there
 * is no presigner (D1).
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3StorageConfig) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      forcePathStyle: cfg.forcePathStyle,
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
    } catch (cause) {
      throw new ObjectUnreachableError(`Failed to put object ${key}`, cause);
    }
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) {
        throw new Error('GetObject returned an empty body');
      }
      const bytes = await res.Body.transformToByteArray();
      return { bytes, contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (cause) {
      // Any failure to fetch the bytes — transport error or a gone-out-of-band
      // object — is unrecoverable for this read; never return null (REQ-2.6).
      throw new ObjectUnreachableError(`Failed to get object ${key}`, cause);
    }
  }

  async delete(key: string): Promise<void> {
    // Best-effort and idempotent (REQ-2.4): S3 DeleteObject already succeeds for a
    // missing key, and a transport failure is swallowed (warn-logged) so reclamation
    // never blocks — the age-guarded gc sweep (Component 9) is the backstop.
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (cause) {
      logger.warn('object-storage delete failed (ignored, best-effort)', {
        key,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
    const objects: Array<{ key: string; lastModified: Date }> = [];
    let continuationToken: string | undefined;
    try {
      do {
        const res = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of res.Contents ?? []) {
          if (obj.Key) {
            objects.push({ key: obj.Key, lastModified: obj.LastModified ?? new Date(0) });
          }
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (cause) {
      throw new ObjectUnreachableError(`Failed to list objects under ${prefix}`, cause);
    }
    return objects;
  }
}
