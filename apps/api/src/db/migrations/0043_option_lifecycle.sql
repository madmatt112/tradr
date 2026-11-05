CREATE TABLE "option_settlement_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"fill_id" uuid,
	"written" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_settlement_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"position_id" uuid,
	"touch" varchar(12) NOT NULL,
	"closed_row" boolean NOT NULL,
	"prior_last_flat_at" timestamp with time zone,
	"prior_last_flat_net_pnl" numeric(18, 4),
	CONSTRAINT "option_settlement_rows_touch_chk" CHECK ("option_settlement_rows"."touch" IN ('leg', 'stock_exit', 'stock_opened'))
);
--> statement-breakpoint
CREATE TABLE "option_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"outcome" varchar(9) NOT NULL,
	"quantity" numeric(18, 8) NOT NULL,
	"premium" numeric(18, 8) NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "option_settlements_outcome_chk" CHECK ("option_settlements"."outcome" IN ('worthless', 'assigned', 'exercised')),
	CONSTRAINT "option_settlements_quantity_positive_chk" CHECK ("option_settlements"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "position_entry_greeks" (
	"position_id" uuid PRIMARY KEY NOT NULL,
	"delta" numeric(24, 12) NOT NULL,
	"gamma" numeric(24, 12) NOT NULL,
	"theta_per_day" numeric(24, 12) NOT NULL,
	"vega_per_pct" numeric(24, 12) NOT NULL,
	"rho_per_pct" numeric(24, 12),
	"source" varchar(13) NOT NULL,
	"volatility" numeric(18, 8),
	"spot" numeric(18, 8),
	"rate" numeric(18, 8),
	"dividend_yield" numeric(18, 8),
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "position_entry_greeks_source_chk" CHECK ("position_entry_greeks"."source" IN ('black_scholes', 'chain'))
);
--> statement-breakpoint
CREATE TABLE "position_rolls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" uuid NOT NULL,
	"from_position_id" uuid NOT NULL,
	"to_position_id" uuid NOT NULL,
	"exit_fill_id" uuid NOT NULL,
	"entry_fill_id" uuid NOT NULL,
	"rolled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "option_settlement_fills" ADD CONSTRAINT "option_settlement_fills_settlement_id_option_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."option_settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_settlement_fills" ADD CONSTRAINT "option_settlement_fills_fill_id_fills_id_fk" FOREIGN KEY ("fill_id") REFERENCES "public"."fills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_settlement_rows" ADD CONSTRAINT "option_settlement_rows_settlement_id_option_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."option_settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_settlement_rows" ADD CONSTRAINT "option_settlement_rows_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_settlements" ADD CONSTRAINT "option_settlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_settlements" ADD CONSTRAINT "option_settlements_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_entry_greeks" ADD CONSTRAINT "position_entry_greeks_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rolls" ADD CONSTRAINT "position_rolls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rolls" ADD CONSTRAINT "position_rolls_from_position_id_positions_id_fk" FOREIGN KEY ("from_position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rolls" ADD CONSTRAINT "position_rolls_to_position_id_positions_id_fk" FOREIGN KEY ("to_position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rolls" ADD CONSTRAINT "position_rolls_exit_fill_id_fills_id_fk" FOREIGN KEY ("exit_fill_id") REFERENCES "public"."fills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_rolls" ADD CONSTRAINT "position_rolls_entry_fill_id_fills_id_fk" FOREIGN KEY ("entry_fill_id") REFERENCES "public"."fills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "option_settlement_fills_settlement_id_idx" ON "option_settlement_fills" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "option_settlement_fills_fill_id_idx" ON "option_settlement_fills" USING btree ("fill_id");--> statement-breakpoint
CREATE INDEX "option_settlement_rows_settlement_id_idx" ON "option_settlement_rows" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "option_settlement_rows_position_id_idx" ON "option_settlement_rows" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "option_settlements_position_id_idx" ON "option_settlements" USING btree ("position_id");--> statement-breakpoint
CREATE UNIQUE INDEX "position_rolls_to_position_id_unique" ON "position_rolls" USING btree ("to_position_id");--> statement-breakpoint
CREATE INDEX "position_rolls_chain_id_idx" ON "position_rolls" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "position_rolls_from_position_id_idx" ON "position_rolls" USING btree ("from_position_id");