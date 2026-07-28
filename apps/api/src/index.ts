import { serve } from '@hono/node-server';

import { sql } from '@/db';
import { runPostMigrations } from '@/db/migrate';
import { bootstrapFirstAdmin } from '@/features/admin/admin.service';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import { drainMailer, initMailer } from '@/lib/mailer';
import { initPostHog, shutdownPostHog } from '@/lib/posthog';

import app, { bootstrap } from './app';

/**
 * Boot-path post-migration step. Extracted so tests can verify the
 * SKIP_POST_MIGRATIONS conditional without spawning a subprocess.
 * Returns true if post-migrations were run, false if skipped.
 */
export async function bootPostMigrations(
  cfg: { SKIP_POST_MIGRATIONS: boolean } = config,
  run: () => Promise<void> = runPostMigrations,
): Promise<boolean> {
  if (cfg.SKIP_POST_MIGRATIONS) {
    logger.warn(
      'SKIP_POST_MIGRATIONS=true; skipping post-migrations — operator must run pnpm migrate:post',
    );
    return false;
  }
  await run();
  logger.info('Post-migrations complete');
  return true;
}

/**
 * Telemetry flush grace bound (REQ-7.4). A code constant — NOT an env var —
 * comfortably below the ~10 s Docker/Compose SIGTERM→SIGKILL grace (no
 * `stop_grace_period` is set). A sink needing longer is the operator's call.
 */
export const TELEMETRY_FLUSH_TIMEOUT_MS = 3000;

/**
 * Resolve after `ms`. Node has no global `delay`; the dangling timer is harmless
 * — `process.exit(0)` tears down the event loop regardless.
 */
function timeout(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Flush the batching PostHog client before exit (REQ-7) — best-effort and
 * grace-bounded. Resolves instantly when unconfigured (no added latency vs
 * today). Never rejects: a flush rejection goes through `allSettled`, and a hung
 * flush is bounded by the timeout race (REQ-7.3). Does NOT await SSE/in-flight
 * request drain (REQ-7.2). Exported so tests reach it without spawning a process
 * (mirrors the `bootPostMigrations` precedent).
 */
export async function flushTelemetry(timeoutMs = TELEMETRY_FLUSH_TIMEOUT_MS): Promise<void> {
  await Promise.race([Promise.allSettled([shutdownPostHog()]), timeout(timeoutMs)]);
}

async function main() {
  // bootstrap() owns the advisor startup ordering, including runMigrations()
  // (design §Bootstrap order / Task 28). Post-migrations (concurrent indexes)
  // run afterwards.
  await bootstrap();
  logger.info('Migrations complete');

  await bootPostMigrations();

  // Construct the PostHog backend client (design Component 4) — no-op when
  // unconfigured. Eager init removes the concurrent-first-capture race.
  initPostHog();

  // Build the single SMTP transport (transactional-email Component 2) — no-op
  // when email is unconfigured. No boot-time verify: an SMTP outage must not
  // fail startup (D1); failures surface per-send.
  initMailer();

  // First-admin bootstrap (REQ-8.4, design Component 10) — logged, NEVER
  // fatal: an instance with no admin still serves ordinary users.
  try {
    await bootstrapFirstAdmin();
  } catch (err) {
    logger.error('First-admin bootstrap failed; continuing startup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const server = serve({
    fetch: app.fetch,
    port: config.PORT,
  });

  logger.info(`Server started on port ${config.PORT}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // REQ-7.5 double-signal guard (SIGTERM then SIGINT)
    shuttingDown = true;
    logger.info('Shutting down...');
    server.close(); // stop accepting NEW connections (REQ-7.2 ordering)
    // Concurrent bounded drains — telemetry 3 s, mailer 5 s (worst case 5 s,
    // inside the ~10 s Docker grace, D9). Neither ever rejects, so Promise.all
    // is safe. Does NOT await in-flight/SSE request drain.
    await Promise.all([flushTelemetry(), drainMailer()]);
    await sql.end(); // DB teardown, independent of the telemetry flush
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Skip auto-boot when imported by tests; run main() only as the entry module.
if (config.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}
