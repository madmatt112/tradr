CREATE TABLE "brokerages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" varchar(100) NOT NULL,
	"notes" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" uuid NOT NULL,
	"stock_per_share_commission" numeric(18, 8) DEFAULT '0' NOT NULL,
	"stock_min_per_fill" numeric(18, 8) DEFAULT '0' NOT NULL,
	"stock_max_per_fill" numeric(18, 8) DEFAULT '0' NOT NULL,
	"options_per_contract_commission" numeric(18, 8) DEFAULT '0' NOT NULL,
	"options_per_contract_exchange_fee" numeric(18, 8) DEFAULT '0' NOT NULL,
	"options_min_per_fill" numeric(18, 8) DEFAULT '0' NOT NULL,
	"options_max_per_fill" numeric(18, 8) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_schedules_brokerage_id_unique" UNIQUE("brokerage_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "brokerage_id" uuid;--> statement-breakpoint
ALTER TABLE "brokerages" ADD CONSTRAINT "brokerages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brokerages_user_id_idx" ON "brokerages" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brokerages_user_id_name_unique" ON "brokerages" USING btree ("user_id",lower("name")) WHERE "brokerages"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "brokerages_system_name_unique" ON "brokerages" USING btree (lower("name")) WHERE "brokerages"."is_system" = true;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_brokerage_id_idx" ON "accounts" USING btree ("brokerage_id");--> statement-breakpoint

-- System brokerage presets (idempotent)
INSERT INTO "brokerages" ("id", "name", "is_system", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'IBKR Fixed (US Stocks & Options)', true, now(), now()),
  (gen_random_uuid(), 'Schwab (US Stocks & Options)', true, now(), now()),
  (gen_random_uuid(), 'Tastytrade (US Stocks & Options)', true, now(), now()),
  (gen_random_uuid(), 'Commission-Free', true, now(), now())
ON CONFLICT (lower(name)) WHERE is_system = true DO NOTHING;--> statement-breakpoint

-- Fee schedules for system brokerages (idempotent)
INSERT INTO "fee_schedules" ("id", "brokerage_id", "stock_per_share_commission", "stock_min_per_fill", "stock_max_per_fill", "options_per_contract_commission", "options_per_contract_exchange_fee", "options_min_per_fill", "options_max_per_fill", "created_at", "updated_at")
SELECT gen_random_uuid(), b.id, 0.005, 1.00, 0, 0.65, 0.05, 1.00, 0, now(), now()
FROM "brokerages" b WHERE b.name = 'IBKR Fixed (US Stocks & Options)' AND b.is_system = true
ON CONFLICT ("brokerage_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "fee_schedules" ("id", "brokerage_id", "stock_per_share_commission", "stock_min_per_fill", "stock_max_per_fill", "options_per_contract_commission", "options_per_contract_exchange_fee", "options_min_per_fill", "options_max_per_fill", "created_at", "updated_at")
SELECT gen_random_uuid(), b.id, 0, 0, 0, 0.65, 0, 0, 0, now(), now()
FROM "brokerages" b WHERE b.name = 'Schwab (US Stocks & Options)' AND b.is_system = true
ON CONFLICT ("brokerage_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "fee_schedules" ("id", "brokerage_id", "stock_per_share_commission", "stock_min_per_fill", "stock_max_per_fill", "options_per_contract_commission", "options_per_contract_exchange_fee", "options_min_per_fill", "options_max_per_fill", "created_at", "updated_at")
SELECT gen_random_uuid(), b.id, 0, 0, 0, 1.00, 0, 0, 0, now(), now()
FROM "brokerages" b WHERE b.name = 'Tastytrade (US Stocks & Options)' AND b.is_system = true
ON CONFLICT ("brokerage_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "fee_schedules" ("id", "brokerage_id", "stock_per_share_commission", "stock_min_per_fill", "stock_max_per_fill", "options_per_contract_commission", "options_per_contract_exchange_fee", "options_min_per_fill", "options_max_per_fill", "created_at", "updated_at")
SELECT gen_random_uuid(), b.id, 0, 0, 0, 0, 0, 0, 0, now(), now()
FROM "brokerages" b WHERE b.name = 'Commission-Free' AND b.is_system = true
ON CONFLICT ("brokerage_id") DO NOTHING;