-- Renames the curated seed source from its employer-specific name to the
-- generic one. Data only: "source" is a text column, so the schema is unchanged.
-- Safe to apply twice: the second run matches no rows.
UPDATE "episodes" SET "source" = 'work_seed' WHERE "source" = 'leandata_seed';--> statement-breakpoint
UPDATE "sync_state" SET "source" = 'work_seed' WHERE "source" = 'leandata_seed'
  AND NOT EXISTS (SELECT 1 FROM "sync_state" WHERE "source" = 'work_seed');
