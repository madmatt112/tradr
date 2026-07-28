// Releases cache (design Component 4, REQ-2.1–2.6, REQ-2.8).
//
// The REQ-2 state machine: process-local TTL cache, lazy single-flight
// refresh, stale-on-error with unbounded staleness, negative caching. A
// self-contained dependency-injected class — no HTTP, no DB, no connection
// held, ever (REQ-2.8); it touches only its own fields. No logging here: the
// service's loader wrapper owns failure logging. No background timer or
// scheduler — refresh is lazy, driven by `get()`.
//
// Process-local state-module discipline mirrors
// `apps/api/src/features/advisor/idempotency-map.ts`.

import type { ChangelogRelease } from '@tradr/shared';

/**
 * TTL and negative-cache intervals are module constants, NOT operator-tunable
 * (REQ-2.3 budget arithmetic): worst case is one upstream call per elapsed
 * `min(TTL, negative)` = 300 s ⇒ 12 calls/hour = 20% of GitHub's ~60/hour
 * unauthenticated budget. The constructor params below exist ONLY for unit
 * tests — prod always constructs with these constants.
 */
export const RELEASES_TTL_MS = 15 * 60 * 1000; // 900 s
export const NEGATIVE_CACHE_MS = 5 * 60 * 1000; // 300 s

/** Thrown when the cache is empty AND the upstream is failing (REQ-2.5). */
export class ChangelogUnavailableError extends Error {
  constructor(message = 'Release notes are temporarily unavailable.') {
    super(message);
    this.name = 'ChangelogUnavailableError';
  }
}

export interface ReleasesSnapshot {
  releases: ChangelogRelease[];
  fetchedAt: number;
}

export class ReleasesCache {
  private snapshot: ReleasesSnapshot | null = null;
  private lastFailureAt: number | null = null;
  private inFlight: Promise<ReleasesSnapshot> | null = null;

  constructor(
    private readonly loader: () => Promise<ChangelogRelease[]>,
    // Injectable ONLY for unit tests — prod always uses the constants.
    private readonly ttlMs: number = RELEASES_TTL_MS,
    private readonly negativeTtlMs: number = NEGATIVE_CACHE_MS,
  ) {}

  /** `stale` is always derived (`now − fetchedAt ≥ ttlMs`), never stored. */
  private isStale(snapshot: ReleasesSnapshot): boolean {
    return Date.now() - snapshot.fetchedAt >= this.ttlMs;
  }

  /**
   * Stale-serve if a snapshot exists (REQ-2.4 — staleness is deliberately
   * unbounded, no ceiling), else throw (REQ-2.5).
   */
  private serveStaleOrThrow(): { snapshot: ReleasesSnapshot; stale: boolean } {
    if (this.snapshot) {
      return { snapshot: this.snapshot, stale: this.isStale(this.snapshot) };
    }
    throw new ChangelogUnavailableError();
  }

  /**
   * Resolve the current snapshot per the full degradation matrix — every cell
   * defined, evaluated in order. Throws `ChangelogUnavailableError` only when
   * the cache is empty and the upstream is failing/suppressed.
   */
  async get(): Promise<{ snapshot: ReleasesSnapshot; stale: boolean }> {
    const now = Date.now();

    // (1) Fresh hit — no upstream call, no fetch started (REQ-2.1/2.2).
    if (this.snapshot && now - this.snapshot.fetchedAt < this.ttlMs) {
      return { snapshot: this.snapshot, stale: false };
    }

    // (2) Fetch already in flight — never start a second one (REQ-2.2).
    if (this.inFlight) {
      if (this.snapshot) {
        // Warm: serve immediately with derived staleness.
        return { snapshot: this.snapshot, stale: this.isStale(this.snapshot) };
      }
      // Cold boot: await the in-flight fetch (REQ-2.2 cold-boot await —
      // transitively bounded by the loader's own timeout). On rejection each
      // awaiter resolves like the originator: stale-serve if a snapshot
      // exists by then, else throw. The burst counts as ONE upstream call.
      try {
        const snapshot = await this.inFlight;
        return { snapshot, stale: this.isStale(snapshot) };
      } catch {
        return this.serveStaleOrThrow();
      }
    }

    // (3) Negative-cache window — no upstream call (REQ-2.6).
    if (this.lastFailureAt !== null && now - this.lastFailureAt < this.negativeTtlMs) {
      return this.serveStaleOrThrow();
    }

    // (4) Start a fetch. `inFlight` is assigned synchronously before any
    // `await`, so the single-threaded event loop guarantees two get() calls
    // can never both reach this step.
    this.inFlight = this.runFetch();
    try {
      const snapshot = await this.inFlight;
      return { snapshot, stale: this.isStale(snapshot) };
    } catch {
      return this.serveStaleOrThrow();
    } finally {
      this.inFlight = null;
    }
  }

  // Executes one loader call: success stores the snapshot and clears
  // `lastFailureAt`; failure records `lastFailureAt` and rethrows (the
  // callers — originator and cold-boot awaiters — map it to stale-serve or
  // ChangelogUnavailableError). An empty list is a success, cached like any
  // result (REQ-1.7).
  private async runFetch(): Promise<ReleasesSnapshot> {
    try {
      const releases = await this.loader();
      const snapshot: ReleasesSnapshot = { releases, fetchedAt: Date.now() };
      this.snapshot = snapshot;
      this.lastFailureAt = null;
      return snapshot;
    } catch (err) {
      this.lastFailureAt = Date.now();
      throw err;
    }
  }
}
