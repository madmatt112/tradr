import { createMiddleware } from 'hono/factory';

import { AppError } from '@/lib/errors';

type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
  };
};

export const adminMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  if (!c.get('isAdmin')) {
    throw new AppError(403, 'ADMIN_REQUIRED', 'Admin access required');
  }

  await next();
});
