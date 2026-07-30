import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '@/lib/config';

import * as schema from './schema';

/**
 * App-pool prepared-statement options (REQ-9.2). Prepared statements are
 * incompatible with a transaction-mode pooler, so `prepare: false` is applied
 * ONLY when `DB_TRANSACTION_POOLER` is on. When off (the self-host default) the
 * `prepare` key is OMITTED ENTIRELY so postgres.js keeps its default of
 * prepared statements ON exactly as today (REQ-1.2/9.3), paying none of the
 * ~0.5–2ms/query cost. Passing `prepare: undefined` would instead DISABLE them
 * (`options.prepare` becomes undefined, which the query-time gate treats as
 * falsy), so the key must be absent — not undefined. Independent of
 * `DIRECT_DATABASE_URL`: the app pool always runs over `DATABASE_URL`.
 */
export function poolerDriverOptions(transactionPooler: boolean): { prepare?: false } {
  return transactionPooler ? { prepare: false } : {};
}

/**
 * Seconds an unused pooled connection is kept open. postgres.js defaults to
 * `null` — idle connections are NEVER closed — which leaves the pool holding
 * sockets the server may already have dropped: a pooler that reaps idle
 * backends, a NAT that expires the flow, or a host that suspends. The next
 * query then writes into a dead socket and blocks on TCP retransmit for
 * minutes rather than failing fast or dialing fresh.
 *
 * postgres.js's own staleness guards do not cover the suspend case:
 * `max_lifetime` (30–60min) and `keep_alive` (60s) are in-process timers, so
 * they freeze with the host. Closing the connection ourselves while still
 * running is what makes resume safe.
 *
 * 60s sits below every idle reaper we run behind while staying far above
 * normal request spacing, so a warm instance re-dials rarely.
 */
const IDLE_TIMEOUT_SECONDS = 60;

const sql = postgres(config.DATABASE_URL, {
  max: config.DB_POOL_SIZE,
  idle_timeout: IDLE_TIMEOUT_SECONDS,
  ...poolerDriverOptions(config.DB_TRANSACTION_POOLER),
});

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export { sql };
