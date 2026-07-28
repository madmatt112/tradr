CREATE TABLE "_post_migrations_journal" (
	"filename" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
