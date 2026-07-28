import { Hono } from 'hono';
import { z } from 'zod';

import { AdminUsageQuerySchema, ToggleAdminRequestSchema } from '@tradr/shared';

import { validate } from '@/lib/validation';
import { adminMiddleware } from '@/middleware/admin.middleware';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { getPlatformStats, getUsage, getUserDetail, listUsers, toggleAdmin } from './admin.service';

// ---------------------------------------------------------------------------
// Admin API routes (admin-platform design Components 1, 9, 12).
//
// The complete gated admin surface behind one router-level boundary
// (REQ-1.4): `authMiddleware` (401) → `adminMiddleware` (403 ADMIN_REQUIRED)
// → per-user rate limiter. Router-level `use()` means no individual handler
// is reachable without the gate and new admin endpoints need no per-handler
// re-assertion. The limiter sits AFTER the gate so non-admin probes consume
// no bucket and are indistinguishable from any other 403.
//
// Handlers are thin: validate, call the admin.service function, return. The
// only write is the PATCH toggle — non-GET per the SameSite=Lax CSRF posture
// (REQ-3.3).
//
// Convention: hand-authored JSDoc `@swagger` blocks (billing/advisor route
// style), NOT `@hono/zod-openapi` (not a dependency) — design Component 9.
// ---------------------------------------------------------------------------

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const adminRouter = new Hono<AuthEnv>();

adminRouter.use(authMiddleware);
adminRouter.use(adminMiddleware);

// Per-user admin rate limiter (Security NFR). Keyed on the authenticated
// userId (not IP) per the billing checkout limiter precedent: NAT'd admins do
// not collide and one admin across IPs cannot bypass it.
const perUserAdminRateLimit = createRateLimiter({
  name: 'admin',
  max: 60,
  windowMs: 60_000,
  keyGenerator: (c) => c.get('userId'),
  // Redis-outage fallback keeps the normal per-container budget (D8; not tightened).
  fallbackMax: 60,
});

adminRouter.use(perUserAdminRateLimit);

const IdParamSchema = z.object({ id: z.string().uuid() });

// Query params arrive as strings; coerce limit. The service clamps to
// [1, 100] (default 25), so out-of-range numbers are tolerated here.
const UsersQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().optional(),
});

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Platform statistics (admin only).
 *     description: >
 *       Admin-gated (403 `ADMIN_REQUIRED` for non-admins) and per-user rate
 *       limited (60 / 60 s). Returns total users, "Active now" users (still-valid
 *       sessions in the last 30 min — `activeUsersWindowMinutes` is serialized
 *       for honest labeling), positions by status, and revenue as micro-USD
 *       integer strings: `allTime` and the reversal-attributed UTC
 *       `currentMonth`, with the pinned `basis: 'purchased-credit-volume'`.
 *       An empty instance returns well-formed zeros, never errors (REQ-2.7).
 *     tags: [Admin]
 *     responses:
 *       200: { description: AdminStats — totals, activeUsers, positions, revenue. }
 *       401: { description: Not authenticated. }
 *       403: { description: ADMIN_REQUIRED — authenticated but not an admin. }
 *       429: { description: Admin rate limit reached (60 / 60 s per user). }
 */
adminRouter.get('/stats', async (c) => {
  return c.json(await getPlatformStats(), 200);
});

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: List users, cursor-paginated newest-first (admin only).
 *     description: >
 *       Admin-gated (403 `ADMIN_REQUIRED`). Cursor-paginated over
 *       `(created_at, id)` descending — new signups on page one. `cursor` is
 *       the opaque base64 cursor from a prior page; absent/invalid ⇒ first
 *       page. `limit` defaults to 25, clamped to [1, 100]; a non-numeric limit
 *       is a 400 `VALIDATION_ERROR`. Response `{ items, nextCursor }`;
 *       `lastActiveAt` is the last recorded session activity (nullable, may be
 *       arbitrarily old); `emailVerified` is the stored verified flag — a
 *       read-only signal, nothing is gated on it in v1. No secret fields are
 *       returned (REQ-3.6).
 *     tags: [Admin]
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 25, minimum: 1, maximum: 100 }
 *     responses:
 *       200: { description: '{ items: AdminUserListItem[], nextCursor: string | null }.' }
 *       400: { description: VALIDATION_ERROR — malformed limit. }
 *       401: { description: Not authenticated. }
 *       403: { description: ADMIN_REQUIRED — authenticated but not an admin. }
 *       429: { description: Admin rate limit reached (60 / 60 s per user). }
 */
adminRouter.get('/users', validate('query', UsersQuerySchema), async (c) => {
  const { cursor, limit } = c.req.valid('query');
  return c.json(await listUsers(cursor, limit), 200);
});

/**
 * @swagger
 * /api/admin/users/{id}:
 *   get:
 *     summary: Per-user admin detail (admin only).
 *     description: >
 *       Admin-gated (403 `ADMIN_REQUIRED`). Returns the list fields plus
 *       `positionCount`, `advisorTurns` (platform-key advisor turns, current
 *       UTC month), all-time `usage` token/credit sums, and `walletBalance`
 *       ('0' when no wallet row) — all bigint sums as integer strings. A
 *       non-UUID id is a 400 `VALIDATION_ERROR`; an unknown id is a 404
 *       `NOT_FOUND`.
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: AdminUserDetail. }
 *       400: { description: VALIDATION_ERROR — id is not a UUID. }
 *       401: { description: Not authenticated. }
 *       403: { description: ADMIN_REQUIRED — authenticated but not an admin. }
 *       404: { description: NOT_FOUND — no such user. }
 *       429: { description: Admin rate limit reached (60 / 60 s per user). }
 */
adminRouter.get('/users/:id', validate('param', IdParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  return c.json(await getUserDetail(id), 200);
});

/**
 * @swagger
 * /api/admin/users/{id}/admin:
 *   patch:
 *     summary: Toggle a user's admin flag (admin only).
 *     description: >
 *       Admin-gated (403 `ADMIN_REQUIRED`). The admin surface's single write —
 *       PATCH (never GET) per the SameSite=Lax CSRF posture (REQ-3.3). Body
 *       `{ isAdmin }`. Race-safe inside one transaction with a same-tx audit
 *       row: demoting the last remaining admin is refused with a 409
 *       `LAST_ADMIN` ("Cannot remove the last admin"), so the instance can
 *       never reach zero admins through the API. Self-demotion is permitted
 *       when not the last admin. Toggling to the current value is a 200 no-op
 *       (no update, no audit row). Returns the target's
 *       `{ id, email, isAdmin, createdAt }`.
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isAdmin]
 *             properties:
 *               isAdmin: { type: boolean }
 *     responses:
 *       200: { description: '{ id, email, isAdmin, createdAt } — the post-toggle target.' }
 *       400: { description: VALIDATION_ERROR — id is not a UUID or body is malformed. }
 *       401: { description: Not authenticated. }
 *       403: { description: ADMIN_REQUIRED — authenticated but not an admin. }
 *       404: { description: NOT_FOUND — no such user. }
 *       409: { description: LAST_ADMIN — cannot remove the last admin. }
 *       429: { description: Admin rate limit reached (60 / 60 s per user). }
 */
adminRouter.patch(
  '/users/:id/admin',
  validate('param', IdParamSchema),
  validate('json', ToggleAdminRequestSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { isAdmin } = c.req.valid('json');
    const target = await toggleAdmin(c.get('userId'), id, isAdmin);
    return c.json({ ...target, createdAt: target.createdAt.toISOString() }, 200);
  },
);

/**
 * @swagger
 * /api/admin/usage:
 *   get:
 *     summary: Platform usage and revenue over a period (admin only).
 *     description: >
 *       Admin-gated (403 `ADMIN_REQUIRED`). `from`/`to` are optional ISO 8601
 *       datetimes; the default window is the trailing 30 days ending now.
 *       `from > to` and ranges over 366 days are a 400 `VALIDATION_ERROR`.
 *       Returns `period`, `totals` (token/credit integer strings;
 *       `providerCost` is null when zero covered rows — pre-0013 rows have no
 *       recorded raw cost, see `providerCostCoverage`), the UTC-day `series`,
 *       `topUsers` (max 50 by billed credits), and the reversal-attributed
 *       `revenue { credited, reversed, net }`. Empty/future ranges return
 *       well-formed zeros (REQ-4.6).
 *     tags: [Admin]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200: { description: AdminUsage — period, totals, series, topUsers, revenue. }
 *       400: { description: VALIDATION_ERROR — malformed datetimes, from > to, or range > 366 days. }
 *       401: { description: Not authenticated. }
 *       403: { description: ADMIN_REQUIRED — authenticated but not an admin. }
 *       429: { description: Admin rate limit reached (60 / 60 s per user). }
 */
adminRouter.get('/usage', validate('query', AdminUsageQuerySchema), async (c) => {
  const { from, to } = c.req.valid('query');
  return c.json(await getUsage(from, to), 200);
});

export { adminRouter };
