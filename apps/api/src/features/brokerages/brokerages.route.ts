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

brokeragesRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await listBrokerages(db, userId);
  return c.json(rows, 200);
});

brokeragesRouter.get('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const brokerage = await getBrokerage(db, id, userId);
  return c.json(brokerage, 200);
});

brokeragesRouter.post('/', validate('json', CreateBrokerageSchema), async (c) => {
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const brokerage = await createBrokerage(db, userId, data);
  return c.json(brokerage, 201);
});

brokeragesRouter.post('/:id/duplicate', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const brokerage = await duplicateBrokerage(db, id, userId);
  return c.json(brokerage, 201);
});

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

brokeragesRouter.delete('/:id', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  await removeBrokerage(db, id, userId);
  return c.body(null, 204);
});

brokeragesRouter.get('/:id/position-count', validate('param', ParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.valid('param');
  const count = await getPositionCountByBrokerage(db, id, userId);
  return c.json({ count }, 200);
});

export default brokeragesRouter;
