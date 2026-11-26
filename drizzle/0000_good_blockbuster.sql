-- pgvector must exist before any vector(1536) column is created.
-- drizzle-kit does not emit extension statements; this line is hand-added and
-- must be preserved if this migration is ever regenerated.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"canonical_name" text NOT NULL,
	"summary" text,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"merged_into" uuid,
	"provisional" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tsv" "tsvector",
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"dedup_hash" text NOT NULL,
	"tsv" "tsvector",
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_entity" uuid NOT NULL,
	"to_entity" uuid NOT NULL,
	"relation" text NOT NULL,
	"confidence" real NOT NULL,
	"source_episode_ids" uuid[] DEFAULT '{}' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"category" text NOT NULL,
	"confidence" real NOT NULL,
	"source_episode_ids" uuid[] DEFAULT '{}' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tsv" "tsvector",
	"embedding" vector(1536)
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_from_entity_entities_id_fk" FOREIGN KEY ("from_entity") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_to_entity_entities_id_fk" FOREIGN KEY ("to_entity") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entities_type_idx" ON "entities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "entities_merged_into_idx" ON "entities" USING btree ("merged_into");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_source_ref_idx" ON "episodes" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "episodes_occurred_at_idx" ON "episodes" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "episodes_unprocessed_idx" ON "episodes" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "links_from_idx" ON "links" USING btree ("from_entity");--> statement-breakpoint
CREATE INDEX "links_to_idx" ON "links" USING btree ("to_entity");--> statement-breakpoint
CREATE UNIQUE INDEX "links_unique_live_idx" ON "links" USING btree ("from_entity","to_entity","relation","valid_from");--> statement-breakpoint
CREATE INDEX "observations_entity_idx" ON "observations" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "observations_live_idx" ON "observations" USING btree ("entity_id","invalidated_at");--> statement-breakpoint
CREATE INDEX "observations_category_idx" ON "observations" USING btree ("category");