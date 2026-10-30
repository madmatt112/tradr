import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { listPositionLots } from './positions.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const lotsRouter = new Hono<AuthEnv>();

lotsRouter.use(authMiddleware);

const PositionParamSchema = z.object({ id: z.string().uuid() });
const LotsQuerySchema = z.object({ exitFillId: z.string().uuid().optional() });

/**
 * @swagger
 * /api/positions/{id}/lots:
 *   get:
 *     summary: List a position's entry lots for the specific-identification picker.
 *     description: >
 *       Authed. One row per entry fill, carrying `available` — the lot's
 *       quantity less every other exit's current match. Pass `exitFillId`
 *       (an exit of this position) while editing that exit's selection, and
 *       its own slices are added back into `available` so the dialog sees
 *       what it currently holds. `method` and `jurisdiction` echo the user's
 *       resolved tax-lot settings, with no stored jurisdiction read as `other`.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: The position whose lots are listed.
 *       - in: query
 *         name: exitFillId
 *         required: false
 *         schema: { type: string, format: uuid }
 *         description: An exit fill of this position whose own slices are excluded from `available`.
 *     responses:
 *       200:
 *         description: The position's lots, plus the resolved method and jurisdiction.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 method:
 *                   type: string
 *                   enum: [fifo, average, acb]
 *                 jurisdiction:
 *                   type: string
 *                   enum: [US, CA, other]
 *                 lots:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       entryFillId: { type: string, format: uuid }
 *                       filledAt: { type: string, format: date-time }
 *                       price: { type: string, description: Decimal. }
 *                       quantity: { type: string, description: Decimal. }
 *                       available: { type: string, description: Decimal. }
 *       404: { description: No such position for this user, or `exitFillId` is not an exit of the position. }
 */
lotsRouter.get(
  '/:id/lots',
  validate('param', PositionParamSchema),
  validate('query', LotsQuerySchema),
  async (c) => {
    const userId = c.get('userId');
    const { id: positionId } = c.req.valid('param');
    const { exitFillId } = c.req.valid('query');
    const result = await listPositionLots(db, positionId, userId, exitFillId);
    return c.json(result, 200);
  },
);

export default lotsRouter;
