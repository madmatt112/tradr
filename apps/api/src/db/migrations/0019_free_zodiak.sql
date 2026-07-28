ALTER TABLE "accounts" ADD COLUMN "timezone" varchar(64) DEFAULT 'America/New_York' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "target_price" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "stop_loss" numeric(18, 8);