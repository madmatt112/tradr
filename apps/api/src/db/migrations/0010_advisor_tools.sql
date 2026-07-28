CREATE TABLE "advisor_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"prose" text NOT NULL,
	"trade_data_figures" text,
	"covered_through_message_id" uuid,
	"covered_through_created_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_version" smallint NOT NULL,
	"key_hint_tail" varchar(8) NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "advisor_trade_data_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "advisor_summaries" ADD CONSTRAINT "advisor_summaries_conversation_id_advisor_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."advisor_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_api_keys" ADD CONSTRAINT "external_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_summaries_conversation_uniq" ON "advisor_summaries" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_api_keys_user_provider_uniq" ON "external_api_keys" USING btree ("user_id","provider");