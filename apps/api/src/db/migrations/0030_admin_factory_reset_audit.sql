ALTER TABLE "admin_audit_log" DROP CONSTRAINT "admin_audit_log_action_chk";--> statement-breakpoint
ALTER TABLE "admin_audit_log" ALTER COLUMN "old_value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ALTER COLUMN "new_value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_toggle_values_chk" CHECK ("admin_audit_log"."action" <> 'admin_toggle' OR ("admin_audit_log"."old_value" IS NOT NULL AND "admin_audit_log"."new_value" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_action_chk" CHECK ("admin_audit_log"."action" IN ('admin_toggle', 'factory_reset'));