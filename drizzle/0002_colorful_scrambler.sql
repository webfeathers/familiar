CREATE TABLE "sync_state" (
	"source" text PRIMARY KEY NOT NULL,
	"last_synced_at" timestamp with time zone,
	"cursor" text,
	"last_run_at" timestamp with time zone,
	"last_error" text
);
