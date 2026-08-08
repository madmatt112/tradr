import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import { config, isMetricsConfigured } from '@/lib/config';

/**
 * The metric contract, in one file.
 *
 * A DEDICATED registry — never `prom-client`'s global default register. The
 * default register is process-global shared state: anything else that ever
 * imports `prom-client` (a dependency, a test helper) would silently land its
 * metrics in our exposition, and `registry.clear()` in a test would wipe theirs.
 *
 * Everything here is allocation only. No timer is scheduled, no query is
 * issued, and no sample is taken at module scope — `app.ts` builds the Hono app
 * at module scope and imports the middleware statically, so this module is
 * evaluated on every boot, including the ones where metrics are disabled.
 * `initMetrics()` is the single gated step.
 */
export const registry = new Registry();

/**
 * Explicit histogram boundaries (REQ-5.3). NOT `prom-client`'s defaults, which
 * top out at 10 s: the CSV import path sits behind a 300 s nginx timeout and an
 * advisor turn behind a 180 s read timeout, so the defaults would drop every one
 * of them into `+Inf` and report no latency at all for the slowest paths.
 */
export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
];

/**
 * Deployed build identity as labels on a constant `1` (REQ-3.1, REQ-3.5).
 * The label set is IDENTICAL to `tradr_web_build_info` so the two join cleanly
 * for drift detection after a two-half deploy (REQ-3.6, REQ-7.4).
 */
export const buildInfo = new Gauge<'version' | 'commit'>({
  name: 'tradr_build_info',
  help:
    'Deployed build identity, always the constant 1 — the information is in the labels. ' +
    'version is APP_VERSION as baked into the image at build time (the same value GET /api/health reports); ' +
    'commit is the text after its final "-", or "unknown". ' +
    'Join on version+commit against tradr_web_build_info to detect API/SPA drift after a partial deploy.',
  labelNames: ['version', 'commit'],
  registers: [registry],
});

/** Request counter (REQ-5.1). `route` is the matched PATTERN, never the raw path (REQ-5.5). */
export const httpRequestsTotal = new Counter<'method' | 'route' | 'status'>({
  name: 'tradr_http_requests_total',
  help:
    'Total HTTP requests handled by the API, by method, matched route pattern and numeric status. ' +
    'route is the registered pattern (e.g. /api/positions/:positionId), never the raw request path, ' +
    'and is "unmatched" when no application route matched.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

/**
 * Request latency (REQ-5.2). Labelled by `method` ONLY — deliberately NOT by
 * `route`. A per-route histogram would cost ~2,730 series against the 2,000
 * ceiling in REQ-8.3; per-route ERROR rate survives on the counter above, and
 * per-route LATENCY is the accepted sacrifice.
 */
export const httpRequestDuration = new Histogram<'method'>({
  name: 'tradr_http_request_duration_seconds',
  help:
    'HTTP request latency in seconds, measured to response start (headers flushed), not to connection close — ' +
    'for the SSE advisor streams those differ by minutes and only response start is meaningful. ' +
    'Labelled by method only, not by route: a per-route histogram would not fit the series budget, ' +
    'so use tradr_http_requests_total for per-route error rate.',
  labelNames: ['method'],
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

/** Database liveness (REQ-4.1). */
export const dbUp = new Gauge({
  name: 'tradr_db_up',
  help:
    'Database liveness: 1 when the scrape-time SELECT 1 succeeded, 0 when it failed or timed out. ' +
    'A scrape that finds a probe already in flight joins it rather than opening a second transaction, ' +
    "so a concurrent scrape publishes ANOTHER scrape's SELECT 1 result rather than one it took itself — " +
    "exactly as tradr_db_connections may publish another scrape's row counts. " +
    'This is also the discriminator for absent tradr_db_connections: absent with tradr_db_up 0 means ' +
    'the database is down; absent with no tradr_db_up at all means the instance is not scrapeable.',
  registers: [registry],
});

/** Probe latency (REQ-4.2) — a gauge, because one sample per scrape supports no quantiles. */
export const dbProbeDuration = new Gauge({
  name: 'tradr_db_probe_duration_seconds',
  help:
    'Duration in seconds of the scrape-time database probe. This is WIDER than the SELECT 1 alone: ' +
    'it is measured from before the transaction opens, so it includes the BEGIN and the SET LOCAL statement_timeout ' +
    'that bound the probe. It can also exceed the 5 s scrape deadline — a scrape that finds a probe already in flight ' +
    "joins it and publishes THAT probe's measured duration, a probe it did not itself take and which started earlier.",
  registers: [registry],
});

/** Connection load from `pg_stat_activity` (REQ-4.3). */
export const dbConnections = new Gauge<'state'>({
  name: 'tradr_db_connections',
  help:
    'Backend connections to the current database by state, from pg_stat_activity. ' +
    'DATABASE-GLOBAL, NOT PROCESS-LOCAL: every API instance reports the same counts, and those counts also include ' +
    'the CLI, running migrations and any psql session — so a dashboard that SUMS this across instances over-counts ' +
    'by the replica factor. Compare a single instance against tradr_db_pool_max instead. ' +
    "A scrape that finds a probe already in flight publishes that probe's row counts rather than sampling again, " +
    'and the series is omitted entirely (rather than reported stale) when the probe fails.',
  labelNames: ['state'],
  registers: [registry],
});

/** The saturation denominator (REQ-4.4) — without it the connection gauge cannot express pressure. */
export const dbPoolMax = new Gauge({
  name: 'tradr_db_pool_max',
  help:
    "Configured maximum size of this instance's database connection pool (DB_POOL_SIZE). " +
    'The denominator for tradr_db_connections — postgres.js exposes no pool statistics of its own, ' +
    'so this is the only saturation reference available.',
  registers: [registry],
});

/**
 * Split `APP_VERSION` into the `version` + `commit` label pair (REQ-3.3, REQ-3.4).
 *
 * Exported and pure so the cases are testable: `initMetrics()` is deliberately
 * idempotent and can therefore only ever be driven with one value.
 *
 * The fallback triggers on EMPTY as well as undefined. `Dockerfile.api`'s
 * `ENV APP_VERSION=${APP_VERSION}` always *sets* the variable, and config's
 * `APP_VERSION` is a bare `z.string().optional()` with no ''→undefined
 * preprocess, so an image built without a build-arg delivers `''`. Emitting
 * `version=""` there would break the REQ-3.6 join with the web half — hence the
 * same truthiness test `health.route.ts` uses.
 *
 * The commit split is "contains a `-`", NOT a `v<semver>-<sha>` pattern match.
 * That is exactly what the web half's shell `case` does, and any tighter rule
 * makes the two halves disagree on values like `v0.5.0-rc.1` and report drift
 * where there is none.
 */
export function parseAppVersion(raw: string | undefined): { version: string; commit: string } {
  if (!raw) return { version: 'unknown', commit: 'unknown' };

  const lastDash = raw.lastIndexOf('-');
  if (lastDash === -1) return { version: raw, commit: 'unknown' };

  return { version: raw, commit: raw.slice(lastDash + 1) };
}

let initialised = false;

/**
 * The one gated boot step: seed the static facts and start default collection.
 *
 * A no-op when metrics are disabled (REQ-1.5, REQ-6.4) and idempotent.
 *
 * The guard exists for `collectDefaultMetrics()`, which schedules an interval —
 * NOT for module re-imports. A second module evaluation constructs new metric
 * objects and `prom-client` throws on the first duplicate name, which no boolean
 * here could prevent; `vitest.workspace.ts`'s `pool: 'forks'` already gives each
 * test file its own module graph.
 */
export function initMetrics(): void {
  if (!isMetricsConfigured()) return;
  if (initialised) return;
  initialised = true;

  const { version, commit } = parseAppVersion(config.APP_VERSION);
  buildInfo.set({ version, commit }, 1);

  dbPoolMax.set(config.DB_POOL_SIZE);

  // REQ-6: process_* / nodejs_* keep their conventional names, unprefixed, so
  // community dashboards and alert rules work unmodified.
  collectDefaultMetrics({ register: registry });
}
