-- Year-bounded P&L ledger index for the tax-summary path (ca-acb-pool-perf §C4).
-- `listRealisedPositionsForYear` filters ledger_entries by (user_id, occurred_at
-- year window) for exactly the two P&L entry types; without an index bounding
-- both the user and the year the planner falls back to a Seq Scan on
-- ledger_entries. Plain CREATE INDEX (not CONCURRENTLY): ledger_entries holds
-- ~one row per position close, so the brief lock at migrate time is immaterial
-- (same precedent as 0035). The predicate names ONLY the two types the query
-- filters on, deliberately narrower than the per-account partial indexes.
CREATE INDEX "ledger_user_occurred_pnl_idx" ON "ledger_entries" USING btree ("user_id","occurred_at") WHERE "ledger_entries"."entry_type" IN ('position_pnl', 'position_pnl_reversal');