CREATE TABLE "derivation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"scope_decision" jsonb,
	"extractor_provider" text,
	"extractor_model" text,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baseline_decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"jev_provider" text,
	"jev_model" text,
	"jev_result" jsonb,
	"jev_skip_reason" text,
	"usage" jsonb,
	"total_cost_usd" real DEFAULT 0 NOT NULL,
	"error_class" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_observation_ids" uuid[] DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "derivation_runs" ADD CONSTRAINT "derivation_runs_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "derivation_runs_key_idx" ON "derivation_runs" USING btree ("episode_id","content_hash","pipeline_version");--> statement-breakpoint
CREATE INDEX "derivation_runs_state_idx" ON "derivation_runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "derivation_runs_created_at_idx" ON "derivation_runs" USING btree ("created_at");