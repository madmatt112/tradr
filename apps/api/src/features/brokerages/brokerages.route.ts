import { Hono } from 'hono';
import { z } from 'zod';

import { CreateBrokerageSchema, UpdateBrokerageSchema } from '@tradr/shared/schemas/brokerage';

import { db } from '@/db';
import { validate } from '@/lib/validation';
import { authMiddleware } from '@/middleware/auth.middleware';

import {
  listBrokerages,
  getBrokerage,
  createBrokerage,
  editBrokerage,
  removeBrokerage,
  duplicateBrokerage,
  getPositionCountByBrokerage,
} from './brokerages.service';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

const brokeragesRouter = new Hono<AuthEnv>();

brokeragesRouter.use(authMiddleware);

const ParamSchema = z.object({ id: z.string().uuid() });

/**
 * @swagger
 * /api/brokerages:
 *   get:
 *     summary: List brokerages.
 *     description: >
 *       Authed. Returns the user's own brokerages plus the built-in system
 *       ones, each with its fee schedule. A brokerage is a name and a fee
 *       schedule that accounts and positions reference so commissions are
 *       computed consistently. Tradr does not connect to any broker; nothing
 *       here holds credentials.
 *     tags: [Brokerages]
 *     responses:
 *       200: { description: The brokerages visible to this user. }
 *       401: { description: No valid session. }
 */
brokeragesRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listBrokerages(db, userId);
  return c.json(rows, 200);
});

/**
 * @swagger
 * /api/brokerages/{id}:
 *   get:
 *     summary: Get one brokerage.
 *     tags: [Brokerages]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: The brokerage, including its fee schedule. }
 *       404: { description: No such brokerage for this user. }
 */
brokeragesRouter.get('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const brokerage = await getBrokerage(db, id, userId);
  return c.json(brokerage, 200);
});

/**
 * @swagger
 * /api/brokerages:
 *   post:
 *     summary: Create a brokerage.
 *     description: >
 *       Authed. Names are unique per user. The new brokerage starts with a
 *       zeroed fee schedule; set the rates with a follow-up PUT.
 *     tags: [Brokerages]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 100 }
 *               notes: { type: string, maxLength: 10000, nullable: true }
 *     responses:
 *       201: { description: The created brokerage. }
 *       400: { description: Validation error. }
 *       409: { description: A brokerage with this name already exists. }
 */
brokeragesRouter.post('/', validate('json', CreateBrokerageSchema), async (c) => {
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const brokerage = await createBrokerage(db, userId, data);
  return c.json(brokerage, 201);
});

/**
 * @swagger
 * /api/brokerages/{id}/duplicate:
 *   post:
 *     summary: Duplicate a brokerage.
 *     description: >
 *       Authed. Copies a brokerage and its whole fee schedule under a new name,
 *       which is how you take a system brokerage as the starting point for your
 *       own rates. The copy belongs to the user and is fully editable.
 *     tags: [Brokerages]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       201: { description: The new copy. }
 *       404: { description: No such brokerage for this user. }
 *       409: { description: The generated name collides with an existing brokerage. }
 */
brokeragesRouter.post('/:id/duplicate', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const brokerage = await duplicateBrokerage(db, id, userId);
  return c.json(brokerage, 201);
});

/**
 * @swagger
 * /api/brokerages/{id}:
 *   put:
 *     summary: Edit a brokerage or its fee schedule.
 *     description: >
 *       Authed. Every field is optional; `feeSchedule` is merged, so you can
 *       send a single rate. Fee values are non-negative decimal strings.
 *       System brokerages are read-only.
 *     tags: [Brokerages]
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
 *               name: { type: string, minLength: 1, maxLength: 100 }
 *               notes: { type: string, maxLength: 10000, nullable: true }
 *               feeSchedule:
 *                 type: object
 *                 description: Any subset of the fee fields. Each is a non-negative decimal string.
 *                 properties:
 *                   stockPerShareCommission: { type: string }
 *                   stockMinPerFill: { type: string }
 *                   stockMaxPerFill: { type: string }
 *                   optionsPerContractCommission: { type: string }
 *                   optionsPerContractExchangeFee: { type: string }
 *                   optionsMinPerFill: { type: string }
 *                   optionsMaxPerFill: { type: string }
 *     responses:
 *       200: { description: The updated brokerage. }
 *       400: { description: Validation error. }
 *       403: { description: System brokerages cannot be modified. }
 *       404: { description: No such brokerage for this user. }
 *       409: { description: A brokerage with this name already exists. }
 */
brokeragesRouter.put(
  '/:id',
  validate('param', ParamSchema),
  validate('json', UpdateBrokerageSchema),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const brokerage = await editBrokerage(db, id, userId, data);
    return c.json(brokerage, 200);
  },
);

/**
 * @swagger
 * /api/brokerages/{id}:
 *   delete:
 *     summary: Delete a brokerage.
 *     description: >
 *       Authed. Refused while any account still references the brokerage — the
 *       409 names them, so you can reassign those accounts first. System
 *       brokerages cannot be deleted.
 *     tags: [Brokerages]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204: { description: Deleted. }
 *       403: { description: System brokerages cannot be deleted. }
 *       404: { description: No such brokerage for this user. }
 *       409: { description: Still assigned to one or more accounts, which are named in the message. }
 */
brokeragesRouter.delete('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await removeBrokerage(db, id, userId);
  return c.body(null, 204);
});

/**
 * @swagger
 * /api/brokerages/{id}/position-count:
 *   get:
 *     summary: Count the positions booked against a brokerage.
 *     description: Authed. Used to warn before a destructive edit.
 *     tags: [Brokerages]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: The count.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer }
 *       404: { description: No such brokerage for this user. }
 */
brokeragesRouter.get('/:id/position-count', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const count = await getPositionCountByBrokerage(db, id, userId);
  return c.json({ count }, 200);
});

export default brokeragesRouter;
