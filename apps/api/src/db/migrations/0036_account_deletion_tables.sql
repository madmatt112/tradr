CREATE TABLE "account_deletion_schedules" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"stripe_subscription_ids" text[] DEFAULT '{}' NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_schedules_state_chk" CHECK ("account_deletion_schedules"."state" IN ('pending', 'scheduled', 'cancelling', 'firing'))
);
--> statement-breakpoint
CREATE TABLE "account_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email_hash" varchar(64) NOT NULL,
	"tier" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"initiator" text NOT NULL,
	"purge_outcome" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "account_deletions_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "account_deletions_tier_chk" CHECK ("account_deletions"."tier" IN ('free', 'pro')),
	CONSTRAINT "account_deletions_initiator_chk" CHECK ("account_deletions"."initiator" IN ('self', 'admin')),
	CONSTRAINT "account_deletions_purge_outcome_chk" CHECK ("account_deletions"."purge_outcome" IN ('pending', 'complete', 'incomplete', 'not_applicable'))
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" DROP CONSTRAINT "admin_audit_log_action_chk";--> statement-breakpoint
ALTER TABLE "account_deletion_schedules" ADD CONSTRAINT "account_deletion_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_deletion_schedules_state_due_idx" ON "account_deletion_schedules" USING btree ("state","due_at");--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_action_chk" CHECK ("admin_audit_log"."action" IN ('admin_toggle', 'factory_reset', 'account_deletion'));