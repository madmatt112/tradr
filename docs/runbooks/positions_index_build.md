# Runbook: `positions_user_status_closed_at_idx` build

## 1. Overview

This runbook covers the build, deploy, and recovery procedures for the
composite index `positions_user_status_closed_at_idx` on
`positions (user_id, status, closed_at)`.

The index supports the performance-charts read path: aggregations filter on
`user_id`, a `status` set, and an inclusive `closed_at` range. Without this
index, the planner falls back to a sequential scan and the API exceeds its
10-second per-request budget on production-scale tables.

The index is created by `runPostMigrations()` in
`apps/api/src/db/migrate.ts`. It runs:

- automatically on API boot, after `runMigrations()` and before `serve()`, and
- on demand via `pnpm --filter @tradr/api migrate:post`
  (entry: `apps/api/src/db/migrate-post.ts`).

The post-migration runner is independent from Drizzle's migrator because
`CREATE INDEX CONCURRENTLY` cannot run inside a transaction. The runner:

- holds a session-scoped Postgres advisory lock
  (`POST_MIGRATIONS_LOCK_KEY = 7064002`) so only one container builds at a
  time;
- iterates `apps/api/src/db/post-migrations/*.sql` in filename order;
- skips files already recorded in the `_post_migrations_journal` table;
- for `CREATE INDEX CONCURRENTLY` files: pre-checks `pg_index.indisvalid`,
  drops the index if it is present-but-invalid, executes the SQL, post-checks
  `indisvalid = true`, then writes a journal row.

The journal table tracks applied filenames:

```sql
SELECT filename, applied_at FROM _post_migrations_journal ORDER BY applied_at;
```

Opt-out env var: `SKIP_POST_MIGRATIONS=true` (see `.env.example`). When set,
boot logs a `WARN` and skips the runner entirely; the operator must run
`pnpm migrate:post` out-of-band.

## 2. Normal Path

Default for MVP-scale `positions` tables (sub-second build).

1. Deploy the API. No env-var changes.
2. On boot, the API logs:
   - `Migrations complete`
   - `post-migration applying { filename: '0001_positions_user_status_closed_at_idx.sql' }`
   - `post-migration applied { filename: '0001_positions_user_status_closed_at_idx.sql' }`
   - `Post-migrations complete`
3. The performance-charts endpoints are immediately ready.

No operator action required. Subsequent boots skip the file because the
journal row is present:

```
post-migration skipped (already applied) { filename: '0001_positions_user_status_closed_at_idx.sql' }
```

Verify the index is valid:

```sql
SELECT indisvalid
FROM pg_index
WHERE indexrelid = 'positions_user_status_closed_at_idx'::regclass;
```

Expected: `t`.

## 3. Large-Table Path

Use this path when the `positions` table is too large for a boot-blocking
`CREATE INDEX CONCURRENTLY` (build time approaches the deploy / health-check
window). The index must exist BEFORE any code that depends on it is rolled
out, so we build it out-of-band first, then deploy.

Step 1 — set the opt-out, then deploy the CURRENT (pre-index-dependent)
release.

```sh
# Set in your hosted env (Fly secrets, Render env, k8s secret, etc.)
SKIP_POST_MIGRATIONS=true
```

Boot will log a `WARN`:

```
SKIP_POST_MIGRATIONS=true; skipping post-migrations — operator must run pnpm migrate:post
```

Step 2 — build the index out-of-band during a planned window. Run from a
one-off shell / job with the production `DATABASE_URL` exported. The advisory
lock prevents concurrent builds; idempotent against re-runs.

```sh
pnpm --filter @tradr/api migrate:post
```

Expected output (last line):

```
Post-migrations complete
```

Verify (psql against production):

```sql
SELECT indisvalid
FROM pg_index
WHERE indexrelid = 'positions_user_status_closed_at_idx'::regclass;
```

Expected: `t`.

Step 3 — deploy the index-dependent release with `SKIP_POST_MIGRATIONS`
unset (or set to `false`). Boot will skip the file because the journal row
is already present.

```sh
# Unset the opt-out (or set to false)
SKIP_POST_MIGRATIONS=false
```

Expected boot log:

```
post-migration skipped (already applied) { filename: '0001_positions_user_status_closed_at_idx.sql' }
Post-migrations complete
```

## 4. Recovery Path

If a `CREATE INDEX CONCURRENTLY` is interrupted (deploy killed mid-build,
container OOM, network drop), Postgres leaves the index row with
`pg_index.indisvalid = false`. An invalid index is NOT used by the planner
and will NOT be rebuilt by `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (the
`IF NOT EXISTS` clause sees the existing row and is a no-op).

The post-migration runner handles this automatically:

1. Pre-execution check reads `pg_index.indisvalid` for the parsed index name.
2. If `indisvalid = false`, the runner logs
   `post-migration dropping invalid index before retry` and issues
   `DROP INDEX CONCURRENTLY IF EXISTS positions_user_status_closed_at_idx`.
3. The original `CREATE INDEX CONCURRENTLY` then runs cleanly.
4. Post-execution check verifies `indisvalid = true`. If not, the runner
   throws and does NOT write a journal row, so the next run will retry.

To trigger recovery, just re-run the runner (boot or CLI):

```sh
pnpm --filter @tradr/api migrate:post
```

Verify after recovery:

```sql
SELECT indisvalid
FROM pg_index
WHERE indexrelid = 'positions_user_status_closed_at_idx'::regclass;
```

Expected: `t`.

Confirm the journal row was written:

```sql
SELECT filename, applied_at
FROM _post_migrations_journal
WHERE filename = '0001_positions_user_status_closed_at_idx.sql';
```

Expected: one row.

## 5. Manual Recovery Command

If the automatic path is unavailable (runner crashing, journal row written
but index actually missing/invalid, or you need a clean slate), drop and
recreate manually with psql against production:

```sh
psql "$DATABASE_URL" -c "DROP INDEX CONCURRENTLY IF EXISTS positions_user_status_closed_at_idx; CREATE INDEX CONCURRENTLY IF NOT EXISTS positions_user_status_closed_at_idx ON positions (user_id, status, closed_at);"
```

If the journal row is stale (file recorded as applied but the index is
gone or invalid), clear it before re-running the runner:

```sh
psql "$DATABASE_URL" -c "DELETE FROM _post_migrations_journal WHERE filename = '0001_positions_user_status_closed_at_idx.sql';"
```

Then re-run the runner so the journal is updated through the normal path:

```sh
pnpm --filter @tradr/api migrate:post
```

Final verification:

```sql
SELECT indisvalid
FROM pg_index
WHERE indexrelid = 'positions_user_status_closed_at_idx'::regclass;
```

Expected: `t`.
