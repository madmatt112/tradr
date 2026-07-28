-- Lives in post-migrations/ because CREATE INDEX CONCURRENTLY cannot run inside
-- a transaction block, and drizzle's `migrate()` wraps every migration in one.
-- runPostMigrations() executes these files outside any transaction, with an
-- advisory lock + journal for idempotency and indisvalid recovery.
CREATE INDEX CONCURRENTLY IF NOT EXISTS positions_user_status_closed_at_idx ON positions (user_id, status, closed_at);
