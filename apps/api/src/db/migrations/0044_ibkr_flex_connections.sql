CREATE TABLE "ibkr_flex_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"encrypted_token" text NOT NULL,
	"encrypted_query_id" text NOT NULL,
	"key_version" smallint NOT NULL,
	"token_hint_tail" varchar(8) NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_period_start" date,
	"last_period_end" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ibkr_flex_connections" ADD CONSTRAINT "ibkr_flex_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ibkr_flex_connections" ADD CONSTRAINT "ibkr_flex_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ibkr_flex_connections_account_id_uniq" ON "ibkr_flex_connections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ibkr_flex_connections_user_id_idx" ON "ibkr_flex_connections" USING btree ("user_id");