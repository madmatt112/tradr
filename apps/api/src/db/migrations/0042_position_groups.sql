CREATE TABLE "position_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label_override" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "position_groups" ADD CONSTRAINT "position_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_group_id_position_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."position_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "positions_group_id_idx" ON "positions" USING btree ("group_id");