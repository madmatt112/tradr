-- Which account figure the position-sizing calculator caps position size against
-- (calculator-balance-sizing). See users.schema.ts.
--
-- DEFAULT 'cash' applies to existing rows too, via PostgreSQL's fast default —
-- no backfill statement, no table rewrite. This is a deliberate behaviour change
-- for existing users, not only new ones: capping against total equity tells
-- anyone with capital already deployed to open a position larger than the
-- account can fund, and they find out at the broker. Capping against cash is at
-- worst conservative, so the safe value is the one everybody lands on. Margin
-- traders can opt back to 'balance'.
--
-- This does NOT change the risk budget, which stays `riskPercent × balance`.
ALTER TABLE "users" ADD COLUMN "buying_power_basis" varchar(7) DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_buying_power_basis_chk" CHECK ("users"."buying_power_basis" IN ('cash','balance'));