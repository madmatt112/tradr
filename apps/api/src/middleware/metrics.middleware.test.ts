import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  httpRequestDuration,
  httpRequestsTotal,
  registry,
} from '@/features/metrics/metrics.registry';

import { metricsMiddleware } from './metrics.middleware';

/**
 * The middleware is exercised against a THROWAWAY Hono app, never the composed
 * `app.ts`: registration there is import-time and gated on `isMetricsConfigured()`,
 * so there is nothing to toggle post-import.
 */

/** Every `{method, route, status}` triple the counter holds, with its value. */
async function counterSamples(): Promise<
  { labels: Partial<Record<string, string | number>>; value: number }[]
> {
  const metric = await httpRequestsTotal.get();
  return metric.values.map((v) => ({ labels: v.labels, value: v.value }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  registry.resetMetrics();
});

describe('metricsMiddleware route label (REQ-5.5, REQ-9.3)', () => {
  it('labels a parameterised route with the PATTERN, not the raw path', async () => {
    const app = new Hono();
    app.use(metricsMiddleware);
    app.get('/things/:id', (c) => c.json({ ok: true }));

    const res = await app.request('/things/abc');
    expect(res.status).toBe(200);

    // The cardinality guarantee: `/things/abc`, `/things/def`, … must all fold
    // into one series. Reading routePath BEFORE `await next()` would yield the
    // middleware's own registered path instead.
    expect(await counterSamples()).toEqual([
      { labels: { method: 'GET', route: '/things/:id', status: '200' }, value: 1 },
    ]);
  });

  it('labels a genuinely unmatched path "unmatched" (REQ-5.7)', async () => {
    const app = new Hono();
    app.use(metricsMiddleware);
    app.get('/things/:id', (c) => c.json({ ok: true }));

    const res = await app.request('/nope');
    expect(res.status).toBe(404);

    // Nothing matched, so the deepest dispatched handler is this middleware
    // itself, registered at `/*`. That is the sentinel's whole mechanism.
    expect(await counterSamples()).toEqual([
      { labels: { method: 'GET', route: 'unmatched', status: '404' }, value: 1 },
    ]);
  });

  it("keeps a MATCHED handler's pattern when it returns 404", async () => {
    const app = new Hono();
    app.use(metricsMiddleware);
    // What `GET /api/positions/:positionId` does routinely for a missing id.
    app.get('/things/:id', (c) => c.json({ error: 'NOT_FOUND' }, 404));

    const res = await app.request('/things/abc');
    expect(res.status).toBe(404);

    // The distinction the sentinel rests on: a 404 from a matched handler is
    // NOT `unmatched`. It rests on a hono implementation detail rather than a
    // documented contract, so it is pinned here.
    expect(await counterSamples()).toEqual([
      { labels: { method: 'GET', route: '/things/:id', status: '404' }, value: 1 },
    ]);
  });

  it('folds a short-circuiting later middleware into "unmatched" (the known merge)', async () => {
    const app = new Hono();
    app.use(metricsMiddleware);
    // Stands in for csrfMiddleware returning 403 CSRF_FORBIDDEN without calling
    // next(). Because it sits AFTER the metrics middleware, route dispatch never
    // happens and the deepest handler is a global middleware at `/*` — so a
    // pre-dispatch rejection shares the `unmatched` bucket with genuine 404s.
    // Accepted (REQ-5.7's letter holds: no app route's handler ever matched)
    // rather than reordering csrfMiddleware in front of instrumentation.
    app.use(async (c) => c.json({ error: 'CSRF_FORBIDDEN' }, 403));
    app.post('/things/:id', (c) => c.json({ ok: true }));

    const res = await app.request('/things/abc', { method: 'POST' });
    expect(res.status).toBe(403);

    expect(await counterSamples()).toEqual([
      { labels: { method: 'POST', route: 'unmatched', status: '403' }, value: 1 },
    ]);
  });

  it("labels a router-level short-circuit with the router's MOUNT WILDCARD", async () => {
    const app = new Hono();
    app.use(metricsMiddleware);

    // Stands in for the 19 feature routers that call `router.use(authMiddleware)`:
    // on an unauthenticated request it returns 401 without calling next(), so the
    // router's own route is never dispatched.
    const router = new Hono();
    router.use(async (c) => c.json({ error: 'UNAUTHORIZED' }, 401));
    router.get('/:id', (c) => c.json({ ok: true }));
    app.route('/api/things', router);

    const res = await app.request('/api/things/abc');
    expect(res.status).toBe(401);

    // A THIRD bucket, distinct from both the route pattern and the `unmatched`
    // sentinel: `app.route()` merges the sub-router's bare `use()` (registered at
    // `*`) onto the mount base, so the deepest dispatched handler's registered
    // path is `/api/things/*`. Only a bare `/*` folds into `unmatched`, so this
    // survives verbatim. Bounded at one extra value per mounted router (REQ-8.2).
    expect(await counterSamples()).toEqual([
      { labels: { method: 'GET', route: '/api/things/*', status: '401' }, value: 1 },
    ]);
  });
});

describe('metricsMiddleware histogram (REQ-5.2, REQ-8.3)', () => {
  it('records a sample carrying method (and le) but NEVER a route label', async () => {
    const app = new Hono();
    app.use(metricsMiddleware);
    app.get('/things/:id', (c) => c.json({ ok: true }));

    await app.request('/things/abc');

    const metric = await httpRequestDuration.get();
    // Non-empty matters: observing with an undeclared `route` label makes
    // prom-client throw, which the recorder swallows and leaves NO samples —
    // an empty list would satisfy a bare "no route label" loop vacuously.
    expect(metric.values.length).toBeGreaterThan(0);

    const labelKeys = new Set(metric.values.flatMap((v) => Object.keys(v.labels)));
    expect(labelKeys.has('route')).toBe(false);
    expect(labelKeys).toEqual(new Set(['method', 'le']));

    const count = metric.values.find((v) => v.metricName?.endsWith('_count'));
    expect(count?.value).toBe(1);
    expect(count?.labels).toEqual({ method: 'GET' });
  });
});

describe('metricsMiddleware reliability NFR', () => {
  it('a recorder that throws does not change the response', async () => {
    // logger.warn writes a JSON line to stdout; keep the run quiet.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(httpRequestsTotal, 'inc').mockImplementation(() => {
      throw new Error('registry exploded');
    });

    const app = new Hono();
    app.use(metricsMiddleware);
    app.get('/things/:id', (c) => c.json({ ok: true }));

    const res = await app.request('/things/abc');

    // Recording happens strictly after `await next()`, so the response is
    // already produced — the worst case is one lost sample.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(log).toHaveBeenCalled();
  });
});
