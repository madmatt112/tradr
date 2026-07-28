// GitHub releases client (design Component 3, REQ-1.2–1.8, REQ-2.7).
//
// The single outbound choke point for the changelog feature: fetch ONE page of
// published releases from the unauthenticated GitHub REST API, validate,
// normalize, sort, bound. A thin `fetch` wrapper (NO SDK, no octokit) mirroring
// the Unusual Whales client (unusual-whales.client.ts): per-request 10 s
// AbortController timeout with timer cleanup, fetchImpl/baseUrl injection
// seams, Zod safeParse with generic error messages.
//
// No-leak discipline (REQ-2.5, UW precedent): EVERY failure — network error,
// timeout, non-2xx, unreadable JSON, Zod mismatch — maps to the single
// `GithubFetchError` with a generic message; no upstream body or message is
// ever attached. No caching and no error-envelope knowledge live here (the
// cache and the 503 mapping are Components 4–5).

import { z } from 'zod';

import type { ChangelogRelease } from '@tradr/shared';

import { config } from '@/lib/config';

/** Per-request upstream timeout (REQ-2.7; UW precedent). */
const REQUEST_TIMEOUT_MS = 10_000;

/** REQ-1.5 bound: single page, `per_page=20`, never a second page. */
const MAX_RELEASES = 20;

/**
 * The single failure class — REQ-2.4's one failure definition. Thrown on ANY
 * failure (network, timeout, non-2xx, bad JSON, Zod). The message is always
 * generic; upstream detail is never surfaced.
 */
export class GithubFetchError extends Error {
  constructor(message = 'Could not fetch releases from GitHub.') {
    super(message);
    this.name = 'GithubFetchError';
  }
}

// --- Upstream schema (module-local — the upstream shape is not a shared contract)

// A garbage-but-string timestamp must fail Zod and take the single
// GithubFetchError path instead of escaping as a RangeError from toISOString()
// during normalization.
const parseableDate = (s: string): boolean => !Number.isNaN(Date.parse(s));

const githubReleaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable().optional(), // nullable upstream — REQ-1.3
  body: z.string().nullable().optional(), // nullable upstream — REQ-1.3
  published_at: z.string().refine(parseableDate).nullable(), // nullable upstream — REQ-1.3
  created_at: z.string().refine(parseableDate),
  // Scheme refine mirrors the shared schema: Zod's .url() is a bare new URL()
  // check and would accept javascript: (Component 1 defense-in-depth).
  html_url: z.string().url().startsWith('https://'),
  prerelease: z.boolean(),
  // NO `draft` field: the unauthenticated API structurally never returns
  // drafts (REQ-1.6) — deliberately not re-filtered here.
}); // Zod object: unknown upstream keys ignored

const githubReleasesSchema = z.array(githubReleaseSchema);

// --- Client -------------------------------------------------------------

export interface FetchReleasesDeps {
  /** Test seam (UW precedent): defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Defaults to `config.CHANGELOG_GITHUB_BASE_URL` (REQ-3.6 seam). */
  baseUrl?: string;
  /** Defaults to `config.CHANGELOG_GITHUB_REPO` (owner/repo slug, path-only). */
  repo?: string;
}

/**
 * Fetch, validate, and normalize one page of published releases.
 *
 * Resolves to a server-sorted (descending by `publishedAt`), ≤20-entry list
 * (REQ-1.4/1.5). An empty repo resolves to `[]` — a success (REQ-1.7).
 * Throws `GithubFetchError` on ANY failure (network, timeout, non-2xx, Zod).
 */
export async function fetchReleases(deps: FetchReleasesDeps = {}): Promise<ChangelogRelease[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = (deps.baseUrl ?? config.CHANGELOG_GITHUB_BASE_URL).replace(/\/$/, '');
  const repo = deps.repo ?? config.CHANGELOG_GITHUB_REPO;

  // The slug reaches only the PATH; the host comes exclusively from server
  // env config (REQ-3.2/3.6).
  const url = `${baseUrl}/repos/${repo}/releases?per_page=${MAX_RELEASES}`;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('request timeout')),
    REQUEST_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        // GitHub asks callers to identify themselves with a meaningful UA
        // (identify-yourself guideline — undici already sends a default UA,
        // so this is not 403 avoidance). NO authorization header, ever:
        // unauthenticated-only scope.
        'user-agent': 'tradr-api',
      },
      signal: controller.signal,
    });
  } catch {
    // Timeout or network failure. The caught error is intentionally NOT
    // surfaced (no upstream/network detail leak).
    throw new GithubFetchError();
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new GithubFetchError();
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new GithubFetchError();
  }

  // Whole-array all-or-nothing parse (design Component 3): with the nullable
  // tolerance above, every documented GitHub shape passes; anything beyond
  // that is a genuine upstream contract break (REQ-1.8).
  const parsed = githubReleasesSchema.safeParse(json);
  if (!parsed.success) {
    throw new GithubFetchError();
  }

  return (
    parsed.data
      .map(
        (release): ChangelogRelease => ({
          id: String(release.id),
          // null OR empty name falls back to the tag (REQ-1.3).
          name: (release.name ?? '') || release.tag_name,
          tag: release.tag_name,
          // REQ-1.3 pinned rule: null published_at falls back to created_at,
          // never excludes the entry. The re-serialization through Date is
          // load-bearing: it canonicalizes GitHub's seconds-precision Z-form to
          // millisecond-precision toISOString() output, so every contract
          // timestamp has identical fixed-width shape and the badge predicate's
          // lexicographic comparison equals instant comparison (Component 8).
          publishedAt: new Date(release.published_at ?? release.created_at).toISOString(),
          body: release.body ?? '',
          htmlUrl: release.html_url,
          prerelease: release.prerelease,
        }),
      )
      // Server-side descending sort by the normalized publishedAt (REQ-1.4 —
      // GitHub documents no list order). Canonical strings sort lexicographically.
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0))
      .slice(0, MAX_RELEASES)
  );
}
