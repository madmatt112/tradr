import { Hono } from 'hono';
import { z } from 'zod';

import { SetTransferLinkSchema } from '@tradr/shared/schemas/position';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { getTransferLink, removeTransferLink, setTransferLink } from './transfer-links.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const transferLinksRouter = new Hono<AuthEnv>();

transferLinksRouter.use(authMiddleware);

const FillParamSchema = z.object({
  id: z.string().uuid(),
  fillId: z.string().uuid(),
});

/**
 * @swagger
 * /api/positions/{id}/fills/{fillId}/transfer-link:
 *   get:
 *     summary: Get an exit fill's in-kind transfer link and eligible candidates.
 *     description: >
 *       Authed. `fillId` must be an exit fill of this position. `link` is the
 *       stored link, or `null` if none. `candidates` are the caller's entry
 *       fills eligible to link against it — in another account, same symbol
 *       and side, equal quantity, and in no link of their own.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fillId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Must be an exit fill of this position.
 *     responses:
 *       200:
 *         description: The fill's link (or null) and its eligible candidates.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 link:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     exitFillId: { type: string, format: uuid }
 *                     entryFillId: { type: string, format: uuid }
 *                     entryPositionId: { type: string, format: uuid }
 *                     entryAccountId: { type: string, format: uuid }
 *                     entryAccountName: { type: string }
 *                     createdAt: { type: string, format: date-time }
 *                 candidates:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       entryFillId: { type: string, format: uuid }
 *                       positionId: { type: string, format: uuid }
 *                       accountId: { type: string, format: uuid }
 *                       accountName: { type: string }
 *                       filledAt: { type: string, format: date-time }
 *                       price: { type: string, description: Decimal. }
 *                       quantity: { type: string, description: Decimal. }
 *       404: { description: No such position for this user, or the fill is not an exit of it. }
 */
transferLinksRouter.get(
  '/:id/fills/:fillId/transfer-link',
  validate('param', FillParamSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id: positionId, fillId } = c.req.valid('param');
    const result = await getTransferLink(db, positionId, fillId, userId);
    return c.json(result, 200);
  },
);

/**
 * @swagger
 * /api/positions/{id}/fills/{fillId}/transfer-link:
 *   put:
 *     summary: Link an exit fill to an entry fill as one in-kind transfer.
 *     description: >
 *       Authed. Stores the link only if `entryFillId` names one of the
 *       caller's own entry fills, the first fill is an exit, their positions
 *       sit in different accounts, they share the exit position's symbol and
 *       side, their quantities are equal, and neither fill is already in a
 *       link; otherwise refuses with 409 and a reason first in the message
 *       (`not_an_entry`, `same_account`, `different_security`,
 *       `quantity_mismatch`, `exit_already_linked`, `entry_already_linked`).
 *       An `entryFillId` naming another user's fill is refused as
 *       `not_an_entry` and never otherwise resolved. The write touches only
 *       the link row — no fill hook, ledger write, or position change runs.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fillId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Must be an exit fill of this position.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [entryFillId]
 *             properties:
 *               entryFillId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The created link.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 exitFillId: { type: string, format: uuid }
 *                 entryFillId: { type: string, format: uuid }
 *                 entryPositionId: { type: string, format: uuid }
 *                 entryAccountId: { type: string, format: uuid }
 *                 entryAccountName: { type: string }
 *                 createdAt: { type: string, format: date-time }
 *       404: { description: No such position for this user, or the fill is not one of its own. }
 *       409: { description: 'One of the six link rules is violated; the message starts with its reason.' }
 */
transferLinksRouter.put(
  '/:id/fills/:fillId/transfer-link',
  validate('param', FillParamSchema),
  validate('json', SetTransferLinkSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id: positionId, fillId } = c.req.valid('param');
    const { entryFillId } = c.req.valid('json');
    const link = await setTransferLink(db, positionId, fillId, userId, entryFillId);
    return c.json(link, 200);
  },
);

/**
 * @swagger
 * /api/positions/{id}/fills/{fillId}/transfer-link:
 *   delete:
 *     summary: Remove an exit fill's in-kind transfer link.
 *     description: Authed. Removes the stored link, if any.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fillId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Removed. }
 *       404: { description: No such position or fill for this user, or no link to remove. }
 */
transferLinksRouter.delete(
  '/:id/fills/:fillId/transfer-link',
  validate('param', FillParamSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id: positionId, fillId } = c.req.valid('param');
    await removeTransferLink(db, positionId, fillId, userId);
    return c.body(null, 204);
  },
);

export default transferLinksRouter;
