CREATE TABLE "fill_lot_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exit_fill_id" uuid NOT NULL,
	"entry_fill_id" uuid NOT NULL,
	"quantity" numeric(18, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fill_lot_selections_quantity_positive_chk" CHECK ("fill_lot_selections"."quantity" > 0),
	CONSTRAINT "fill_lot_selections_distinct_fills_chk" CHECK ("fill_lot_selections"."exit_fill_id" <> "fill_lot_selections"."entry_fill_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tax_lot_method" varchar(8);--> statement-breakpoint
ALTER TABLE "fill_lot_selections" ADD CONSTRAINT "fill_lot_selections_exit_fill_id_fills_id_fk" FOREIGN KEY ("exit_fill_id") REFERENCES "public"."fills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill_lot_selections" ADD CONSTRAINT "fill_lot_selections_entry_fill_id_fills_id_fk" FOREIGN KEY ("entry_fill_id") REFERENCES "public"."fills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fill_lot_selections_exit_entry_unique" ON "fill_lot_selections" USING btree ("exit_fill_id","entry_fill_id");--> statement-breakpoint
CREATE INDEX "fill_lot_selections_entry_fill_id_idx" ON "fill_lot_selections" USING btree ("entry_fill_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tax_lot_method_chk" CHECK ("users"."tax_lot_method" IS NULL OR "users"."tax_lot_method" IN ('fifo', 'average'));