import { Hono } from 'hono';

import { PerformanceQuerySchema } from '@tradr/shared';

import { db } from '@/db';
import { getTierContext } from '@/features/billing/tier.query';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { computeLookbackFloor, getPerformance } from './performance.service';
import { performanceTimeoutMiddleware, type PerformanceTimeoutEnv } from './performance.timeout';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

type PerformanceEnv = AuthEnv & PerformanceTimeoutEnv;

const performance = new Hono<PerformanceEnv>();

/**
 * @swagger
 * /api/performance:
 *   get:
 *     summary: Aggregated P&L performance series, equity curve and statistics.
 *     description: >
 *       Authed. Computes bucketed P&L series, equity curve and statistics per currency
 *       over the requested `[start, end)` window. Query validation (minimum start date,
 *       date order, bucket-count cap) always runs on the REQUESTED window on every
 *       tier. When feature gating is enabled and the user is a non-admin Free user, the
 *       window is clamped to the last 6 calendar months — never an error: the response
 *       is computed over the clamped window and marked with the additive `tierWindow`
 *       field. History metadata (per-currency earliest/most-recent closed timestamps
 *       and totals) is never clamped.
 *     tags: [Performance]
 *     parameters:
 *       - in: query
 *         name: granularity
 *         required: true
 *         schema: { type: string, enum: [day, week, month, year] }
 *       - in: query
 *         name: start
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: end
 *         required: true
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: tz
 *         required: false
 *         schema: { type: string, default: UTC }
 *       - in: query
 *         name: currency
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           The performance response. When the free-tier lookback floor
 *           clamped the requested window it carries the additive optional
 *           `tierWindow: { clamped: true, effectiveStart: ISO date-time,
 *           lookbackMonths: integer }` field; a window entirely before the
 *           floor yields empty series, still marked.
 *       400: { description: Validation error (invalid timezone, invalid dates, start before 2000-01-01, start not before end, end beyond today + 1 day, bucket count over cap, unsupported currency) — identical on every tier. }
 *       401: { description: Not authenticated. }
 *       503: { description: TIMEOUT or CLIENT_ABORT. }
 */
performance.get(
  '/',
  authMiddleware,
  performanceTimeoutMiddleware({ ms: 10_000 }),
  validate('query', PerformanceQuerySchema),
  async (c) => {
    const userId = c.get('userId');
    const isAdmin = c.get('isAdmin');
    const abortSignal = c.get('abortSignal');
    const requestStartTime = c.get('requestStartTime');
    const query = c.req.valid('query');

    // L3 lookback floor (plan-tiers D13): the route resolves the tier — the
    // service stays pure of Hono context. Only an enforced Free user gets a
    // floor: Pro's lookbackMonths is null (unlimited), and admins /
    // gating-off deployments pass through ({ enforced: false }, no DB read).
    const tier = await getTierContext(db, { userId, isAdmin });
    const tierFloor =
      tier.enforced && tier.limits.lookbackMonths !== null
        ? {
            floor: computeLookbackFloor(new Date(), tier.limits.lookbackMonths),
            lookbackMonths: tier.limits.lookbackMonths,
          }
        : undefined;

    const result = await getPerformance(
      db,
      userId,
      query,
      abortSignal,
      requestStartTime,
      tierFloor,
    );
    return c.json(result, 200);
  },
);

export default performance;
