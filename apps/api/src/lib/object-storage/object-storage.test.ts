import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../logger';

import { S3ObjectStorage } from './s3-storage';

import { advisorImageKey, getObjectStorage, ObjectUnreachableError } from './index';

const s3Mock = mockClient(S3Client);

const TEST_CONFIG = {
  endpoint: 'https://example.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'test-bucket',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  forcePathStyle: true,
};

/** Wrap a byte payload as an SDK-streamed GetObject Body (has transformToByteArray). */
function streamBody(bytes: Uint8Array) {
  return sdkStreamMixin(Readable.from([Buffer.from(bytes)]));
}

describe('S3ObjectStorage', () => {
  let storage: S3ObjectStorage;

  beforeEach(() => {
    s3Mock.reset();
    storage = new S3ObjectStorage(TEST_CONFIG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('put', () => {
    it('sends a PutObjectCommand with bucket, key, body and content type', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const bytes = new Uint8Array([1, 2, 3]);

      await storage.put('advisor/u1/abc', bytes, 'image/png');

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'advisor/u1/abc',
        Body: bytes,
        ContentType: 'image/png',
      });
    });

    it('throws ObjectUnreachableError on a transport failure', async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error('connection refused'));

      await expect(
        storage.put('advisor/u1/abc', new Uint8Array([1]), 'image/png'),
      ).rejects.toBeInstanceOf(ObjectUnreachableError);
    });
  });

  describe('get', () => {
    it('returns the object bytes and content type', async () => {
      const payload = new Uint8Array([10, 20, 30]);
      s3Mock
        .on(GetObjectCommand)
        .resolves({ Body: streamBody(payload), ContentType: 'image/jpeg' });

      const result = await storage.get('advisor/u1/abc');

      expect(Array.from(result.bytes)).toEqual([10, 20, 30]);
      expect(result.contentType).toBe('image/jpeg');
      expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'advisor/u1/abc',
      });
    });

    it('falls back to application/octet-stream when the response omits a content type', async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: streamBody(new Uint8Array([1])) });

      const result = await storage.get('advisor/u1/abc');

      expect(result.contentType).toBe('application/octet-stream');
    });

    it('throws ObjectUnreachableError on a transport failure (never returns null)', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('connection reset'));

      const result = storage.get('advisor/u1/abc');
      await expect(result).rejects.toBeInstanceOf(ObjectUnreachableError);
      await expect(result).rejects.not.toBeNull();
    });

    it('throws ObjectUnreachableError when the response has no body', async () => {
      s3Mock.on(GetObjectCommand).resolves({});

      await expect(storage.get('advisor/u1/abc')).rejects.toBeInstanceOf(ObjectUnreachableError);
    });
  });

  describe('delete', () => {
    it('sends a DeleteObjectCommand and is idempotent for a missing key', async () => {
      s3Mock.on(DeleteObjectCommand).resolves({});

      await expect(storage.delete('advisor/u1/missing')).resolves.toBeUndefined();
      expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'advisor/u1/missing',
      });
    });

    it('is best-effort — swallows a transport failure and warns rather than throwing', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      s3Mock.on(DeleteObjectCommand).rejects(new Error('network down'));

      await expect(storage.delete('advisor/u1/abc')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('list', () => {
    it('maps Contents to {key, lastModified} and paginates via the continuation token', async () => {
      const first = new Date('2020-01-01T00:00:00.000Z');
      const second = new Date('2020-02-01T00:00:00.000Z');
      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: 'advisor/u1/a', LastModified: first }],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        })
        .resolves({
          Contents: [{ Key: 'advisor/u1/b', LastModified: second }],
          IsTruncated: false,
        });

      const result = await storage.list('advisor/u1/');

      expect(result).toEqual([
        { key: 'advisor/u1/a', lastModified: first },
        { key: 'advisor/u1/b', lastModified: second },
      ]);
      const calls = s3Mock.commandCalls(ListObjectsV2Command);
      expect(calls).toHaveLength(2);
      expect(calls[0].args[0].input).toMatchObject({
        Prefix: 'advisor/u1/',
        ContinuationToken: undefined,
      });
      expect(calls[1].args[0].input).toMatchObject({ ContinuationToken: 'page-2' });
    });

    it('returns an empty array when the prefix has no objects', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({});

      await expect(storage.list('advisor/u1/')).resolves.toEqual([]);
    });

    it('throws ObjectUnreachableError on a transport failure', async () => {
      s3Mock.on(ListObjectsV2Command).rejects(new Error('timeout'));

      await expect(storage.list('advisor/u1/')).rejects.toBeInstanceOf(ObjectUnreachableError);
    });
  });
});

describe('ObjectUnreachableError', () => {
  it('is a 503 AppError with the OBJECT_UNREACHABLE code and preserves the cause', () => {
    const cause = new Error('root cause');
    const err = new ObjectUnreachableError('boom', cause);

    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('OBJECT_UNREACHABLE');
    expect(err.cause).toBe(cause);
  });
});

describe('getObjectStorage', () => {
  it('returns null when object storage is unconfigured (self-host parity)', () => {
    // The vitest workspace pins every OBJECT_STORAGE_* var off, so the feature is a
    // no-op and callers fall back to inline base64 (REQ-1.6 / REQ-2.1).
    expect(getObjectStorage()).toBeNull();
  });
});

describe('advisorImageKey', () => {
  it('generates a random advisor/{userId}/{uuid} key (D9)', () => {
    const key = advisorImageKey('user-42');
    expect(key).toMatch(
      /^advisor\/user-42\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Random per call — no dependence on message/conversation identity.
    expect(advisorImageKey('user-42')).not.toBe(key);
  });
});
