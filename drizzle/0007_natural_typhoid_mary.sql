CREATE TABLE "memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"category" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL,
	"supersedes" uuid[] DEFAULT '{}' NOT NULL,
	"derivation_run_id" uuid,
	"candidate_index" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"observation_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"reviewed_by" text,
	"confirmation_method" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_proposals_request_key_idx" ON "memory_proposals" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_proposals_candidate_idx" ON "memory_proposals" USING btree ("derivation_run_id","candidate_index");--> statement-breakpoint
CREATE INDEX "memory_proposals_state_idx" ON "memory_proposals" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "memory_proposals_observation_idx" ON "memory_proposals" USING btree ("observation_id");