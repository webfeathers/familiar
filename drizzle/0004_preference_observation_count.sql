ALTER TABLE "observations" ADD COLUMN "observation_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Backfill. Hand-added: drizzle-kit does not emit data migrations, so keep this
-- if the migration is ever regenerated.
--
-- Before this column existed, reinforcing a preference raised its confidence by
-- exactly 0.12 from a 0.55 start and recorded nothing else, so the count is
-- recoverable from confidence alone: 0.67 = seen twice, 0.79 = 3x, 0.91 = 4x.
-- Rows at the 0.95 ceiling stay at 1 on purpose: every one of them on
-- 2026-09-10 was written by `remember`, which stamps 0.95 at birth, rather than
-- reinforced up to it.
--
-- That arithmetic only holds for rows note_preference wrote. The removed
-- deriver also wrote `preference` rows, at whatever confidence the model chose
-- (0.70, 0.80, 0.85, 0.90 on 2026-09-10), and reading those as reinforcement
-- steps would stamp 8 of them "seen 2-4x" when each was seen once. The MCP
-- path never fills source_episode_ids and the deriver always did, so an empty
-- array is what separates the two.
UPDATE "observations"
SET "observation_count" = 1 + round(("confidence" - 0.55) / 0.12)::integer
WHERE "category" = 'preference' AND "confidence" > 0.6 AND "confidence" < 0.94
  AND cardinality("source_episode_ids") = 0;
