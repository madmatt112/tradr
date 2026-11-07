import { Hono } from 'hono';
import { z } from 'zod';

import { FlexFetchRequestSchema, IbkrConnectionSaveSchema } from '@tradr/shared';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';
import { createRateLimiter } from '@/middleware/rate-limit.middleware';

import { fetchAndPreview, getConnections, removeConnection, saveConnection } from './ibkr.service';

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

// ---------------------------------------------------------------------------
// POST /api/csv-import/flex-fetch (design C6, Req 2) — mounted on the
// csv-import base in app.ts, directly after the csv-import mount, so the
// raised proxy read timeout applies (design D4, NFR Performance).
// ---------------------------------------------------------------------------

export const flexFetchRouter = new Hono<AuthEnv>();

flexFetchRouter.use(authMiddleware);

// Per-user fetch limiter (design C6): 2 fetches per 60s, ahead of the
// handler, so a 429 calls no IBKR endpoint (Req 4.4).
const flexFetchRateLimit = createRateLimiter({
  name: 'ibkr-flex-fetch',
  max: 2,
  windowMs: 60 * 1000,
  keyGenerator: (c) => c.get('userId'),
  fallbackMax: 2,
});

/**
 * @swagger
 * /api/csv-import/flex-fetch:
 *   post:
 *     summary: Fetch the account's IBKR Flex report and preview it.
 *     description: >
 *       Decrypts the account's saved connection, fetches the latest Flex
 *       report over the IBKR Flex Web Service, and previews it through the
 *       same pipeline as an uploaded CSV. Returns a single-use `token` the
 *       client passes to `/api/csv-import/commit`. Rate limited to 2 fetches
 *       per user per 60 seconds; a refusal there makes no outbound call.
 *     tags: [IBKR]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [accountId]
 *             properties:
 *               accountId: { type: string, format: uuid }
 *     responses:
 *       200: { description: 'A `CsvPreviewResponse`, as returned by /api/csv-import/preview.' }
 *       400: { description: 'IBKR_FLEX_TOKEN_REJECTED or IBKR_FLEX_QUERY_REJECTED — replace the credential in Settings.' }
 *       404: { description: 'No connection for this account, or owned by another user (NOT_FOUND).' }
 *       409: { description: 'IBKR_CONNECTION_UNREADABLE, or a csv-import refusal: CSV_IMPORT_IN_PROGRESS, CSV_IMPORT_SUPERSEDED, CSV_IMPORT_EXPIRED, CSV_IMPORT_BLOCKED, CSV_IMPORT_DUPLICATES_UNCONFIRMED.' }
 *       403: { description: 'A plan-tier refusal: TIER_LIMIT_CSV_IMPORTS, TIER_ACCOUNT_NOT_WRITABLE, or TIER_LIMIT_POSITIONS.' }
 *       413: { description: 'PAYLOAD_TOO_LARGE — the report exceeds the import byte cap.' }
 *       422: { description: 'IBKR_FLEX_NO_TRADES (zero rows), IBKR_FLEX_ACCOUNT_UNPROVEN, or IBKR_FLEX_FORMAT_UNSUPPORTED.' }
 *       429: { description: 'RATE_LIMITED (this limiter) or IBKR_FLEX_RATE_LIMITED (IBKR itself).' }
 *       503: { description: 'IBKR_FLEX_UNAVAILABLE or IBKR_FLEX_NOT_READY.' }
 */
flexFetchRouter.post(
  '/flex-fetch',
  flexFetchRateLimit,
  validate('json', FlexFetchRequestSchema),
  async (c) => {
    const userId = c.get('userId');
    const { accountId } = c.req.valid('json');
    const preview = await fetchAndPreview(db, userId, accountId);
    return c.json(preview, 200);
  },
);
