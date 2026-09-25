/**
 * Unit tests for the per-user object-storage purge (§39; design C9;
 * Req 5.1-5.3). Exercises `purgeUserObjects` against an in-memory fake bucket
 * modelled on the `FakeStorage` used by the gc integration test
 * (apps/api/src/cli/storage-maintenance.integration.test.ts:76-109), including a
 * fake whose `delete` swallows the call and leaves the key (the S3 best-effort
 * delete that swallows transport errors, s3-storage.ts:75-87).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { logger } from '../logger';

import { purgeUserObjects } from './purge';

import { ObjectUnreachableError, type ObjectStorage } from './index';

// --- Controllable in-memory bucket -------------------------------------------------

class FakeStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string; lastModified: Date }>();
  deleted: string[] = [];

  seed(key: string): void {
    this.objects.set(key, {
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
      lastModified: new Date(),
    });
  }

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType, lastModified: new Date() });
    return Promise.resolve();
  }

  // Unused by the purge; a resolved stub keeps the interface satisfied.
  get(): Promise<{ bytes: Uint8Array; contentType: string }> {
    return Promise.resolve({ bytes: new Uint8Array(), contentType: 'image/png' });
  }

  delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, lastModified: o.lastModified })),
    );
  }
}

/** A fake whose delete swallows the call and leaves the key (best-effort S3 delete). */
class SwallowingDeleteStorage extends FakeStorage {
  override delete(key: string): Promise<void> {
    this.deleted.push(key);
    // Records the attempt but leaves the object, so the re-list is non-empty.
    return Promise.resolve();
  }
}

/** A fake whose list throws, standing in for an unreachable bucket. */
class ListThrowsStorage extends FakeStorage {
  override list(): Promise<Array<{ key: string; lastModified: Date }>> {
    throw new ObjectUnreachableError('list failed');
  }
}

const userId = '11111111-1111-1111-1111-111111111111';
const otherId = '22222222-2222-2222-2222-222222222222';

describe('purgeUserObjects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns not_applicable when object storage is unconfigured (null)', async () => {
    expect(await purgeUserObjects(null, userId)).toBe('not_applicable');
  });

  it('deletes every object under both user prefixes and returns complete', async () => {
    const storage = new FakeStorage();
    storage.seed(`advisor/${userId}/a.png`);
    storage.seed(`advisor/${userId}/b.png`);
    storage.seed(`positions/${userId}/c.png`);
    // Another user's object must survive — the purge is per user.
    storage.seed(`advisor/${otherId}/keep.png`);

    const outcome = await purgeUserObjects(storage, userId);

    expect(outcome).toBe('complete');
    expect([...storage.objects.keys()]).toEqual([`advisor/${otherId}/keep.png`]);
    expect(storage.deleted).toEqual(
      expect.arrayContaining([
        `advisor/${userId}/a.png`,
        `advisor/${userId}/b.png`,
        `positions/${userId}/c.png`,
      ]),
    );
  });

  it('returns incomplete with a warn when delete swallows and leaves the key', async () => {
    const storage = new SwallowingDeleteStorage();
    storage.seed(`positions/${userId}/stuck.png`);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const outcome = await purgeUserObjects(storage, userId);

    expect(outcome).toBe('incomplete');
    expect(storage.deleted).toContain(`positions/${userId}/stuck.png`);
    expect(storage.objects.has(`positions/${userId}/stuck.png`)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('purge'),
      expect.objectContaining({ userId, prefix: 'positions/' }),
    );
  });

  it('returns incomplete with a warn when a list throws', async () => {
    const storage = new ListThrowsStorage();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const outcome = await purgeUserObjects(storage, userId);

    expect(outcome).toBe('incomplete');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('purge'),
      expect.objectContaining({ userId }),
    );
  });
});
