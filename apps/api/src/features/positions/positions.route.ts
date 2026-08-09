import { Hono } from 'hono';
import { z } from 'zod';

import {
  CreatePositionSchema,
  UpdatePositionSchema,
  ReopenPositionSchema,
} from '@tradr/shared/schemas/position';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import {
  createPosition,
  listPositions,
  getPositionDetail,
  editPosition,
  removePosition,
  openPosition,
  closePosition,
  reopenPosition,
} from './positions.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const positions = new Hono<AuthEnv>();

positions.use(authMiddleware);

const ParamSchema = z.object({ id: z.string().uuid() });
const ListQuerySchema = z.object({
  status: z.enum(['draft', 'open', 'closed']).optional(),
  accountId: z.string().uuid().optional(),
});

/**
 * @swagger
 * /api/positions:
 *   post:
 *     summary: Create a position (draft).
 *     description: >
 *       Authed. Creates a draft position in one of the user's accounts. When feature
 *       gating is enabled and the user is a non-admin Free user, the create is refused
 *       with `403 TIER_LIMIT_POSITIONS` at the position cap, or `403
 *       TIER_ACCOUNT_NOT_WRITABLE` when over the account cap and targeting an account
 *       other than the writable designation. Admins and gating-off deployments pass
 *       through unchanged. Existing-data management (close/fills/edit/delete) is never
 *       blocked.
 *     tags: [Positions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [accountId, symbol, side, assetType]
 *             properties:
 *               accountId: { type: string, format: uuid }
 *               symbol: { type: string, minLength: 1 }
 *               side: { type: string, enum: [long, short] }
 *               assetType: { type: string, enum: [stock, option] }
 *               notes: { type: string, nullable: true }
 *               targetPrice:
 *                 type: string
 *                 nullable: true
 *                 description: >
 *                   Trade-plan target price. Positive decimal string with up to
 *                   8 decimal places, or null. Used to compute the target R/R.
 *                 example: "150.00"
 *               stopLoss:
 *                 type: string
 *                 nullable: true
 *                 description: >
 *                   Trade-plan stop-loss price. Positive decimal string with up
 *                   to 8 decimal places, or null. Used to compute risk/reward.
 *                 example: "140.00"
 *     responses:
 *       201: { description: The created position. }
 *       400: { description: Validation error. }
 *       403: { description: TIER_LIMIT_POSITIONS (position cap reached) or TIER_ACCOUNT_NOT_WRITABLE (non-writable account while over the account cap). }
 *       404: { description: Account not found (or not owned by the user). }
 */
positions.post('/', validate('json', CreatePositionSchema), async (c) => {
  const userId = c.get('userId');
  const isAdmin = c.get('isAdmin');
  const data = c.req.valid('json');
  const position = await createPosition(db, userId, data, { isAdmin });
  return c.json(position, 201);
});

positions.get('/', validate('query', ListQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { status, accountId } = c.req.valid('query');
  const list = await listPositions(db, userId, { status, accountId });
  return c.json(list, 200);
});

positions.get('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const detail = await getPositionDetail(db, id, userId);
  return c.json(detail, 200);
});

/**
 * @swagger
 * /api/positions/{id}:
 *   put:
 *     summary: Update a position.
 *     description: >
 *       Authed. All fields optional. On a `draft` position every field is
 *       editable. On `open` and `closed` positions only `notes`, `targetPrice`,
 *       and `stopLoss` may change — the trade-plan fields are plan annotations
 *       that do not affect fill quantities; any other field on a non-draft
 *       position is rejected with 409.
 *     tags: [Positions]
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
 *             properties:
 *               accountId: { type: string, format: uuid }
 *               symbol: { type: string, minLength: 1, maxLength: 20 }
 *               side: { type: string, enum: [long, short] }
 *               assetType: { type: string, enum: [stock, option] }
 *               notes: { type: string, nullable: true }
 *               targetPrice:
 *                 type: string
 *                 nullable: true
 *                 description: >
 *                   Trade-plan target price. Positive decimal string with up to
 *                   8 decimal places, or null. Editable on any status.
 *                 example: "150.00"
 *               stopLoss:
 *                 type: string
 *                 nullable: true
 *                 description: >
 *                   Trade-plan stop-loss price. Positive decimal string with up
 *                   to 8 decimal places, or null. Editable on any status.
 *                 example: "140.00"
 *     responses:
 *       200: { description: The updated position. }
 *       400: { description: Validation error (e.g. an invalid option symbol or plan price). }
 *       404: { description: 'Position not found (or not owned), or the target account not found.' }
 *       409: { description: 'A restricted field (symbol/side/assetType/accountId) was changed on a non-draft position, or an asset-type change was attempted.' }
 *   delete:
 *     summary: Delete a position (any status).
 *     description: >
 *       Authed. Hard-deletes a position in any status (`draft`, `open`, or
 *       `closed`) and cascades to its fills. When the position had written a
 *       ledger entry via its close, a compensating `position_pnl_reversal` row
 *       is posted in the same transaction so the account balance is not left
 *       inflated; the ledger stays append-only (`positionId` is set NULL on the
 *       affected rows, which net to zero in the balance).
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Position deleted; its fills cascade and any prior close is reversed in the ledger. }
 *       404: { description: Position not found (or not owned by the user). }
 */
positions.put(
  '/:id',
  validate('param', ParamSchema),
  validate('json', UpdatePositionSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const position = await editPosition(db, id, userId, data);
    return c.json(position, 200);
  },
);

positions.delete('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await removePosition(db, id, userId);
  return c.body(null, 204);
});

const OpenSchema = z.object({ openedAt: z.string().datetime().optional() });
const CloseSchema = z.object({ closedAt: z.string().datetime().optional() });

positions.post(
  '/:id/open',
  validate('param', ParamSchema),
  validate('json', OpenSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { openedAt } = c.req.valid('json');
    const position = await openPosition(db, id, userId, openedAt);
    return c.json(position, 200);
  },
);

positions.post(
  '/:id/close',
  validate('param', ParamSchema),
  validate('json', CloseSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { closedAt } = c.req.valid('json');
    const position = await closePosition(db, id, userId, closedAt);
    return c.json(position, 200);
  },
);

/**
 * @swagger
 * /api/positions/{id}/reopen:
 *   post:
 *     summary: Reopen a same-day closed position.
 *     description: >
 *       Authed. Transitions a `closed` position back to `open` for intraday
 *       re-entries, clearing `closedAt` while preserving `openedAt` (the
 *       position's identity day). Allowed only when `openedAt` and the reopen
 *       timestamp fall on the same calendar day **in the account's timezone** —
 *       a position opened on a previous day must be re-entered as a new
 *       position. A supplied `reopenedAt` may not precede `closedAt` nor lie in
 *       the future. Reopening posts a compensating reversing ledger row for the
 *       prior close so a subsequent re-close does not double-count realized P&L.
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reopenedAt:
 *                 type: string
 *                 format: date-time
 *                 description: >
 *                   Optional ISO-8601 reopen timestamp; defaults to now. Must be
 *                   on or after the position's close time and not in the future.
 *     responses:
 *       200: { description: The reopened (now open) position. }
 *       400: { description: reopenedAt precedes closedAt or is in the future. }
 *       404: { description: Position not found (or not owned by the user). }
 *       409: { description: 'The position is not closed, or its open day (in the account timezone) differs from the reopen day.' }
 */
positions.post(
  '/:id/reopen',
  validate('param', ParamSchema),
  validate('json', ReopenPositionSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { reopenedAt } = c.req.valid('json');
    const position = await reopenPosition(db, id, userId, reopenedAt);
    return c.json(position, 200);
  },
);

export default positions;
