import { type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';

import { config, isMetricsConfigured } from '@/lib/config';
import { logger } from '@/lib/logger';

import { refreshDbMetrics } from './metrics.collectors';
import { initMetrics, registry } from './metrics.registry';

/**
 * The scrape target, on its OWN listener (REQ-2.1, REQ-2.5).
 *
 * A second port rather than a route on the application server, because the
 * exposition must not be reachable from wherever the API is reachable: network
 * isolation is the whole access control (REQ-8.5 — no bearer token, no shared
 * secret replicated into every scrape config). Nothing here is published in any
 * OpenAPI document either, hence no `@swagger` block (REQ-10.4).
 */

/**
 * Build the metrics app. A FACTORY, not an exported singleton, so a test can
 * take a clean instance and drive it with `app.request()` without binding a
 * socket — `startMetricsServer()` is the only thing that ever listens.
 *
 * Exactly ONE route is mounted. REQ-2.7's "404 on every other path" is therefore
 * structural: there is nothing else to serve, so Hono's default not-found is the
 * whole answer. No `notFound()` handler, no catch-all, and above all no
 * application route — `metrics.server.test.ts` pins the registered route list to
 * a single entry so adding a second one cannot pass unnoticed.
 */
export function createMetricsApp(): Hono {
  const metricsApp = new Hono();

  metricsApp.get('/metrics', async (c) => {
    // THE WHOLE BODY IS WRAPPED, SERIALIZATION INCLUDED. `registry.metrics()` is
    // not a pure string build: `collectDefaultMetrics()` registers scrape-time
    // `collect()` hooks and serialization invokes every one of them
    // (`prom-client/lib/gauge.js:108-112`), so a hook that throws rejects the
    // serialization. Left outside the wrap that rejection propagates out of the
    // handler and Hono answers 500 — which Prometheus records as `up == 0`, an
    // instance that cannot be scraped at all, for a reason unrelated to the
    // database. REQ-4.6 and the Reliability NFR are absolute here: a scrape
    // NEVER throws, and a partial failure degrades to a partial exposition
    // with `200`.
    let exposition = '';

    try {
      // Every scrape is an ACTIVE database probe (REQ-4.9), awaited before
      // serialization so the gauges it writes are in this response rather than
      // the next one.
      //
      // Its OWN catch, nested rather than folded into the outer one, because the
      // two failures degrade differently. `refreshDbMetrics()` never throws by
      // contract — it publishes `tradr_db_up 0` and omits the connection series
      // instead — and this is the second line of defence: a collector failure
      // must still leave the process, runtime and build-info series to serve,
      // which is exactly REQ-4.6's PARTIAL exposition. Folded into the outer
      // catch it would skip serialization and degrade an unreachable database
      // all the way down to an empty body.
      try {
        await refreshDbMetrics();
      } catch (err) {
        logger.warn('metrics: database collection failed; serving a partial exposition', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      exposition = await registry.metrics();
    } catch (err) {
      // A failed serialization leaves nothing to serve, so the degraded body is
      // empty — still `200`, and still the right content type, so the target
      // stays up and the failure reads as "this instance reports no metrics"
      // rather than "this instance is unreachable". Logged at `error`, not
      // `warn`: unlike a database blip there is no external cause and no partial
      // result, so it is always a defect in the exposition itself.
      logger.error('metrics: serialization failed; serving an empty exposition', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // `registry.contentType` is prom-client's own constant and is exactly
    // `text/plain; version=0.0.4; charset=utf-8` (REQ-2.2). Taken from the
    // registry rather than restated, so the served header can never drift from
    // the format actually produced. On EVERY path, degraded or not.
    return c.body(exposition, 200, { 'Content-Type': registry.contentType });
  });

  return metricsApp;
}

/**
 * Start the metrics listener, or return `undefined` when metrics are disabled
 * (REQ-1.4 — no listener is bound at all, the surface is absent rather than
 * empty).
 *
 * DELIBERATELY SYNCHRONOUS. `index.ts` calls this straight after the main
 * `serve()`, and same-tick execution is what guarantees no scrape can arrive
 * before `initMetrics()` has run: an `async` variant would return at its first
 * `await` with the listener already accepting connections and the registry not
 * yet seeded, so an unlucky first scrape would report neither
 * `tradr_build_info` nor any `process_*` series.
 *
 * `initMetrics()` is called here rather than in `app.ts` because this is the
 * only place the metric VALUES are ever read; `app.ts` only needs the metric
 * objects, which the registry module allocates at import.
 */
export function startMetricsServer(): ServerType | undefined {
  if (!isMetricsConfigured()) return undefined;

  initMetrics();

  const metricsApp = createMetricsApp();
  const server = serve({
    fetch: metricsApp.fetch,
    port: config.METRICS_PORT,
    hostname: config.METRICS_HOST,
  });

  // A bind failure (EADDRINUSE) is logged at `error` and is NOT fatal, by
  // design: refusing to serve the product because an observability port is taken
  // inverts the priority. Unlike a mis-set SMTP config, the failure is
  // immediately visible to the very system being configured — Prometheus reports
  // `up == 0` for the target. Without this listener the same `error` event would
  // instead reach the process as an unhandled `'error'` and kill the API.
  server.on('error', (err: Error) => {
    logger.error('Metrics listener failed; the API continues serving normally', {
      host: config.METRICS_HOST,
      port: config.METRICS_PORT,
      error: err.message,
    });
  });

  return server;
}
