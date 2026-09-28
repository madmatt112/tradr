CREATE TABLE "trading_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(32) NOT NULL,
	"params" jsonb NOT NULL,
	"weight" varchar(12) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"account_id" uuid,
	"tag_id" uuid,
	"dedup_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_rules_type_chk" CHECK ("trading_rules"."type" IN ('max_risk_percent','max_risk_amount','max_position_size','min_risk_reward','max_daily_loss','max_weekly_loss','max_total_exposure','required_fields','allowed_markets','allowed_directions','no_trading_days','max_trades_per_day','cooldown_after_loss')),
	CONSTRAINT "trading_rules_weight_chk" CHECK ("trading_rules"."weight" IN ('critical','important','nice_to_have'))
);
--> statement-breakpoint
ALTER TABLE "trading_rules" ADD CONSTRAINT "trading_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_rules" ADD CONSTRAINT "trading_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_rules" ADD CONSTRAINT "trading_rules_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trading_rules_user_id_idx" ON "trading_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trading_rules_account_id_idx" ON "trading_rules" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "trading_rules_tag_id_idx" ON "trading_rules" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trading_rules_user_dedup_unique" ON "trading_rules" USING btree ("user_id","dedup_key");