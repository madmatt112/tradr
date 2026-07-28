CREATE TABLE "symbol_sync_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_synced_at" timestamp with time zone,
	"syncing" boolean DEFAULT false NOT NULL,
	"syncing_started_at" timestamp with time zone,
	"symbol_count" integer,
	"last_error" text,
	CONSTRAINT "symbol_sync_state_singleton" CHECK ("symbol_sync_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"ticker" varchar(16) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"exchange" varchar(16) NOT NULL,
	"cik" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "symbols_ticker_prefix_idx" ON "symbols" USING btree ("ticker" varchar_pattern_ops);--> statement-breakpoint
INSERT INTO symbol_sync_state (id, syncing) VALUES (1, false) ON CONFLICT DO NOTHING;