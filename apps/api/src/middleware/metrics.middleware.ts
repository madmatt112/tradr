import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';

import { httpRequestDuration, httpRequestsTotal } from '@/features/metrics/metrics.registry';
import { logger } from '@/lib/logger';

/**
 * The bounded stand-in for "no application route matched" (REQ-5.7).
 *
 * With nothing matched, the deepest dispatched handler is the last global
 * middleware, whose registered path is `/*` — hono's `#addRoute` merges a bare
 * `app.use(handler)` (registered with `#path = "*"`) onto the base path. A
 * MATCHED handler that returns 404 resolves to its own pattern instead, so the
 * two are distinguishable; `metrics.middleware.test.ts` pins that, because it
 * rests on an implementation detail rather than a documented contract.
 */
const UNMATCHED = 'unmatched';

/**
 * Per-request rate, error rate and latency (REQ-5).
 *
 * Three mechanics that are easy to get silently wrong:
 *
 * 1. `routePath` comes from `hono/route`. `c.req.routePath` is `@deprecated` in
 *    the installed hono 4.12.8 and points here.
 * 2. It MUST be read AFTER `await next()`. The helper resolves
 *    `matchedRoutes(c).at(c.req.routeIndex)`, and `compose.js` assigns
 *    `context.req.routeIndex = i` before each dispatched handler and never
 *    restores it on unwind — so read beforehand, a global middleware gets its
 *    own registered path (`/*`) for every request.
 * 3. Recording is wrapped so a throw can never reach the response path (design
 *    §Error Scenario 4, Reliability NFR). The response is already produced by
 *    then, so the worst case is one lost sample.
 *
 * The elapsed time is measured to the point `await next()` returns, which is
 * REQ-5.4's "response start": a Hono handler returns its `Response` as soon as
 * the headers are settled, so for the SSE advisor streams this excludes the
 * minutes of streaming that follow.
 *
 * FORWARD CONSTRAINT: the `route` label value must never contain `}`, which
 * would break any consumer parsing the exposition's label block. Today it
 * cannot — no route under `apps/api/src` uses hono's `{regex}` path-constraint
 * syntax — so this is a note for whoever adds the first one, not a defect.
 */
export const metricsMiddleware = createMiddleware(async (c, next) => {
  const start = performance.now();

  await next();

  const seconds = (performance.now() - start) / 1000;

  try {
    const method = c.req.method;
    // `''` is `routePath`'s documented "nothing at this index" return. It is
    // unreachable from inside a running middleware — this middleware is itself
    // in the match result whenever it executes — so it is mapped defensively,
    // not as a second sentinel value.
    const resolved = routePath(c);
    const route = resolved === '' || resolved === '/*' ? UNMATCHED : resolved;

    httpRequestsTotal.inc({ method, route, status: String(c.res.status) });
    // Labelled by method ONLY — deliberately no `route` label, which would not
    // fit the series budget (registry, REQ-8.3).
    httpRequestDuration.observe({ method }, seconds);
  } catch (e) {
    logger.warn('metrics recording failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
