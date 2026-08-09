import { Hono } from 'hono';

import { authMiddleware } from '@/middleware/auth.middleware';

import { getChangelogReleases, markChangelogViewed } from './changelog.service';

// ---------------------------------------------------------------------------
// Changelog API routes (design Component 6).
//
// Two thin authed handlers — no params, no body, nothing client-controllable
// reaches the cache or the outbound GitHub URL (REQ-2.3). GET is
// side-effect-free; mark-viewed is the dedicated POST only (REQ-5(a)(3)).
// Errors propagate to `errorHandler` (no try/catch here).
//
// Convention: hand-authored JSDoc `@swagger` blocks (billing/advisor route
// style), NOT `@hono/zod-openapi` (not a dependency) — REQ-6.1.
// ---------------------------------------------------------------------------

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const changelogRouter = new Hono<AuthEnv>();

changelogRouter.use(authMiddleware);

/**
 * @swagger
 * /api/changelog/releases:
 *   get:
 *     summary: List published release notes with the viewer's last-viewed floor.
 *     description: >
 *       User-scoped, side-effect-free. Returns the cached GitHub releases
 *       (newest first) plus `fetchedAt`, a `stale` flag (cache older than its
 *       TTL but still served), and the per-viewer `lastViewedAt` floor
 *       (`changelog_viewed_at ?? created_at`). Never mutates viewer state —
 *       marking viewed is the dedicated POST. When the cache is empty and the
 *       upstream fetch fails, returns a coded `503 CHANGELOG_UNAVAILABLE`.
 *     tags: [Changelog]
 *     responses:
 *       200: { description: '{ releases, fetchedAt, stale, lastViewedAt }.' }
 *       401: { description: Not authenticated. }
 *       503: { description: 'CHANGELOG_UNAVAILABLE (empty cache, upstream down).' }
 */
changelogRouter.get('/releases', async (c) => {
  return c.json(await getChangelogReleases(c.get('userId')), 200);
});

/**
 * @swagger
 * /api/changelog/viewed:
 *   post:
 *     summary: Mark the changelog as viewed for the authenticated user.
 *     description: >
 *       Sets the viewer's `changelog_viewed_at` to now (single-statement write, no
 *       body). Returns `{ lastViewedAt }`, the new floor. This is the ONLY mutation in
 *       the feature — the badge's GET never clears the indicator.
 *     tags: [Changelog]
 *     responses:
 *       200: { description: '{ lastViewedAt } — the new floor.' }
 *       401: { description: Not authenticated. }
 */
changelogRouter.post('/viewed', async (c) => {
  return c.json(await markChangelogViewed(c.get('userId')), 200);
});

export { changelogRouter };
