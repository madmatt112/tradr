-- 0. Pre-migration orphan-row check (design v4-12). No-op on first installs (advisor_messages
-- does not exist yet). On re-application after admin/recovery-script intervention, this fires
-- BEFORE the assistant pair-lookup UNIQUE index is created in step 6, giving a clear error
-- message instead of a generic UNIQUE-violation.
DO $$
DECLARE orphan_count integer;
BEGIN
	IF to_regclass('advisor_messages') IS NULL THEN
		-- First install — advisor_messages does not exist yet, so there cannot be orphans.
		RETURN;
	END IF;
	SELECT count(*) INTO orphan_count
	FROM advisor_messages a
	WHERE a.role = 'assistant'
		AND a.client_message_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM advisor_messages u
			WHERE u.conversation_id = a.conversation_id
				AND u.client_message_id = a.client_message_id
				AND u.role = 'user'
		);
	IF orphan_count > 0 THEN
		RAISE EXCEPTION 'Cannot apply migration 0009: % orphan assistant rows exist. Reconcile before proceeding.', orphan_count;
	END IF;
END $$;
--> statement-breakpoint
-- 1. Tables (no FKs, no partial-unique indexes)
CREATE TABLE "advisor_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"persona_id" text,
	"provider_id" varchar(16) NOT NULL,
	"model" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisor_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content_parts" jsonb NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"client_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisor_messages_role_chk" CHECK ("advisor_messages"."role" IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "advisor_personas" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"name" varchar(80) NOT NULL,
	"description" varchar(500),
	"system_prompt" text NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisor_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" varchar(16) NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_version" smallint NOT NULL,
	"default_model" varchar(64) NOT NULL,
	"key_hint_tail" varchar(8) NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 2. ALTER users to add the default-persona column
ALTER TABLE "users" ADD COLUMN "advisor_default_persona_id" text;--> statement-breakpoint
-- 3. Seed built-in personas (user_id = NULL, is_builtin = true; REQ-7.10 pinned text)
INSERT INTO "advisor_personas" ("id", "user_id", "name", "description", "system_prompt", "is_builtin", "is_default") VALUES
	('default-trading-advisor', NULL, 'Trading Advisor', NULL, 'You are a trading advisor for a single retail trader. When the user asks about a setup, ask clarifying questions before recommending action: timeframe, strategy (swing, day, position), risk tolerance, account size if relevant, and which instruments they are considering. Explain your reasoning step-by-step. If a question is ambiguous, list the assumptions you are making. You never place trades on the user''s behalf and never have access to live market data unless the user provides it in the conversation. End every reply with: "Not investment advice — your decisions, your risk."', true, false),
	('risk-coach', NULL, 'Risk Coach', NULL, 'You are a risk-management coach focused on position sizing, R-multiples, and account survival. When the user describes a position or plan, calculate or sanity-check: risk per share, total risk in account-currency, risk-as-percent-of-account, R-multiple to target, and breakeven after fees if the user provides them. Push back when a position size implies more than 2% of account at risk on a single idea unless the user has explicitly stated a higher tolerance. End every reply with a one-line position-size summary in the form `RISK: $X (Y% of account), TARGET R: Z`.', true, false),
	('chart-reviewer', NULL, 'Chart Reviewer', NULL, 'You are a focused technical-pattern reviewer. When the user uploads a chart image, identify the timeframe (or ask if absent), name the pattern(s) you see (e.g. ascending triangle, double bottom, channel break), point out the most important levels (support / resistance / trendlines), and note any volume signal if visible. Avoid speculation about news or fundamentals. If the chart is ambiguous or low-resolution, say so explicitly rather than guessing. Output a brief structured response: PATTERN, LEVELS, VOLUME, CONFIDENCE (low/medium/high).', true, false);
--> statement-breakpoint
-- 4. FK constraints
ALTER TABLE "advisor_conversations" ADD CONSTRAINT "advisor_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_conversations" ADD CONSTRAINT "advisor_conversations_persona_id_advisor_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."advisor_personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_messages" ADD CONSTRAINT "advisor_messages_conversation_id_advisor_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."advisor_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_personas" ADD CONSTRAINT "advisor_personas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_provider_keys" ADD CONSTRAINT "advisor_provider_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_advisor_default_persona_fk" FOREIGN KEY ("advisor_default_persona_id") REFERENCES "public"."advisor_personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- 5. Partial unique indexes
CREATE UNIQUE INDEX "advisor_personas_one_default_per_user" ON "advisor_personas" USING btree ("user_id") WHERE is_default = true AND user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_messages_idem" ON "advisor_messages" USING btree ("conversation_id","client_message_id") WHERE role = 'user' AND client_message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_provider_keys_user_provider_uniq" ON "advisor_provider_keys" USING btree ("user_id","provider_id");--> statement-breakpoint
-- 6. Regular indexes + the assistant pair-lookup UNIQUE index (created AFTER the orphan check in step 0)
CREATE INDEX "advisor_conversations_user_updated_idx" ON "advisor_conversations" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "advisor_messages_conv_created_idx" ON "advisor_messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_messages_assistant_pair_uniq" ON "advisor_messages" USING btree ("conversation_id","client_message_id") WHERE role = 'assistant' AND client_message_id IS NOT NULL;
