import { Hono } from 'hono';
import { z } from 'zod';

import { IbkrConnectionSaveSchema } from '@tradr/shared';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { getConnections, removeConnection, saveConnection } from './ibkr.service';

type AuthEnv = { Variables: { userId: string; isAdmin: boolean } };

const ibkrRouter = new Hono<AuthEnv>();

ibkrRouter.use(authMiddleware);

const AccountParamSchema = z.object({ accountId: z.string().uuid() });

// Save-time rate limiter (design C2): 10 saves per user per hour, mounted on
// PUT only so GET and DELETE never draw from this budget.
const saveRateLimit = createRateLimiter({
  name: 'ibkr-connections',
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (c) => c.get('userId'),
  fallbackMax: 10,
});

/**
 * @swagger
 * /api/ibkr/connections:
 *   get:
 *     summary: List the authenticated user's IBKR Flex connections.
 *     description: >
 *       Masked status only: accountId, a last-4-char token hint, and the
 *       last-fetch time and the report's trade-date span. Never the token
 *       or the query id.
 *     tags: [IBKR]
 *     responses:
 *       200: { description: 'Array of { accountId, tokenHintTail, lastFetchedAt, lastPeriodStart, lastPeriodEnd }.' }
 */
ibkrRouter.get('/connections', async (c) => {
  const userId = c.get('userId');
  const rows = await getConnections(db, userId);
  return c.json(rows, 200);
});

/**
 * @swagger
 * /api/ibkr/connections/{accountId}:
 *   put:
 *     summary: Save (or replace) the IBKR Flex connection for an account.
 *     description: >
 *       Encrypts the token and query id at rest; only the ciphertext, the
 *       key version and the token's last four characters are stored. Makes
 *       no call to IBKR. A second save replaces the first and clears the
 *       last-fetch record. Rate limited to 10 saves per user per hour.
 *     tags: [IBKR]
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, queryId]
 *             properties:
 *               token: { type: string, minLength: 8, maxLength: 512 }
 *               queryId: { type: string, minLength: 1, maxLength: 64 }
 *     responses:
 *       200: { description: '{ accountId, tokenHintTail, lastFetchedAt, lastPeriodStart, lastPeriodEnd }.' }
 *       400: { description: Validation error (blank token or query id). }
 *       404: { description: 'Unknown account, or owned by another user.' }
 *       429: { description: Save rate limit reached (10 / hour). }
 *   delete:
 *     summary: Remove the IBKR Flex connection for an account.
 *     description: Hard-deletes the stored connection.
 *     tags: [IBKR]
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Deleted. }
 *       404: { description: 'No connection for this account, or owned by another user.' }
 */
ibkrRouter.put(
  '/connections/:accountId',
  saveRateLimit,
  validate('param', AccountParamSchema),
  validate('json', IbkrConnectionSaveSchema),
  async (c) => {
    const userId = c.get('userId');
    const { accountId } = c.req.valid('param');
    const input = c.req.valid('json');
    const connection = await saveConnection(db, userId, accountId, input);
    return c.json(connection, 200);
  },
);

ibkrRouter.delete('/connections/:accountId', validate('param', AccountParamSchema), async (c) => {
  const userId = c.get('userId');
  const { accountId } = c.req.valid('param');
  await removeConnection(db, userId, accountId);
  return c.body(null, 204);
});

export default ibkrRouter;
