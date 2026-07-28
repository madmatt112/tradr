CREATE TABLE "csv_import_staging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" varchar(12) DEFAULT 'staged' NOT NULL,
	"result" jsonb NOT NULL,
	"committed_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "csv_import_staging" ADD CONSTRAINT "csv_import_staging_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_staging" ADD CONSTRAINT "csv_import_staging_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "csv_import_staging_one_active_per_user_idx" ON "csv_import_staging" USING btree ("user_id") WHERE "csv_import_staging"."status" IN ('staged', 'committing');--> statement-breakpoint
CREATE INDEX "csv_import_staging_user_id_idx" ON "csv_import_staging" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "csv_import_staging_expires_at_idx" ON "csv_import_staging" USING btree ("expires_at");