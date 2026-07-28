UPDATE "positions" p
SET "closed_at" = COALESCE(
  (SELECT MAX(f."filled_at") FROM "fills" f WHERE f."position_id" = p."id" AND f."type" = 'exit'),
  p."updated_at",
  NOW()
)
WHERE p."status" = 'closed' AND p."closed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_closed_at_when_closed_chk" CHECK ("positions"."status" <> 'closed' OR "positions"."closed_at" IS NOT NULL);
