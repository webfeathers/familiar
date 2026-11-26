-- IF NOT EXISTS is hand-added: two processes can apply this at once (the worker
-- at start, and a pre-deploy or hand-run `pnpm db:migrate`), and the second
-- must find the index and carry on rather than fail the deploy.
CREATE INDEX IF NOT EXISTS "episodes_body_fts_idx" ON "episodes" USING gin (to_tsvector('english', "body"::text));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_statement_fts_idx" ON "observations" USING gin (to_tsvector('english', "statement"));
