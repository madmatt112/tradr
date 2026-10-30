CREATE TABLE "fill_transfer_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"exit_fill_id" uuid NOT NULL,
	"entry_fill_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fill_transfer_links_distinct_fills_chk" CHECK ("fill_transfer_links"."exit_fill_id" <> "fill_transfer_links"."entry_fill_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "tax_treatment" varchar(10) DEFAULT 'taxable' NOT NULL;--> statement-breakpoint
ALTER TABLE "fill_transfer_links" ADD CONSTRAINT "fill_transfer_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_transfer_links" ADD CONSTRAINT "fill_transfer_links_exit_fill_id_fills_id_fk" FOREIGN KEY ("exit_fill_id") REFERENCES "public"."fills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_transfer_links" ADD CONSTRAINT "fill_transfer_links_entry_fill_id_fills_id_fk" FOREIGN KEY ("entry_fill_id") REFERENCES "public"."fills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fill_transfer_links_exit_unique" ON "fill_transfer_links" USING btree ("exit_fill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fill_transfer_links_entry_unique" ON "fill_transfer_links" USING btree ("entry_fill_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tax_treatment_chk" CHECK ("accounts"."tax_treatment" IN ('taxable', 'registered'));