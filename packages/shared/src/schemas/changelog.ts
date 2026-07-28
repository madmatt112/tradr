import { z } from 'zod';

export const ChangelogReleaseSchema = z.object({
  id: z.string(), // String(GitHub numeric release id) — stable identifier
  name: z.string(), // falls back to tag when GitHub name is null/empty
  tag: z.string(),
  publishedAt: z.string().datetime(), // GitHub timestamps are Z-form ISO; created_at fallback likewise
  body: z.string(), // '' when GitHub body is null
  htmlUrl: z.string().url().startsWith('https://'),
  // ^ defense-in-depth: Zod's .url() is a bare new URL() check and would accept
  //   javascript: — unreachable from real GitHub payloads (html_url is
  //   GitHub-generated, never fork-author-controlled), but the scheme refine
  //   makes the target="_blank" anchor safe by construction even against a
  //   misused base-URL seam. Mirrored on the upstream schema (Component 3).
  prerelease: z.boolean(),
});

export const ChangelogReleasesResponseSchema = z.object({
  releases: z.array(ChangelogReleaseSchema), // server-sorted desc by publishedAt, ≤ 20
  fetchedAt: z.string().datetime(), // when the served snapshot was fetched from upstream
  stale: z.boolean(), // true when served past TTL (stale-on-error / suppressed refresh)
  lastViewedAt: z.string().datetime(), // EFFECTIVE viewer floor: changelog_viewed_at ?? users.created_at — never null
});

export const MarkChangelogViewedResponseSchema = z.object({
  lastViewedAt: z.string().datetime(),
});

export type ChangelogRelease = z.infer<typeof ChangelogReleaseSchema>;
export type ChangelogReleasesResponse = z.infer<typeof ChangelogReleasesResponseSchema>;
export type MarkChangelogViewedResponse = z.infer<typeof MarkChangelogViewedResponseSchema>;
