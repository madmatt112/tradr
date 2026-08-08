// Task 5 (metrics-instrumentation): the DISABLED path, asserted on the composed
// app. Named for the `app.split-origin.test.ts` precedent — a top-level
// `app.*.test.ts` that asserts middleware behaviour of the assembled `app.ts`
// rather than of a throwaway Hono instance.
//
// NOTHING IN THIS FILE MUTATES `config`. That is the point: it runs under
// `vitest.workspace.ts`'s default pin (`METRICS_ENABLED: 'false'`), which is the
// configuration a self-hoster gets out of the box, and asserts the surface is
// ABSENT rather than empty (REQ-1.4, REQ-9.6).

import { describe, expect, it } from 'vitest';

import app from '@/app';
import { httpRequestsTotal } from '@/features/metrics/metrics.registry';
import { startMetricsServer } from '@/features/metrics/metrics.server';
import { config, isMetricsConfigured } from '@/lib/config';

describe('metrics disabled — the default pin (REQ-1.4, REQ-9.6)', () => {
  it('is genuinely disabled, so the assertions below are not vacuous', () => {
    expect(config.METRICS_ENABLED).toBe(false);
    expect(isMetricsConfigured()).toBe(false);
  });

  it('binds no listener: startMetricsServer() returns undefined', () => {
    // Also the reason this case is safe to run at all — a build that bound a
    // socket here would hold METRICS_PORT for the rest of the worker.
    expect(startMetricsServer()).toBeUndefined();
  });

  it('does not register the metrics middleware on the composed app', async () => {
    // Outside /api on purpose: every router mounted under /api runs
    // authMiddleware at router level and answers 401 before the miss, which is
    // a fine drive but a confusing thing to assert on.
    const res = await app.request('/not-a-route-anything-mounts');
    expect(res.status).toBe(404);

    // `get()` is ASYNC, and the `await` is load-bearing. Un-awaited this reads
    // `undefined` off a Promise: it would red on a CORRECT build, and the
    // natural "fix" — `toBeUndefined()` — then passes just as happily on a build
    // where the middleware IS recording.
    //
    // The empty array is the right expectation: prom-client seeds a zero value
    // only for LABEL-FREE counters, and this one carries three labels. With the
    // middleware registered the request above would have recorded
    // {method:"GET", route:"unmatched", status:"404"}.
    expect((await httpRequestsTotal.get()).values).toEqual([]);
  });
});
