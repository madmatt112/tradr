import { Hono } from 'hono';

import { PerformanceQuerySchema } from '@tradr/shared';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { getPerformance } from './performance.service';
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
 *       tier.
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
 *         description: The performance response.
 *       400: { description: 'Validation error (invalid timezone, invalid dates, start before 2000-01-01, start not before end, end beyond today + 1 day, bucket count over cap, unsupported currency) — identical on every tier.' }
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
    const abortSignal = c.get('abortSignal');
    const requestStartTime = c.get('requestStartTime');
    const query = c.req.valid('query');

    const result = await getPerformance(db, userId, query, abortSignal, requestStartTime);
    return c.json(result, 200);
  },
);

export default performance;
