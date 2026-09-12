CREATE TABLE "position_tags" (
	"position_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "position_tags_position_id_tag_id_pk" PRIMARY KEY("position_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(40) NOT NULL,
	"category" varchar(8) NOT NULL,
	"color" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_category_chk" CHECK ("tags"."category" IN ('setup','emotion','mistake','general'))
);
--> statement-breakpoint
ALTER TABLE "position_tags" ADD CONSTRAINT "position_tags_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_tags" ADD CONSTRAINT "position_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_tags_tag_id_idx" ON "position_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tags_user_id_idx" ON "tags" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_id_lower_name_unique" ON "tags" USING btree ("user_id",lower("name"));