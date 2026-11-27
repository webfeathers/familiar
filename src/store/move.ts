/**
 * Move facts to a different entity: the correction for a fact filed under the
 * wrong subject.
 *
 * `merge_entities` fixes two entities that are one thing. This fixes the other
 * filing error: a fact that belongs on a more specific entity (a feature or
 * topic) but was written onto a broad one, where it competes with thousands of
 * others for the few slots `get_context` returns. A forget-and-remember would
 * lose the row's id, confidence, reinforcement count, provenance and
 * created_at; moving keeps every one of them and changes only `entity_id`.
 *
 * Only live facts move. An invalidated row is history and stays where it was
 * believed.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from './index.ts'
import { entities, observations } from './schema.ts'

export interface MoveResult {
  moved: string[]
  /** Ids not moved, with the reason, so the caller can see what was skipped. */
  skipped: { id: string; reason: string }[]
}

export async function moveFacts(observationIds: string[], targetEntityId: string): Promise<MoveResult> {
  const ids = [...new Set(observationIds)]
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(entities).where(eq(entities.id, targetEntityId)).for('update')
    if (!target) throw new Error('target entity not found')
    if (target.mergedInto) throw new Error(`target entity was merged into ${target.mergedInto.slice(0, 8)}; move to that entity instead`)
    // Facts arriving on a retired entity un-retire it, as a direct write does.
    if (target.retiredAt) await tx.update(entities).set({ retiredAt: null }).where(eq(entities.id, targetEntityId))

    const rows = await tx
      .select({ id: observations.id, entityId: observations.entityId, invalidatedAt: observations.invalidatedAt })
      .from(observations)
      .where(inArray(observations.id, ids))
    const byId = new Map(rows.map((r) => [r.id, r]))
    const skipped: MoveResult['skipped'] = []
    const movable: string[] = []
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) skipped.push({ id, reason: 'no such fact' })
      else if (row.invalidatedAt) skipped.push({ id, reason: 'retired fact; history stays where it was believed' })
      else if (row.entityId === targetEntityId) skipped.push({ id, reason: 'already on the target' })
      else movable.push(id)
    }
    if (!movable.length) return { moved: [], skipped }
    const moved = await tx
      .update(observations)
      .set({ entityId: targetEntityId })
      .where(and(inArray(observations.id, movable), isNull(observations.invalidatedAt)))
      .returning({ id: observations.id })
    return { moved: moved.map((m) => m.id), skipped }
  })
}
