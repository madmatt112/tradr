import { Gauge } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Transaction } from '@/db';
import { config } from '@/lib/config';
import { withTransaction } from '@/lib/transaction';

import { resetDbProbeStateForTests } from './metrics.collectors';
import { httpRequestDuration, httpRequestsTotal, initMetrics, registry } from './metrics.registry';
import { createMetricsApp } from './metrics.server';

/**
 * The SAME seam Task 3's collector test uses, and for the same reason:
 * `test-setup.ts` already mocks `@/db` and reassigns `db` to a live drizzle
 * `Transaction` in every `beforeEach`, AFTER any per-file mock — so a per-file
 * `@/db` mock is silently replaced and the "database is down" scrape would
 * quietly run a real `pg_stat_activity` query and succeed. `@/lib/transaction`
 * is a bare passthrough `test-setup.ts` never touches.
 */
vi.mock('@/lib/transaction', () => ({ withTransaction: vi.fn() }));

const withTransactionMock = vi.mocked(withTransaction);

/** REQ-2.2, as a literal — never `registry.contentType`, which compares the served value to itself. */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * APP_VERSION is the one telemetry-relevant variable `vitest.workspace.ts` does
 * NOT pin, so without this it is whatever the ambient environment holds and the
 * emitted `tradr_build_info` labels are unknowable. Pinned to the established
 * `v<semver>-<sha>` shape, and the assertion below states the resulting labels as
 * LITERALS rather than re-deriving them with `parseAppVersion` — comparing the
 * emitted labels against the function that produced them passes for any parse
 * rule at all.
 */
const APP_VERSION_PIN = 'v9.9.9-abc1234';
const EXPECTED_VERSION_LABEL = 'version="v9.9.9-abc1234"';
const EXPECTED_COMMIT_LABEL = 'commit="abc1234"';

/**
 * Postgres's OWN spelling, not the label spelling. `pg_stat_activity.state`
 * returns `idle in transaction` — spaces, no underscores — and the collector
 * translates it to the `idle_in_transaction` LABEL. A fixture written in the
 * label spelling would exercise a vocabulary Postgres never emits.
 */
const HEALTHY_ROWS = [
  { state: 'active', count: 1 },
  { state: 'idle', count: 2 },
  { state: 'idle in transaction', count: 3 },
];

/**
 * Make `withTransaction` actually RUN the collector's callback against a fake
 * transaction, so the probe walks its real three-statement path. A plain
 * `mockResolvedValue` never runs the callback.
 */
function stubHealthyTransaction(): void {
  const execute = vi.fn();
  execute.mockResolvedValueOnce([]); // SET LOCAL statement_timeout
  execute.mockResolvedValueOnce([{ ok: 1 }]); // SELECT 1
  execute.mockResolvedValueOnce(HEALTHY_ROWS); // pg_stat_activity aggregate

  withTransactionMock.mockReset();
  withTransactionMock.mockImplementation(async (_db, callback) =>
    callback({ execute } as unknown as Transaction),
  );
}

/**
 * One scrape against a FRESH app instance. `createMetricsApp()` is a factory
 * precisely so this never binds a socket — `startMetricsServer()` is the only
 * thing that ever listens, and nothing in this file calls it.
 *
 * The single-flight handle is cleared first: a probe left in flight by an earlier
 * scrape would be JOINED rather than re-run, and the join would publish the
 * previous stub's result.
 */
async function scrape(path = '/metrics'): Promise<Response> {
  resetDbProbeStateForTests();
  return createMetricsApp().request(path);
}

// ── The structural checker (rules stated with the assertions that use them) ──
//
// Hand-rolled on purpose: no Prometheus text parser exists in this workspace and
// this spec authorises exactly one new dependency (`prom-client`), which is not
// one. Four rules, all four exercised below.

/** Rule 1: the shape of a sample line — `name`, an optional `{labels}`, whitespace, one value token. */
const SAMPLE_LINE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+\S+$/;

/** Rule 4: the closed set of Prometheus metric types. */
const METRIC_TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped']);

/**
 * Rule 2's suffix strip, and it is CONDITIONAL.
 *
 * Prometheus histograms and summaries serialise as `X_bucket` / `X_sum` /
 * `X_count` samples while `# HELP` and `# TYPE` are emitted under the base name
 * `X` only. A naive "every sample name has a HELP and a TYPE" check therefore
 * reds on every histogram in the registry — including this spec's own
 * `tradr_http_request_duration_seconds`, and nondeterministically on
 * `nodejs_gc_duration_seconds` once a GC has fired.
 *
 * The strip is applied only when the stripped base actually names a family whose
 * declared type is `histogram` or `summary`, so a counter or gauge that happens
 * to END in one of these words keeps its full name.
 *
 * `_total` is NEVER stripped: seven real families here are *named* with it —
 * `tradr_http_requests_total`, `process_cpu_seconds_total`,
 * `nodejs_active_resources_total` and friends — and stripping it would look up
 * families that do not exist.
 */
const COMPONENT_SUFFIXES = ['_bucket', '_sum', '_count'] as const;

function familyOf(sampleName: string, types: Map<string, string>): string {
  for (const suffix of COMPONENT_SUFFIXES) {
    if (!sampleName.endsWith(suffix)) continue;
    const base = sampleName.slice(0, -suffix.length);
    const baseType = types.get(base);
    if (baseType === 'histogram' || baseType === 'summary') return base;
  }
  return sampleName;
}

function nameOf(sampleLine: string): string {
  return /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(sampleLine)?.[0] ?? '';
}

function contentLines(body: string): string[] {
  return body.split('\n').filter((line) => line.trim() !== '');
}

function sampleLines(body: string): string[] {
  return contentLines(body).filter((line) => !line.startsWith('#'));
}

function helpNames(body: string): string[] {
  return contentLines(body)
    .filter((line) => line.startsWith('# HELP '))
    .map((line) => line.split(/\s+/)[2] ?? '');
}

/** Every `# TYPE` line as `{ name, type }` — `type` is the FOURTH token, after `#`, `TYPE`, name. */
function typeLines(body: string): Array<{ name: string; type: string }> {
  return contentLines(body)
    .filter((line) => line.startsWith('# TYPE '))
    .map((line) => {
      const tokens = line.split(/\s+/);
      return { name: tokens[2] ?? '', type: tokens[3] ?? '' };
    });
}

/** Sample lines for `tradr_db_connections`, which is labelled and so never zero-seeded. */
function connectionSamples(body: string): string[] {
  return sampleLines(body).filter((line) => line.startsWith('tradr_db_connections{'));
}

// ── Arming the surface ───────────────────────────────────────────────────────
// WITHOUT THIS EVERY ASSERTION BELOW IS VACUOUS. `initMetrics()` returns at its
// first line when `!isMetricsConfigured()`, and `vitest.workspace.ts` pins
// METRICS_ENABLED off — so `tradr_build_info` would have no sample and no
// `process_*`/`nodejs_*` series would exist at all. `config` is a plain mutable
// object read live by `isMetricsConfigured()` (the `app.split-origin.test.ts`
// mutate-and-restore precedent).

const previous = { METRICS_ENABLED: config.METRICS_ENABLED, APP_VERSION: config.APP_VERSION };

/** The exposition every structural case reads, captured once from a healthy scrape. */
let body: string;
let response: Response;

beforeAll(async () => {
  config.METRICS_ENABLED = true;
  config.APP_VERSION = APP_VERSION_PIN;
  initMetrics();

  // Seed the two shapes rule 2 exists for. Without an observation the histogram
  // emits HELP/TYPE and no samples, so the `_bucket`/`_sum`/`_count` case the
  // conditional strip handles would never appear in the body being checked; and
  // without an increment there is no `_total`-named sample to prove the strip
  // leaves `_total` alone.
  httpRequestDuration.observe({ method: 'GET' }, 0.42);
  httpRequestsTotal.inc({ method: 'GET', route: '/metrics', status: '200' });

  stubHealthyTransaction();
  response = await scrape();
  body = await response.text();
});

afterAll(() => {
  config.METRICS_ENABLED = previous.METRICS_ENABLED;
  config.APP_VERSION = previous.APP_VERSION;
});

describe('GET /metrics (REQ-2.1, REQ-2.2, REQ-9.1)', () => {
  it('answers 200 with the Prometheus text exposition content type, verbatim', () => {
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(CONTENT_TYPE);
  });

  it('rule 1 — every non-blank, non-comment line is a well-formed sample', () => {
    const samples = sampleLines(body);
    expect(samples.length).toBeGreaterThan(0);

    for (const line of samples) {
      expect(line, `malformed sample line: ${line}`).toMatch(SAMPLE_LINE);
    }
  });

  it('rule 2 — every family named by a sample carries both a # HELP and a # TYPE line', () => {
    const types = new Map(typeLines(body).map(({ name, type }) => [name, type]));
    const help = new Set(helpNames(body));

    const families = new Set(sampleLines(body).map((line) => familyOf(nameOf(line), types)));
    expect(families.size).toBeGreaterThan(0);

    for (const family of families) {
      expect(help.has(family), `no # HELP for ${family}`).toBe(true);
      expect(types.has(family), `no # TYPE for ${family}`).toBe(true);
    }

    // The two cases the conditional strip exists for, asserted directly so the
    // rule above cannot pass merely because the body lacked them. A histogram
    // whose components resolve to their base, and a counter NAMED with `_total`
    // whose name must survive intact.
    expect(families.has('tradr_http_request_duration_seconds')).toBe(true);
    expect(families.has('tradr_http_requests_total')).toBe(true);
    expect(
      sampleLines(body).some((line) =>
        line.startsWith('tradr_http_request_duration_seconds_bucket{'),
      ),
    ).toBe(true);
  });

  it('rule 3 — no metric family has a duplicate # TYPE line', () => {
    const names = typeLines(body).map(({ name }) => name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('rule 4 — every # TYPE line declares a known type in its fourth token', () => {
    const declared = typeLines(body);
    expect(declared.length).toBeGreaterThan(0);

    for (const { name, type } of declared) {
      expect(METRIC_TYPES.has(type), `${name} declares unknown type "${type}"`).toBe(true);
    }
  });

  it('emits the tradr_build_info sample with the pinned version/commit labels (REQ-3.1)', () => {
    // The assertion that actually proves initMetrics() RAN. prom-client emits
    // `# HELP`/`# TYPE` for every registered metric whether or not it holds a
    // value, so the structural rules above pass unchanged on a build that
    // silently lost tradr_build_info, tradr_db_pool_max and all of REQ-6.
    const [line, ...rest] = sampleLines(body).filter((l) => l.startsWith('tradr_build_info{'));

    expect(line).toBeDefined();
    expect(rest).toEqual([]);
    expect(line).toContain(EXPECTED_VERSION_LABEL);
    expect(line).toContain(EXPECTED_COMMIT_LABEL);
    expect(line?.endsWith(' 1')).toBe(true);
  });

  it('emits at least one default runtime sample — process_* or nodejs_* (REQ-6.1, REQ-6.2)', () => {
    // The disjunction is deliberate. Naming a specific default metric
    // reintroduces a platform flake: process_open_fds / process_max_fds are
    // Linux-gated while the heap and version metrics are not.
    expect(
      sampleLines(body).some((line) => line.startsWith('process_') || line.startsWith('nodejs_')),
    ).toBe(true);
  });
});

describe('the 404 is structural (REQ-2.7, REQ-9.2)', () => {
  it('mounts exactly one route and serves no application route', async () => {
    const metricsApp = createMetricsApp();

    // The structural assertion: nothing but GET /metrics is registered, so
    // Hono's default not-found is the whole answer. This reds on ANY second
    // route, including one no behavioural probe below happens to hit.
    expect(metricsApp.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /metrics']);

    expect((await metricsApp.request('/')).status).toBe(404);
    expect((await metricsApp.request('/metrics/extra')).status).toBe(404);
    expect((await metricsApp.request('/metrics', { method: 'POST' })).status).toBe(404);
    // An application route the composed app really does serve.
    expect((await metricsApp.request('/api/health')).status).toBe(404);
  });
});

describe('a database failure degrades the exposition, never the scrape (REQ-4.6, REQ-9.4)', () => {
  it('takes tradr_db_up 1 → 0 and drops the connection samples, still answering 200', async () => {
    // THE TRANSITION IS THE EVIDENCE. prom-client seeds a label-free gauge to 0
    // at construction and a labelled one to no values at all, so "tradr_db_up 0
    // with no tradr_db_connections samples" is EXACTLY the state of a registry
    // the collector has never run against — a one-scrape assertion passes on a
    // build with metrics.collectors.ts deleted outright.
    stubHealthyTransaction();
    const healthy = await scrape();
    const healthyBody = await healthy.text();

    expect(healthy.status).toBe(200);
    expect(sampleLines(healthyBody)).toContain('tradr_db_up 1');
    expect(connectionSamples(healthyBody).length).toBeGreaterThan(0);

    withTransactionMock.mockReset();
    withTransactionMock.mockRejectedValue(new Error('CONNECTION_ENDED'));

    const down = await scrape();
    const downBody = await down.text();

    expect(down.status).toBe(200);
    expect(down.headers.get('Content-Type')).toBe(CONTENT_TYPE);
    expect(sampleLines(downBody)).toContain('tradr_db_up 0');
    expect(connectionSamples(downBody)).toEqual([]);
    // PARTIAL, not empty: everything unrelated to the database is still served.
    expect(sampleLines(downBody).some((line) => line.startsWith('tradr_build_info{'))).toBe(true);
  });
});

describe('a serialization failure degrades the exposition, never the scrape (REQ-4.6)', () => {
  /** Test-only, removed in the `finally` below — it must never reach a real exposition. */
  const EXPLOSIVE = 'tradr_test_explosive_collect';

  it('answers 200 when a registered collect() hook throws during serialization', async () => {
    // THE FAILURE THE COLLECTOR SEAM CANNOT REACH. `refreshDbMetrics()` swallows
    // every database failure itself, so the stubbed `@/lib/transaction` above
    // drives nothing past the handler's collector catch — while
    // `registry.metrics()` runs the scrape-time `collect()` hook of every
    // registered metric, exactly as `collectDefaultMetrics()` installs them, and
    // a hook that throws rejects the serialization. Unwrapped, that rejection is
    // a 500 and Prometheus marks the whole target down.
    const explosive = new Gauge({
      name: EXPLOSIVE,
      help: 'test-only: a collect() hook that throws, to drive a real serialization failure',
      registers: [registry],
      collect() {
        throw new Error('COLLECT_EXPLODED');
      },
    });

    try {
      expect(registry.getSingleMetric(EXPLOSIVE)).toBe(explosive);

      // NOT VACUOUS: the hook genuinely takes serialization down. Without this
      // the case below would pass just as happily on a prom-client that
      // swallowed collect() errors, i.e. with nothing to wrap at all.
      await expect(registry.metrics()).rejects.toThrow('COLLECT_EXPLODED');

      stubHealthyTransaction();
      const res = await scrape();

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(CONTENT_TYPE);
      // Empty, not partial — a failed serialization leaves nothing to serve. The
      // status and the content type are the whole assertion: an empty 200 reads
      // as "this instance reports no metrics", a 500 as "this instance is
      // unreachable".
      expect(await res.text()).toBe('');
    } finally {
      registry.removeSingleMetric(EXPLOSIVE);
    }

    // The registry is whole again, so nothing here leaks into a later case or a
    // repeat run of this file.
    await expect(registry.metrics()).resolves.toContain('tradr_build_info{');
  });
});
