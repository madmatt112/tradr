import { createMiddleware } from 'hono/factory';

import { asyncLocalStorage, logger } from '@/lib/logger';

/** First path segment after `/api/` (`/api/positions/123` → `positions`); non-`/api` → undefined. */
function deriveFeature(path: string): string | undefined {
  const match = path.match(/^\/api\/([^/]+)/);
  return match ? match[1] : undefined;
}

export const loggingMiddleware = createMiddleware(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);

  const start = Date.now();
  const feature = deriveFeature(c.req.path);

  await asyncLocalStorage.run({ requestId, feature }, async () => {
    await next();

    // Per-request summary lives INSIDE the ALS scope so this highest-volume line
    // carries requestId/feature/userId in the emitted stdout log.
    const duration = Date.now() - start;
    logger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration,
    });
  });
});
