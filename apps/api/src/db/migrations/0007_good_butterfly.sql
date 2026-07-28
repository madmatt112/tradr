-- Future-prod-cutover note: 'CREATE UNIQUE INDEX' on ledger_entries takes ACCESS EXCLUSIVE — fine here (empty tables, no prod yet), but the first spec shipping to prod with non-empty ledger_entries MUST switch this index to CREATE UNIQUE INDEX CONCURRENTLY in a separate non-runner migration (drizzle-kit supports raw SQL for this). See tasks.md v1-9.
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" varchar(32) NOT NULL,
	"description" varchar(200) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"occurred_at" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_positive_chk" CHECK ("expenses"."amount" > 0),
	CONSTRAINT "expenses_category_chk" CHECK (category IN ('data_subscription', 'platform_fee', 'software', 'education', 'hardware', 'other')),
	CONSTRAINT "expenses_currency_chk" CHECK (currency IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'HKD', 'SGD', 'NZD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'INR', 'KRW', 'TWD', 'ZAR'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tax_jurisdiction" varchar(8);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_user_id_idx" ON "expenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "expenses_user_occurred_idx" ON "expenses" USING btree ("user_id","occurred_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_position_pnl_unique_idx" ON "ledger_entries" USING btree ("position_id") WHERE "ledger_entries"."entry_type" = 'position_pnl' AND "ledger_entries"."position_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tax_jurisdiction_chk" CHECK ("users"."tax_jurisdiction" IS NULL OR "users"."tax_jurisdiction" IN ('US', 'CA', 'other'));