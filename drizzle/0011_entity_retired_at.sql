-- IF NOT EXISTS is hand-added, as in 0009: the worker and a hand-run
-- `pnpm db:migrate` can both apply this, and the second must carry on.
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
