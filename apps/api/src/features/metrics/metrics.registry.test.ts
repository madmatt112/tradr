import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '@/lib/config';

import {
  DURATION_BUCKETS,
  buildInfo,
  dbPoolMax,
  httpRequestDuration,
  initMetrics,
  parseAppVersion,
  registry,
} from './metrics.registry';

/**
 * The REQ-5.3 boundaries as LITERALS, restated here on purpose. Comparing the
 * export against itself (`toEqual(DURATION_BUCKETS)`) passes for any array, so
 * the expected side of every bucket assertion below is this list and never the
 * constant under test.
 */
const SPEC_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
];

describe('parseAppVersion (REQ-3.3, REQ-3.4, REQ-3.6)', () => {
  it('splits the established v<semver>-<sha> form on the final dash', () => {
    expect(parseAppVersion('v0.2.0-f51f9f5')).toEqual({
      version: 'v0.2.0-f51f9f5',
      commit: 'f51f9f5',
    });
  });

  it('reports commit "unknown" for a bare semver with no dash', () => {
    expect(parseAppVersion('v0.5.0')).toEqual({ version: 'v0.5.0', commit: 'unknown' });
  });

  it('treats a pre-release tag as a commit, matching the web half exactly', () => {
    // The divergence case. This is NOT a sha, but the rule is "contains a dash",
    // not a `v<semver>-<sha>` pattern match, because that is what the web half's
    // shell `case` does. A tighter rule here would make the two halves disagree
    // and report drift where there is none (REQ-3.6).
    expect(parseAppVersion('v0.5.0-rc.1')).toEqual({ version: 'v0.5.0-rc.1', commit: 'rc.1' });
  });

  it('falls back to "unknown"/"unknown" when APP_VERSION is undefined', () => {
    expect(parseAppVersion(undefined)).toEqual({ version: 'unknown', commit: 'unknown' });
  });

  it('falls back to "unknown"/"unknown" when APP_VERSION is set but EMPTY', () => {
    // The regression case. `Dockerfile.api`'s `ENV APP_VERSION=${APP_VERSION}`
    // always SETS the variable, and config's APP_VERSION is a bare
    // z.string().optional() with no ''→undefined preprocess — so an image built
    // without a build-arg delivers ''. Anything but the fallback emits
    // version="" and breaks the REQ-3.6 join with tradr_web_build_info.
    expect(parseAppVersion('')).toEqual({ version: 'unknown', commit: 'unknown' });
  });
});

describe('metric contract', () => {
  it('exposes the Prometheus text exposition content type verbatim (REQ-2.2)', () => {
    // Asserted against the literal, not against prom-client's own constant, so a
    // library change to the served content type fails loudly here.
    expect(registry.contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('pins DURATION_BUCKETS to the boundaries the spec names (REQ-5.3)', () => {
    expect(DURATION_BUCKETS).toEqual(SPEC_DURATION_BUCKETS);
    // Restated as intent: the long tail is the whole reason these are explicit —
    // prom-client's defaults top out at 10 s.
    expect(DURATION_BUCKETS).toContain(300);
  });

  it('declares exactly one label on the duration histogram — method, NEVER route (REQ-8.3)', () => {
    // The DECLARED label set, not one read back off an observation: an
    // observation only ever carries the labels this test itself passed in, so
    // reading it back proves nothing about the contract. `labelNames` is
    // assigned onto the instance by prom-client's Metric constructor but is not
    // on its public type, hence the cast.
    const declared = (httpRequestDuration as unknown as { labelNames: readonly string[] })
      .labelNames;

    // The mechanically-checkable half of the REQ-8.3 series budget: `route` on
    // this histogram would cost ~2,730 series instead of ~85.
    expect(declared).toEqual(['method']);
  });

  it('carries exactly those boundaries on the duration histogram', async () => {
    // `get()` is async — awaiting it is what makes these assertions capable of
    // failing at all. A labelled histogram has no values until something is
    // observed, so observe once and read the bucket boundaries back out.
    httpRequestDuration.observe({ method: 'GET' }, 0.3);
    const metric = await httpRequestDuration.get();

    const bucketBounds = metric.values
      .filter((v) => v.metricName?.endsWith('_bucket'))
      // `le` is a bucket label prom-client adds at serialization time, so it is
      // absent from the declared label type.
      .map((v) => (v.labels as Record<string, string | number>).le);
    expect(bucketBounds).toEqual([...SPEC_DURATION_BUCKETS, '+Inf']);
  });
});

describe('initMetrics (armed)', () => {
  // ARM THE SURFACE FIRST, or every assertion below passes vacuously:
  // initMetrics() returns at line 1 when !isMetricsConfigured(), and
  // vitest.workspace.ts pins METRICS_ENABLED off — so under the default pin a
  // build with NO idempotency guard at all would still satisfy "called twice
  // does not throw", and tradr_build_info would have no samples to assert on.
  // `config` is a plain mutable object read live by isMetricsConfigured().
  //
  // APP_VERSION is pinned for the same reason, one step further: it is NOT in
  // vitest.workspace.ts's env block, so it is whatever the ambient environment
  // happens to hold and the emitted labels would otherwise be unknowable. '' is
  // the value that actually ships from `Dockerfile.api` when no build-arg is
  // given, so pinning it here makes the label assertion deterministic AND keeps
  // it sensitive to the empty-string fallback regressing.
  const prev = { METRICS_ENABLED: config.METRICS_ENABLED, APP_VERSION: config.APP_VERSION };

  beforeAll(() => {
    config.METRICS_ENABLED = true;
    config.APP_VERSION = '';
  });

  afterAll(() => {
    config.METRICS_ENABLED = prev.METRICS_ENABLED;
    config.APP_VERSION = prev.APP_VERSION;
  });

  it('is idempotent — a second call does not throw', () => {
    expect(() => initMetrics()).not.toThrow();
    expect(() => initMetrics()).not.toThrow();
  });

  it('emits tradr_build_info exactly once, as a constant 1 (REQ-3.1, REQ-3.5)', async () => {
    const metric = await buildInfo.get();

    expect(metric.values).toHaveLength(1);
    expect(metric.values[0]?.value).toBe(1);
    // LITERALS, not `parseAppVersion(config.APP_VERSION)` — comparing the
    // emitted labels against the same function that produced them passes for
    // any parse rule at all, including one that emits version="". These are the
    // labels implied by the APP_VERSION='' pinned above.
    expect(metric.values[0]?.labels).toEqual({ version: 'unknown', commit: 'unknown' });
  });

  it('seeds tradr_db_pool_max from DB_POOL_SIZE (REQ-4.4)', async () => {
    // Label-free gauges are seeded to 0 by prom-client's constructor, so this
    // assertion is only evidence while DB_POOL_SIZE is non-zero.
    expect(config.DB_POOL_SIZE).toBeGreaterThan(0);

    const metric = await dbPoolMax.get();
    expect(metric.values[0]?.value).toBe(config.DB_POOL_SIZE);
  });

  it('collects the default process and Node runtime metrics (REQ-6.1, REQ-6.3)', async () => {
    const names = (await registry.getMetricsAsJSON()).map((m) => m.name);

    // Conventional names, deliberately NOT renamed under the tradr_ prefix.
    expect(names.some((n) => n.startsWith('process_') || n.startsWith('nodejs_'))).toBe(true);
  });
});
