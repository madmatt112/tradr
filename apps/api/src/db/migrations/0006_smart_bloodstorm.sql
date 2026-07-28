-- MANUAL EDIT (a): INCLUDE (amount) hand-added to ledger_user_account_direction_amount_pnl_idx — drizzle-orm@0.38.4 has no .include() builder. MANUAL EDIT (b): display_currency oldest-account-wins backfill for existing users (adversarial-review r3 Topic 5). See ledger-balances/design.md §Data Models + tasks.md Tasks 5 + 13.
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"base_currency" varchar(3) NOT NULL,
	"quote_currency" varchar(3) NOT NULL,
	"rate" numeric(24, 12) NOT NULL,
	"effective_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_distinct_currencies_chk" CHECK ("exchange_rates"."base_currency" <> "exchange_rates"."quote_currency"),
	CONSTRAINT "exchange_rates_rate_positive_chk" CHECK ("exchange_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"position_id" uuid,
	"entry_type" varchar(32) NOT NULL,
	"direction" varchar(6) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"symbol" varchar(20),
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"group_id" uuid NOT NULL,
	"reverses_group_id" uuid,
	CONSTRAINT "ledger_amount_nonneg_chk" CHECK ("ledger_entries"."amount" >= 0),
	CONSTRAINT "ledger_direction_chk" CHECK ("ledger_entries"."direction" IN ('credit', 'debit')),
	CONSTRAINT "ledger_entry_type_chk" CHECK ("ledger_entries"."entry_type" IN ('position_pnl', 'position_pnl_reversal'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_currency" varchar(3);--> statement-breakpoint
UPDATE users u SET display_currency = (SELECT a.currency FROM accounts a WHERE a.user_id = u.id ORDER BY a.created_at ASC LIMIT 1) WHERE u.display_currency IS NULL AND EXISTS (SELECT 1 FROM accounts a2 WHERE a2.user_id = u.id);--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_user_pair_date_unique" ON "exchange_rates" USING btree ("user_id","base_currency","quote_currency","effective_date");--> statement-breakpoint
CREATE INDEX "ledger_user_id_idx" ON "ledger_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ledger_account_id_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_user_account_occurred_pnl_idx" ON "ledger_entries" USING btree ("user_id","account_id","occurred_at" DESC) WHERE "ledger_entries"."entry_type" IN ('position_pnl', 'position_pnl_reversal');--> statement-breakpoint
CREATE INDEX "ledger_user_account_direction_amount_pnl_idx" ON "ledger_entries" USING btree ("user_id","account_id","direction") INCLUDE ("amount") WHERE "ledger_entries"."entry_type" IN ('position_pnl', 'position_pnl_reversal');--> statement-breakpoint
CREATE INDEX "ledger_reverses_group_id_idx" ON "ledger_entries" USING btree ("reverses_group_id") WHERE "ledger_entries"."reverses_group_id" IS NOT NULL;