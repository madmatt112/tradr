CREATE TABLE "advisor_image_counters" (
	"user_id" uuid NOT NULL,
	"period_key" varchar(7) NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisor_image_counters_user_id_period_key_pk" PRIMARY KEY("user_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "csv_import_counters" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"committed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"price_id" text,
	"price_unit_amount" integer,
	"price_currency" text,
	"stripe_created_at" timestamp with time zone NOT NULL,
	"entered_past_due_at" timestamp with time zone,
	"last_event_created" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "advisor_turn_counters" ADD COLUMN "allowance_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "writable_account_id" uuid;--> statement-breakpoint
ALTER TABLE "advisor_image_counters" ADD CONSTRAINT "advisor_image_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_counters" ADD CONSTRAINT "csv_import_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
-- Hand-added (plan-tiers D18): FK lives in the migration only — a TS .references()
-- from users.schema to accounts.schema would create a circular import (the
-- advisor_default_persona_id / 0009 precedent). Absent from the drizzle snapshot,
-- so `drizzle-kit generate` has nothing to fight.
ALTER TABLE users ADD CONSTRAINT users_writable_account_id_accounts_id_fk FOREIGN KEY (writable_account_id) REFERENCES accounts(id) ON DELETE SET NULL;