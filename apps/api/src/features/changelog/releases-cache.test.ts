// Unit tests for the releases cache (design Component 4, REQ-2.1–2.6,
// REQ-2.8). Fake loader + vi.useFakeTimers — no HTTP, no DB. TTL params are
// injected ONLY here; prod constructs with the module constants.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangelogRelease } from '@tradr/shared';

import {
  ChangelogUnavailableError,
  NEGATIVE_CACHE_MS,
  RELEASES_TTL_MS,
  ReleasesCache,
} from './releases-cache';

const TTL = 1_000;
const NEG = 300;

function release(id: string): ChangelogRelease {
  return {
    id,
    name: `Release ${id}`,
    tag: `v${id}`,
    publishedAt: '2026-01-01T00:00:00.000Z',
    body: 'Notes',
    htmlUrl: `https://github.com/owner/repo/releases/tag/v${id}`,
    prerelease: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** White-box view of the private failure marker (see the clears-lastFailureAt test). */
function lastFailureAt(cache: ReleasesCache): number | null {
  return (cache as unknown as { lastFailureAt: number | null }).lastFailureAt;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReleasesCache — constants (REQ-2.3 budget)', () => {
  it('pins TTL=900s and negative-cache=300s as module constants', () => {
    expect(RELEASES_TTL_MS).toBe(15 * 60 * 1000);
    expect(NEGATIVE_CACHE_MS).toBe(5 * 60 * 1000);
  });
});

describe('ReleasesCache — fresh hit (REQ-2.1/2.2)', () => {
  it('serves a fresh snapshot without calling the loader, stale: false', async () => {
    const loader = vi.fn(async () => [release('1')]);
    const cache = new ReleasesCache(loader, TTL, NEG);

    const first = await cache.get();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.stale).toBe(false);
    expect(first.snapshot.releases).toEqual([release('1')]);
    expect(first.snapshot.fetchedAt).toBe(0);

    vi.advanceTimersByTime(TTL - 1);
    const second = await cache.get();
    expect(loader).toHaveBeenCalledTimes(1); // no fetch started
    expect(second.stale).toBe(false);
    expect(second.snapshot).toBe(first.snapshot);
  });

  it('refetches after TTL expiry and serves the new snapshot fresh', async () => {
    const loader = vi
      .fn<() => Promise<ChangelogRelease[]>>()
      .mockResolvedValueOnce([release('1')])
      .mockResolvedValueOnce([release('2')]);
    const cache = new ReleasesCache(loader, TTL, NEG);

    await cache.get();
    vi.advanceTimersByTime(TTL); // exactly at expiry → no longer fresh

    const result = await cache.get();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.stale).toBe(false);
    expect(result.snapshot.releases).toEqual([release('2')]);
    expect(result.snapshot.fetchedAt).toBe(TTL);
  });
});

describe('ReleasesCache — single-flight (REQ-2.2)', () => {
  it('cold-boot burst: N concurrent get() → 1 loader call, all awaiters resolve together', async () => {
    const d = deferred<ChangelogRelease[]>();
    const loader = vi.fn(() => d.promise);
    const cache = new ReleasesCache(loader, TTL, NEG);

    const burst = Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(loader).toHaveBeenCalledTimes(1);

    d.resolve([release('1')]);
    const results = await burst;
    expect(loader).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.stale).toBe(false);
      expect(r.snapshot).toBe(results[0].snapshot);
    }
  });

  it('cold-boot failure burst: 1 loader call, all awaiters throw ChangelogUnavailableError together', async () => {
    const d = deferred<ChangelogRelease[]>();
    const loader = vi.fn(() => d.promise);
    const cache = new ReleasesCache(loader, TTL, NEG);

    const burst = Promise.allSettled([cache.get(), cache.get(), cache.get()]);
    expect(loader).toHaveBeenCalledTimes(1);

    d.reject(new Error('boom'));
    const results = await burst;
    expect(loader).toHaveBeenCalledTimes(1); // the burst counted as ONE upstream call
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(ChangelogUnavailableError);
      }
    }
  });

  it('warm + in-flight: serves the existing snapshot immediately with derived stale, no second fetch', async () => {
    const d = deferred<ChangelogRelease[]>();
    const loader = vi
      .fn<() => Promise<ChangelogRelease[]>>()
      .mockResolvedValueOnce([release('1')])
      .mockImplementationOnce(() => d.promise);
    const cache = new ReleasesCache(loader, TTL, NEG);

    await cache.get(); // warm
    vi.advanceTimersByTime(TTL); // expired

    const refreshing = cache.get(); // starts the refresh, pends on the deferred
    expect(loader).toHaveBeenCalledTimes(2);

    const during = await cache.get(); // arrives while the refresh is in flight
    expect(loader).toHaveBeenCalledTimes(2); // no second fetch started
    expect(during.stale).toBe(true);
    expect(during.snapshot.releases).toEqual([release('1')]);

    d.resolve([release('2')]);
    const refreshed = await refreshing;
    expect(refreshed.stale).toBe(false);
    expect(refreshed.snapshot.releases).toEqual([release('2')]);
  });
});

describe('ReleasesCache — stale-on-error (REQ-2.4)', () => {
  it('serves the stale snapshot when a refresh fails, with unbounded staleness past many TTLs', async () => {
    const loader = vi
      .fn<() => Promise<ChangelogRelease[]>>()
      .mockResolvedValueOnce([release('1')])
      .mockRejectedValue(new Error('boom'));
    const cache = new ReleasesCache(loader, TTL, NEG);

    await cache.get(); // warm at t=0

    vi.advanceTimersByTime(TTL + 1);
    const first = await cache.get(); // refresh fails → stale-serve
    expect(loader).toHaveBeenCalledTimes(2);
    expect(first.stale).toBe(true);
    expect(first.snapshot.releases).toEqual([release('1')]);

    // No staleness ceiling: thousands of TTLs later (each step past the
    // negative window, so the loader is retried and fails again) the
    // month-old snapshot still serves.
    for (const offset of [100 * TTL, 5_000 * TTL, 50_000 * TTL]) {
      vi.setSystemTime(offset);
      const result = await cache.get();
      expect(result.stale).toBe(true);
      expect(result.snapshot.releases).toEqual([release('1')]);
    }
    expect(loader).toHaveBeenCalledTimes(5);
  });
});

describe('ReleasesCache — negative cache (REQ-2.5/2.6)', () => {
  it('cold-empty + failing loader throws ChangelogUnavailableError', async () => {
    const loader = vi.fn(async (): Promise<ChangelogRelease[]> => {
      throw new Error('boom');
    });
    const cache = new ReleasesCache(loader, TTL, NEG);

    await expect(cache.get()).rejects.toBeInstanceOf(ChangelogUnavailableError);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('suppresses upstream calls during the window, then retries after expiry', async () => {
    const loader = vi
      .fn<() => Promise<ChangelogRelease[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([release('1')]);
    const cache = new ReleasesCache(loader, TTL, NEG);

    await expect(cache.get()).rejects.toBeInstanceOf(ChangelogUnavailableError); // failure at t=0

    vi.advanceTimersByTime(NEG - 1);
    await expect(cache.get()).rejects.toBeInstanceOf(ChangelogUnavailableError);
    expect(loader).toHaveBeenCalledTimes(1); // suppressed — no upstream call

    vi.advanceTimersByTime(1); // window expired (now − lastFailureAt ≥ NEG)
    const result = await cache.get();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.stale).toBe(false);
    expect(result.snapshot.releases).toEqual([release('1')]);
  });

  it('serves stale from a warm cache during the window without an upstream call', async () => {
    const loader = vi
      .fn<() => Promise<ChangelogRelease[]>>()
      .mockResolvedValueOnce([release('1')])
      .mockRejectedValue(new Error('boom'));
    const cache = new ReleasesCache(loader, TTL, NEG);

    await cache.get(); // warm at t=0
    vi.advanceTimersByTime(TTL); // expired
    const failed = await cache.get(); // refresh fails → lastFailureAt = TTL
    expect(loader).toHaveBeenCalledTimes(2);
    expect(failed.stale).toBe(true);

    vi.advanceTimersByTime(NEG - 1); // inside the negative window
    const suppressed = await cache.get();
    expect(loader).toHaveBeenCalledTimes(2); // no upstream call
    expect(suppressed.stale).toBe(true);
    expect(suppressed.snapshot.releases).toEqual([release('1')]);

    vi.advanceTimersByTime(1); // window expired → retry allowed
    const retried = await cache.get();
    expect(loader).toHaveBeenCalledTimes(3);
    expect(retried.stale).toBe(true); // retry failed again → still stale-serving
  });

  it('a successful fetch clears lastFailureAt', async () => {
    // The clearing is not black-box observable: a success can only happen
    // after the window has expired, and an expired window stays expired. So
    // this one assertion is white-box, against the private field.
    const loader = vi
      .fn<() => Promise<ChangelogRelease[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([release('1')]);
    const cache = new ReleasesCache(loader, TTL, NEG);

    await expect(cache.get()).rejects.toBeInstanceOf(ChangelogUnavailableError);
    expect(lastFailureAt(cache)).toBe(0);

    vi.advanceTimersByTime(NEG);
    await cache.get(); // success
    expect(lastFailureAt(cache)).toBeNull();
  });
});

describe('ReleasesCache — empty list is a success (REQ-1.7)', () => {
  it('caches an empty-list result like any other snapshot', async () => {
    const loader = vi.fn(async (): Promise<ChangelogRelease[]> => []);
    const cache = new ReleasesCache(loader, TTL, NEG);

    const first = await cache.get();
    expect(first.stale).toBe(false);
    expect(first.snapshot.releases).toEqual([]);

    vi.advanceTimersByTime(TTL - 1);
    const second = await cache.get();
    expect(loader).toHaveBeenCalledTimes(1); // cached, fresh hit
    expect(second.snapshot).toBe(first.snapshot);
  });
});
