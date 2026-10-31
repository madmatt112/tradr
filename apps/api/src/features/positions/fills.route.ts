import { Hono } from 'hono';
import { z } from 'zod';

import { CreateFillSchema, UpdateFillSchema } from '@tradr/shared/schemas/position';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import { addFill, editFill, removeFill } from './positions.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const fillsRouter = new Hono<AuthEnv>();

fillsRouter.use(authMiddleware);

const PositionParamSchema = z.object({ id: z.string().uuid() });
const FillParamSchema = z.object({
  id: z.string().uuid(),
  fillId: z.string().uuid(),
});

/**
 * @swagger
 * /api/positions/{id}/fills:
 *   post:
 *     summary: Add a fill to a position.
 *     description: >
 *       Authed. A position is a sequence of fills, not a single trade: add an
 *       `entry` fill to open or scale in, an `exit` fill to scale out or close.
 *       The position's average price, open quantity, status, and realised P&L
 *       are all derived from its fills, so adding one recomputes them.
 *       Monetary and quantity fields are strings to preserve decimal precision.
 *       An exit may carry `lotSelection` to pick specific lots by specific
 *       identification; omitted, the exit matches FIFO against the oldest
 *       lots not already reserved by another exit's selection.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: The position the fill belongs to.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, price, quantity, filledAt]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [entry, exit]
 *               price: { type: string, description: Non-negative decimal. }
 *               quantity: { type: string, description: Positive decimal. }
 *               fees: { type: string, default: '0', description: Non-negative decimal. }
 *               notes: { type: string, maxLength: 10000, nullable: true }
 *               filledAt: { type: string, format: date-time }
 *               lotSelection:
 *                 type: array
 *                 minItems: 1
 *                 description: >
 *                   Exit only. A specific-identification choice of lots: each
 *                   item's `quantity` must claim no more than its lot still
 *                   has available, and every item's `quantity` must sum to
 *                   this fill's `quantity`.
 *                 items:
 *                   type: object
 *                   required: [entryFillId, quantity]
 *                   properties:
 *                     entryFillId: { type: string, format: uuid, description: Must be an entry fill of this position. }
 *                     quantity: { type: string, description: Positive decimal. }
 *     responses:
 *       201:
 *         description: >
 *           The created fill, plus `positionClosed` — true when this was the
 *           exit that balanced the entered quantity, which closes the position
 *           in the same transaction.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 positionId: { type: string, format: uuid }
 *                 type:
 *                   type: string
 *                   enum: [entry, exit]
 *                 price: { type: string, description: Decimal. }
 *                 quantity: { type: string, description: Decimal. }
 *                 fees: { type: string, description: Decimal. }
 *                 notes: { type: string, nullable: true }
 *                 filledAt: { type: string, format: date-time }
 *                 createdAt: { type: string, format: date-time }
 *                 positionClosed: { type: boolean }
 *                 lotSelection:
 *                   type: array
 *                   nullable: true
 *                   description: The stored selection on this fill, or null for an entry or an unselected exit.
 *                   items:
 *                     type: object
 *                     properties:
 *                       entryFillId: { type: string, format: uuid }
 *                       quantity: { type: string, description: Decimal. }
 *       400: { description: 'Validation error: an exit quantity beyond the available entry quantity, a fractional quantity on an options position, a `lotSelection` on an entry fill, or a `lotSelection` repeating an `entryFillId`.' }
 *       404: { description: No such position for this user. }
 *       409: { description: 'The position is closed, an exit fill was sent to a position that is still a draft, a `lotSelection` names an entry fill that is not an entry of this position, its quantities do not sum to the exit quantity, its claims exceed a lot, or the write would change an earlier exit''s matched lots.' }
 */
fillsRouter.post(
  '/:id/fills',
  validate('param', PositionParamSchema),
  validate('json', CreateFillSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id: positionId } = c.req.valid('param');
    const data = c.req.valid('json');
    const fill = await addFill(db, positionId, userId, data);
    return c.json(fill, 201);
  },
);

/**
 * @swagger
 * /api/positions/{id}/fills/{fillId}:
 *   put:
 *     summary: Edit a fill.
 *     description: >
 *       Authed. Corrects a recorded fill and recomputes the position's derived
 *       figures. `type` is immutable — an entry cannot become an exit; delete
 *       the fill and add the right one instead. Every field is optional; only
 *       what you send changes. On an exit, `lotSelection` replaces the stored
 *       specific-identification choice; `null` clears it back to FIFO; omitted,
 *       any stored selection is left as-is — except a quantity change on an
 *       exit that already carries a selection, which requires a new one.
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               price: { type: string, description: Non-negative decimal. }
 *               quantity: { type: string, description: Positive decimal. }
 *               fees: { type: string, description: Non-negative decimal. }
 *               notes: { type: string, maxLength: 10000, nullable: true }
 *               filledAt: { type: string, format: date-time }
 *               lotSelection:
 *                 type: array
 *                 nullable: true
 *                 minItems: 1
 *                 description: >
 *                   Exit only. Replaces the stored selection; `null` clears it
 *                   (reverting the exit to FIFO); omitted, the stored selection
 *                   (if any) is kept.
 *                 items:
 *                   type: object
 *                   required: [entryFillId, quantity]
 *                   properties:
 *                     entryFillId: { type: string, format: uuid, description: Must be an entry fill of this position. }
 *                     quantity: { type: string, description: Positive decimal. }
 *     responses:
 *       200:
 *         description: >
 *           The updated fill, carrying its stored `lotSelection` (null for an
 *           entry or an unselected exit).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 positionId: { type: string, format: uuid }
 *                 type:
 *                   type: string
 *                   enum: [entry, exit]
 *                 price: { type: string, description: Decimal. }
 *                 quantity: { type: string, description: Decimal. }
 *                 fees: { type: string, description: Decimal. }
 *                 notes: { type: string, nullable: true }
 *                 filledAt: { type: string, format: date-time }
 *                 createdAt: { type: string, format: date-time }
 *                 lotSelection:
 *                   type: array
 *                   nullable: true
 *                   items:
 *                     type: object
 *                     properties:
 *                       entryFillId: { type: string, format: uuid }
 *                       quantity: { type: string, description: Decimal. }
 *       400: { description: 'Validation error: an exit quantity beyond the available entry quantity, a fractional quantity on an options position, or a `lotSelection` repeating an `entryFillId`.' }
 *       404: { description: No such position or fill for this user. }
 *       409: { description: 'The change would leave the position inconsistent with its other fills; a quantity change on a selected exit with no new `lotSelection`; a `lotSelection` naming an entry fill that is not an entry of this position, its quantities do not sum to the (post-edit) exit quantity, its claims exceed a lot, or the write would change an earlier exit''s matched lots; an entry quantity edit that would leave a selected exit''s claim above the lot; or a quantity change on a fill that is in an in-kind transfer link (remove the link first).' }
 */
fillsRouter.put(
  '/:id/fills/:fillId',
  validate('param', FillParamSchema),
  validate('json', UpdateFillSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id: positionId, fillId } = c.req.valid('param');
    const data = c.req.valid('json');
    const fill = await editFill(db, positionId, fillId, userId, data);
    return c.json(fill, 200);
  },
);

/**
 * @swagger
 * /api/positions/{id}/fills/{fillId}:
 *   delete:
 *     summary: Delete a fill.
 *     description: >
 *       Authed. Removes the fill and recomputes the position from what is left.
 *       An open position must keep at least one entry fill, and its entry
 *       quantity must stay at or above its exit quantity, so a deletion that
 *       would break either rule is refused rather than applied. An entry fill
 *       that a stored `lotSelection` claims cannot be removed either — the
 *       claiming exit's selection would otherwise lose its lot.
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
 *       204: { description: Deleted. }
 *       404: { description: No such position or fill for this user. }
 *       409: { description: 'The position is closed, the fill is the last remaining entry, removing it would leave exit fills unbacked, or it is an entry fill a stored `lotSelection` claims.' }
 */
fillsRouter.delete('/:id/fills/:fillId', validate('param', FillParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id: positionId, fillId } = c.req.valid('param');
  await removeFill(db, positionId, fillId, userId);
  return c.body(null, 204);
});

export default fillsRouter;
