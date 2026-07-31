-- Latched flat-only snapshot for performance bucket A (see positions.schema.ts).
-- Written whenever a position goes flat and never cleared, so a reopened
-- position keeps reporting its last flat result instead of vanishing from the
-- completed-trade statistics.
ALTER TABLE "positions" ADD COLUMN "last_flat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "last_flat_net_pnl" numeric(18, 4);;--> statement-breakpoint
-- Backfill for existing data. Without this, every position closed before this
-- migration would have a NULL latch and drop out of the completed-trade
-- statistics entirely.
--
-- Only `last_flat_at` is backfilled: for a position that is CURRENTLY flat, the
-- latched net P&L equals what recomputing from its fills gives, so the service
-- falls back to recomputation when `last_flat_net_pnl` is null. That avoids
-- reimplementing the P&L formula in SQL, where it would inevitably drift from
-- computePnlFromTotals.
UPDATE "positions"
   SET "last_flat_at" = "closed_at"
 WHERE "status" = 'closed' AND "closed_at" IS NOT NULL;
