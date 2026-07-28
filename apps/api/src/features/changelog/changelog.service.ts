// Changelog service (design Component 5; Error Scenarios 1–2).
//
// Composes the releases cache with per-viewer state and owns the unavailable
// mapping. Module-singleton lifecycle in the dashboard.service.ts family
// (init at bootstrap + lazy ensure-fallback) with two pinned divergences:
//
//   1. `initChangelogCache(loader)` RE-initializes (dashboard's init is a
//      guarded no-op) — re-init IS the integration-test reset seam.
//   2. Because the singleton wraps a LIVE-NETWORK loader (dashboard's wraps
//      an inert LRU), the real loader is fenced off from the test
//      environment at BOTH entry points: the no-arg init is a no-op under
//      `config.NODE_ENV === 'test'` (the `beforeAll(bootstrap)` pattern and
//      the bootstrap-under-test paths must never silently arm real GitHub
//      calls), and the ensure-fallback THROWS under test instead of lazily
//      constructing the live cache.
//
// The fence reads `config.NODE_ENV` — bare `process.env` is ESLint-banned in
// apps/api, and NODE_ENV is in envSchema.

import type {
  ChangelogRelease,
  ChangelogReleasesResponse,
  MarkChangelogViewedResponse,
} from '@tradr/shared';

import { db } from '@/db';
import { config } from '@/lib/config';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import { selectViewerState, updateChangelogViewedAt } from './changelog.query';
import { fetchReleases } from './github-releases.client';
import { ChangelogUnavailableError, ReleasesCache } from './releases-cache';

let cache: ReleasesCache | null = null;

/**
 * The real loader: a thin wrapper around `fetchReleases` that `logger.warn`s
 * on EVERY failure (generic reason — error class/message, never an upstream
 * response body; `options-chain.handler.ts` precedent). This covers the
 * warm-cache stale-on-error regime `errorHandler` never sees — a month-long
 * GitHub outage must be operator-visible in logs, not only in response-body
 * `stale` flags.
 */
async function loadReleases(): Promise<ChangelogRelease[]> {
  try {
    return await fetchReleases();
  } catch (err) {
    logger.warn('changelog releases fetch failed', {
      reason: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
    });
    throw err;
  }
}

/**
 * Bootstrap init + integration-test reset seam.
 *
 * - With a `loader`: (re)constructs the singleton around it — works in every
 *   environment; this IS the test seam.
 * - No-arg: constructs the singleton around the real (warn-wrapped) GitHub
 *   loader; a NO-OP under `config.NODE_ENV === 'test'` so bootstrap-under-test
 *   never arms live GitHub calls, and a guarded no-op once initialized.
 */
export function initChangelogCache(loader?: () => Promise<ChangelogRelease[]>): void {
  if (loader) {
    cache = new ReleasesCache(loader);
    return;
  }
  if (config.NODE_ENV === 'test') return;
  if (cache) return;
  cache = new ReleasesCache(loadReleases);
}

function ensureCache(): ReleasesCache {
  if (!cache) {
    if (config.NODE_ENV === 'test') {
      throw new Error(
        'Changelog cache not initialized under NODE_ENV=test — ' +
          'call initChangelogCache(testLoader) before exercising changelog routes.',
      );
    }
    logger.warn('changelog cache not initialized at bootstrap — constructing lazily');
    cache = new ReleasesCache(loadReleases);
  }
  return cache;
}

/**
 * GET envelope: cached releases + the per-viewer floor. The `lastViewedAt`
 * field is composed per request from one indexed PK read — never stored in
 * the shared cache (REQ-5(a)(4)). Empty-cache-plus-failing-upstream maps to
 * the coded 503 (REQ-2.5; Error Scenario 2).
 */
export async function getChangelogReleases(userId: string): Promise<ChangelogReleasesResponse> {
  let snapshot;
  let stale;
  try {
    ({ snapshot, stale } = await ensureCache().get());
  } catch (err) {
    if (err instanceof ChangelogUnavailableError) {
      throw new AppError(
        503,
        'CHANGELOG_UNAVAILABLE',
        'Release notes are temporarily unavailable.',
      );
    }
    throw err;
  }

  const viewer = await selectViewerState(db, userId);
  return {
    releases: snapshot.releases,
    fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    stale,
    lastViewedAt: (viewer.changelogViewedAt ?? viewer.createdAt).toISOString(),
  };
}

/** Mark-viewed: the single-statement `now()` write (REQ-5(a)(3)). */
export async function markChangelogViewed(userId: string): Promise<MarkChangelogViewedResponse> {
  const viewedAt = await updateChangelogViewedAt(db, userId);
  return { lastViewedAt: viewedAt.toISOString() };
}
