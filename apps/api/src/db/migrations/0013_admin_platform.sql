CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"actor_email" varchar(255) NOT NULL,
	"target_user_id" uuid,
	"target_email" varchar(255) NOT NULL,
	"old_value" boolean NOT NULL,
	"new_value" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_log_action_chk" CHECK ("admin_audit_log"."action" IN ('admin_toggle'))
);
--> statement-breakpoint
CREATE TABLE "advisor_turn_counters" (
	"user_id" uuid NOT NULL,
	"period_key" varchar(7) NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisor_turn_counters_user_id_period_key_pk" PRIMARY KEY("user_id","period_key")
);
--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "raw_cost" bigint;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_turn_counters" ADD CONSTRAINT "advisor_turn_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_records_created_idx" ON "usage_records" USING btree ("created_at");