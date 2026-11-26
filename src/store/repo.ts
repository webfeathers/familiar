/**
 * Repository functions. The only place ingestion touches SQL.
 */
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { episodes, syncState, type NewEpisode, type Source } from './schema.ts'

export const contentHash = (body: unknown) =>
  createHash('sha256').update(JSON.stringify(body)).digest('hex')

/**
 * Idempotent upsert on (source, source_ref).
 *
 * Re-running a connector over an overlapping window must be harmless — that is
 * what makes a watermark safe to rewind. When the payload is unchanged we leave
 * the row alone entirely, so `processed_at` survives and the deriver doesn't
 * redo work. When it HAS changed we clear `processed_at`, which re-queues it:
 * a moved meeting is new information.
 */
export async function upsertEpisodes(rows: NewEpisode[]): Promise<{
  inserted: number
  updated: number
  changedEpisodeIds: string[]
}> {
  if (!rows.length) return { inserted: 0, updated: 0, changedEpisodeIds: [] }

  const result = await db
    .insert(episodes)
    .values(rows)
    .onConflictDoUpdate({
      target: [episodes.source, episodes.sourceRef],
      set: {
        body: sql`excluded.body`,
        occurredAt: sql`excluded.occurred_at`,
        kind: sql`excluded.kind`,
        dedupHash: sql`excluded.dedup_hash`,
        processedAt: sql`null`,
      },
      // Only touch the row when the content actually differs.
      setWhere: sql`${episodes.dedupHash} is distinct from excluded.dedup_hash`,
    })
    .returning({ id: episodes.id, ingestedAt: episodes.ingestedAt })

  // Rows whose ingestedAt is very recent were inserts; the rest were updates.
  // Good enough for reporting — the exact split isn't load-bearing.
  const now = Date.now()
  const inserted = result.filter(
    (r) => now - new Date(r.ingestedAt).getTime() < 5000,
  ).length
  return {
    inserted,
    updated: result.length - inserted,
    changedEpisodeIds: result.map((row) => row.id),
  }
}

export async function getSyncState(source: Source) {
  const rows = await db
    .select()
    .from(syncState)
    .where(eq(syncState.source, source))
    .limit(1)
  return rows[0] ?? null
}

export async function setSyncState(
  source: Source,
  patch: { lastSyncedAt?: Date; cursor?: string | null; lastError?: string | null },
) {
  await db
    .insert(syncState)
    .values({ source, lastRunAt: new Date(), ...patch })
    .onConflictDoUpdate({
      target: syncState.source,
      set: { lastRunAt: new Date(), ...patch },
    })
}
