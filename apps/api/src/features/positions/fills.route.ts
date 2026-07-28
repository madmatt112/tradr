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

fillsRouter.delete('/:id/fills/:fillId', validate('param', FillParamSchema), async (c) => {
  const userId = c.get('userId');
  const { id: positionId, fillId } = c.req.valid('param');
  await removeFill(db, positionId, fillId, userId);
  return c.body(null, 204);
});

export default fillsRouter;
