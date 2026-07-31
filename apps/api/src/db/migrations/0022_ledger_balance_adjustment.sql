-- MANUAL EDIT: INCLUDE ("amount") hand-re-added to ledger_user_account_direction_amount_pnl_idx —
-- drizzle-orm@0.38.4 has no .include() builder, so the generator drops it on every rebuild of this
-- index. See ledger-balances/design.md §Migration (amendment) + Open Design Question 1, and the
-- same manual edit in 0006_smart_bloodstorm.sql where the index was first created.
--
-- Widens ledger_entry_type_chk and both partial index predicates with 'balance_adjustment'
-- (ledger-balances Req 8.1, 2026-07-31 — user-initiated cash balance reconciliation). A partial
-- index's WHERE predicate cannot be ALTERed, so both indexes are dropped and recreated under their
-- existing names. Plain CREATE INDEX (not CONCURRENTLY): ledger_entries holds ~one row per position
-- close, so the brief ACCESS EXCLUSIVE lock is immaterial. Backfill-free — existing rows keep their
-- entry types and already satisfy the widened CHECK.
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entry_type_chk";--> statement-breakpoint
DROP INDEX "ledger_user_account_occurred_pnl_idx";--> statement-breakpoint
DROP INDEX "ledger_user_account_direction_amount_pnl_idx";--> statement-breakpoint
CREATE INDEX "ledger_user_account_occurred_pnl_idx" ON "ledger_entries" USING btree ("user_id","account_id","occurred_at" DESC) WHERE "ledger_entries"."entry_type" IN ('position_pnl', 'position_pnl_reversal', 'balance_adjustment');--> statement-breakpoint
CREATE INDEX "ledger_user_account_direction_amount_pnl_idx" ON "ledger_entries" USING btree ("user_id","account_id","direction") INCLUDE ("amount") WHERE "ledger_entries"."entry_type" IN ('position_pnl', 'position_pnl_reversal', 'balance_adjustment');--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entry_type_chk" CHECK ("ledger_entries"."entry_type" IN ('position_pnl', 'position_pnl_reversal', 'balance_adjustment'));
