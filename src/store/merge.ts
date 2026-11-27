/**
 * Entity merge — the correction path for when resolution split one real thing
 * into two.
 *
 * Merges are SOFT: the losing row survives with `merged_into` pointing at the
 * winner. That matters because observations carry provenance back to episodes,
 * and a hard delete would orphan that history — you could no longer answer
 * "why did it believe this?". It also makes a mistaken merge reversible.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { entities, links, observations } from './schema.ts'

export async function mergeEntities(
  loserId: string,
  winnerId: string,
): Promise<{ observations: number; links: number; aliases: string[] }> {
  if (loserId === winnerId) throw new Error('cannot merge an entity into itself')

  return db.transaction(async tx => {
    // Stable lock order prevents opposite merges deadlocking. These are the
    // same entity row locks acquired by direct writes.
    const rows = await tx.select().from(entities).where(inArray(entities.id, [loserId, winnerId]))
      .orderBy(entities.id).for('update')
    const loser = rows.find(row => row.id === loserId)
    const winner = rows.find(row => row.id === winnerId)
    if (!loser || !winner) throw new Error('entity not found')
    if (loser.mergedInto || winner.mergedInto) throw new Error('entity already merged; resolve both entities again')
    // Links between the pair would become self-links, which are deleted below
    // anyway; drop them first so re-pointing them cannot collide with each other.
    await tx.delete(links).where(or(
      and(eq(links.fromEntity, loserId), eq(links.toEntity, winnerId)),
      and(eq(links.fromEntity, winnerId), eq(links.toEntity, loserId)),
    ))

    // A loser link that the winner already holds (same other end, relation and
    // valid_from) would violate links_unique_live_idx once re-pointed. Both
    // entities were usually linked by the same backfill, so this is the common
    // case, not an edge case. Fold each one into the winner's copy, keeping the
    // union of provenance and the higher confidence, then drop the loser's.
    for (const [mine, other] of [
      [links.fromEntity, links.toEntity],
      [links.toEntity, links.fromEntity],
    ] as const) {
      const mineCol = sql.raw(mine.name)
      const otherCol = sql.raw(other.name)
      await tx.execute(sql`
        UPDATE links w
        SET source_episode_ids = ARRAY(SELECT DISTINCT unnest(w.source_episode_ids || l.source_episode_ids)),
            confidence = GREATEST(w.confidence, l.confidence)
        FROM links l
        WHERE l.${mineCol} = ${loserId} AND w.${mineCol} = ${winnerId}
          AND w.${otherCol} = l.${otherCol} AND w.relation = l.relation AND w.valid_from = l.valid_from`)
      await tx.execute(sql`
        DELETE FROM links l
        USING links w
        WHERE l.${mineCol} = ${loserId} AND w.${mineCol} = ${winnerId}
          AND w.${otherCol} = l.${otherCol} AND w.relation = l.relation AND w.valid_from = l.valid_from`)
    }

    // Move the beliefs. Provenance rides along untouched.
    const movedObs = await tx
      .update(observations)
      .set({ entityId: winnerId })
      .where(eq(observations.entityId, loserId))
      .returning({ id: observations.id })

    const movedFrom = await tx
      .update(links)
      .set({ fromEntity: winnerId })
      .where(eq(links.fromEntity, loserId))
      .returning({ id: links.id })
    const movedTo = await tx
      .update(links)
      .set({ toEntity: winnerId })
      .where(eq(links.toEntity, loserId))
      .returning({ id: links.id })

    // The loser's name and aliases become aliases of the winner, so the surface
    // form that caused the split now resolves directly next time.
    const aliases = Array.from(
      new Set([
        ...winner.aliases,
        loser.canonicalName,
        ...loser.aliases,
      ]),
    ).filter((a) => a !== winner.canonicalName)

    // Clear the winner's provisional flag. It meant "the resolver could not place
    // this confidently" — a successful merge IS that confirmation, and leaving it
    // set makes a resolved identity keep advertising itself as unresolved in the
    // brief's correction queue, which is meant to be a short actionable list.
    await tx
      .update(entities)
      .set({ aliases, provisional: null, retiredAt: null })
      .where(eq(entities.id, winnerId))
    await tx
      .update(entities)
      .set({ mergedInto: winnerId })
      .where(eq(entities.id, loserId))

    // A self-link can appear if both sides were related to each other.
    await tx.delete(links).where(and(eq(links.fromEntity, winnerId), eq(links.toEntity, winnerId)))

    return {
      observations: movedObs.length,
      links: movedFrom.length + movedTo.length,
      aliases,
    }
  })
}

/** Entities the resolver could not confidently place — the correction queue. */
export async function provisionalEntities() {
  return db
    .select()
    .from(entities)
    .where(sql`${entities.provisional} is not null and ${entities.mergedInto} is null`)
}

