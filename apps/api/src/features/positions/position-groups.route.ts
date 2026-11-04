import { Hono } from 'hono';
import { z } from 'zod';

import {
  AddGroupLegSchema,
  CloseGroupSchema,
  CreatePositionGroupSchema,
  LinkPositionsSchema,
  SetGroupLabelSchema,
} from '@tradr/shared/schemas/position';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import {
  addGroupLeg,
  closeGroup,
  createPositionGroup,
  linkPositions,
  setGroupLabel,
  unlinkGroupLeg,
} from './position-groups.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const positionGroups = new Hono<AuthEnv>();

positionGroups.use(authMiddleware);

const GroupParamSchema = z.object({ id: z.string().uuid() });
const GroupLegParamSchema = z.object({ id: z.string().uuid(), positionId: z.string().uuid() });

/**
 * @swagger
 * /api/position-groups:
 *   post:
 *     summary: Create a multi-leg strategy group.
 *     description: >
 *       Authed. Creates 2 to 8 legs sharing one account and one fill date, in
 *       one transaction: every leg is written with its entry fill and opened
 *       at that date, then linked into a new group. A bad OCC symbol, a
 *       symbol repeated across legs, or a leg whose underlying differs from
 *       the first writes nothing and names the offending leg's index. When
 *       feature gating is enforced, the whole batch is checked against the
 *       position cap (`positionCount + legs > limit`) and the account
 *       writability rule, same as a single create.
 *     tags: [Position Groups]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [accountId, filledAt, legs]
 *             properties:
 *               accountId: { type: string, format: uuid }
 *               filledAt: { type: string, format: date-time }
 *               labelOverride: { type: string, nullable: true, minLength: 1, maxLength: 40 }
 *               legs:
 *                 type: array
 *                 minItems: 2
 *                 maxItems: 8
 *                 items:
 *                   type: object
 *                   required: [symbol, side, assetType, quantity, price]
 *                   properties:
 *                     symbol: { type: string, minLength: 1, maxLength: 20 }
 *                     side: { type: string, enum: [long, short] }
 *                     assetType: { type: string, enum: [stock, option] }
 *                     quantity: { type: string }
 *                     price: { type: string }
 *                     fees: { type: string }
 *     responses:
 *       201: { description: The created group, with its legs. }
 *       400: { description: Validation error — bad OCC symbol, repeated symbol, or differing underlying, naming the leg index. }
 *       403: { description: TIER_LIMIT_POSITIONS (batched position cap reached) or TIER_ACCOUNT_NOT_WRITABLE. }
 *       404: { description: Account not found (or not owned by the user). }
 */
positionGroups.post('/', validate('json', CreatePositionGroupSchema), async (c) => {
  const userId = c.get('userId');
  const isAdmin = c.get('isAdmin');
  const data = c.req.valid('json');
  const group = await createPositionGroup(db, userId, data, { isAdmin });
  return c.json(group, 201);
});

/**
 * @swagger
 * /api/position-groups/link:
 *   post:
 *     summary: Link ungrouped positions into a group.
 *     description: >
 *       Authed. Links 2 to 8 existing `open` or `closed`, ungrouped positions
 *       sharing one account and underlying into a new group. Writes only the
 *       group row and each leg's `groupId` — no fill or ledger row, and each
 *       leg's `updatedAt` is left unchanged. Refuses a `draft` leg or one
 *       already in a group (409, naming the symbol), legs in different
 *       accounts or with a bad leg set (400, naming the leg index), or a
 *       foreign position id (404), before any write.
 *     tags: [Position Groups]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [positionIds]
 *             properties:
 *               positionIds:
 *                 type: array
 *                 minItems: 2
 *                 maxItems: 8
 *                 items: { type: string, format: uuid }
 *               labelOverride: { type: string, nullable: true, minLength: 1, maxLength: 40 }
 *     responses:
 *       201: { description: The new group, with its legs. }
 *       400: { description: Validation error, naming the leg index. }
 *       404: { description: A position id was not found (or not owned by the user). }
 *       409: { description: A leg is a draft or already grouped; names its symbol. }
 */
positionGroups.post('/link', validate('json', LinkPositionsSchema), async (c) => {
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const group = await linkPositions(db, userId, data);
  return c.json(group, 201);
});

/**
 * @swagger
 * /api/position-groups/{id}/legs:
 *   post:
 *     summary: Add one leg to an existing group.
 *     description: >
 *       Authed. Adds one ungrouped, non-draft position to the group, subject
 *       to the same checks as linking and the 8-leg cap. A 9th leg is
 *       refused with 400, naming the cap, and carries no leg index.
 *     tags: [Position Groups]
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
 *             required: [positionId]
 *             properties:
 *               positionId: { type: string, format: uuid }
 *     responses:
 *       200: { description: The group, with the new leg. }
 *       400: { description: Validation error, or the group is already at 8 legs. }
 *       404: { description: The group or the position was not found (or not owned by the user). }
 *       409: { description: The position is a draft or already grouped, or the group changed under the lock. }
 */
positionGroups.post(
  '/:id/legs',
  validate('param', GroupParamSchema),
  validate('json', AddGroupLegSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { positionId } = c.req.valid('json');
    const group = await addGroupLeg(db, userId, id, positionId);
    return c.json(group, 200);
  },
);

/**
 * @swagger
 * /api/position-groups/{id}/legs/{positionId}:
 *   delete:
 *     summary: Unlink one leg from a group.
 *     description: >
 *       Authed. Removes the leg from the group; the leg keeps its own
 *       lifecycle and figures unchanged. When one leg or fewer remains, the
 *       group dissolves and the last leg behaves as a plain, ungrouped
 *       position.
 *     tags: [Position Groups]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: positionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: The leg was unlinked (and the group dissolved, if it fell to one leg). }
 *       404: { description: The group or the position was not found (or not owned by the user), or the position is not a member of this group. }
 *       409: { description: The group changed under the lock; retry. }
 */
positionGroups.delete(
  '/:id/legs/:positionId',
  validate('param', GroupLegParamSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id, positionId } = c.req.valid('param');
    await unlinkGroupLeg(db, userId, id, positionId);
    return c.body(null, 204);
  },
);

/**
 * @swagger
 * /api/position-groups/{id}:
 *   patch:
 *     summary: Set or clear a group's label override.
 *     description: >
 *       Authed. Setting `labelOverride` stores it trimmed, 1 to 40
 *       characters; detection never replaces it while it is set. Setting it
 *       to `null` clears it, so the label follows the current legs again.
 *     tags: [Position Groups]
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
 *             required: [labelOverride]
 *             properties:
 *               labelOverride: { type: string, nullable: true, minLength: 1, maxLength: 40 }
 *     responses:
 *       200: { description: The group, with the label reflecting the override (or, cleared, the detected label). }
 *       404: { description: The group was not found (or not owned by the user). }
 */
positionGroups.patch(
  '/:id',
  validate('param', GroupParamSchema),
  validate('json', SetGroupLabelSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { labelOverride } = c.req.valid('json');
    const group = await setGroupLabel(db, userId, id, labelOverride);
    return c.json(group, 200);
  },
);

/**
 * @swagger
 * /api/position-groups/{id}/close:
 *   post:
 *     summary: Close every open leg of a group at once.
 *     description: >
 *       Authed. In one transaction, writes one exit fill per open leg for its
 *       open units (carrying no lot selection) and closes it, all dated at
 *       `closedAt` or now; an already-closed leg is skipped even if named.
 *       Posts through the existing fill and close hooks per leg, under its own
 *       symbol — no group-level ledger row. An open leg missing from `exits`
 *       is a validation error naming it; any failure (including a `closedAt`
 *       before a leg's open date, or a leg refused by the reopen guard) rolls
 *       back every leg and names the offending leg.
 *     tags: [Position Groups]
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
 *             required: [exits]
 *             properties:
 *               exits:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 8
 *                 items:
 *                   type: object
 *                   required: [positionId, price]
 *                   properties:
 *                     positionId: { type: string, format: uuid }
 *                     price: { type: string }
 *                     fees: { type: string }
 *               closedAt: { type: string, format: date-time }
 *     responses:
 *       200: { description: The group, with every leg closed. }
 *       400: { description: Validation error — a missing exit, or a closedAt before a leg's open date; names the leg. }
 *       404: { description: The group was not found, or an exits id is not a leg of it. }
 *       409: { description: Every leg is already closed, or a leg was refused by the reopen guard (names it). }
 */
positionGroups.post(
  '/:id/close',
  validate('param', GroupParamSchema),
  validate('json', CloseGroupSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const group = await closeGroup(db, userId, id, data);
    return c.json(group, 200);
  },
);

export default positionGroups;
