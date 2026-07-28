import { createMiddleware } from 'hono/factory';

import { ClientAbortError, TimeoutError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export type PerformanceTimeoutEnv = {
  Variables: {
    abortSignal: AbortSignal;
    requestStartTime: number;
    requestId: string;
  };
};

interface PerformanceTimeoutOptions {
  ms: number;
}

export function performanceTimeoutMiddleware({ ms }: PerformanceTimeoutOptions) {
  return createMiddleware<PerformanceTimeoutEnv>(async (c, next) => {
    const clientSignal = c.req.raw.signal;

    const controller = new AbortController();
    c.set('abortSignal', controller.signal);
    c.set('requestStartTime', Date.now());

    const onClientAbort = () => {
      controller.abort(new ClientAbortError());
    };
    clientSignal.addEventListener('abort', onClientAbort, { once: true });

    const timer = setTimeout(() => {
      controller.abort(new TimeoutError());
    }, ms);

    try {
      await next();
    } finally {
      clearTimeout(timer);
      clientSignal.removeEventListener('abort', onClientAbort);
      logger.debug('timeout cleared', {
        requestId: c.get('requestId'),
        reason: controller.signal.aborted ? 'aborted' : 'completed',
      });
    }
  });
}
