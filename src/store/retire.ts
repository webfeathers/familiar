/**
 * Retiring a name nothing ever attached to.
 *
 * A misread calendar title ("Sr" from "Carson Sr photos") becomes an entity
 * with no facts and no links, and before this there was no way to clear one:
 * `forget` retires a fact, not an entity. They piled up in the brief.
 *
 * Retiring is soft, like a merge: the row keeps its id, name and history, and
 * only `retired_at` is set. It is refused while any live fact or link is
 * attached, so it can never hide something known. The undo is automatic: the
 * next fact written about the entity clears `retired_at` (see
 * `lockLegacyEntity`, `moveFacts` and `mergeEntities`).
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { entities, links, observations } from './schema.ts'

export type RetireResult =
  | { ok: true; name: string }
  | { ok: false; reason: string }

export async function retireEntity(entityId: string, now = new Date()): Promise<RetireResult> {
  return db.transaction(async (tx) => {
    const [entity] = await tx.select().from(entities).where(eq(entities.id, entityId)).for('update')
    if (!entity) return { ok: false, reason: 'Entity not found.' }
    if (entity.mergedInto) return { ok: false, reason: `"${entity.canonicalName}" was merged into another entity; nothing to retire.` }
    if (entity.retiredAt) return { ok: false, reason: `"${entity.canonicalName}" is already retired.` }

    const [factRow] = await tx
      .select({ facts: sql<number>`count(*)::int` })
      .from(observations)
      .where(and(eq(observations.entityId, entityId), isNull(observations.invalidatedAt)))
    const [linkRow] = await tx
      .select({ related: sql<number>`count(*)::int` })
      .from(links)
      .where(and(or(eq(links.fromEntity, entityId), eq(links.toEntity, entityId)), isNull(links.invalidatedAt)))
    const facts = factRow?.facts ?? 0
    const related = linkRow?.related ?? 0
    if (facts || related) {
      return {
        ok: false,
        reason: `"${entity.canonicalName}" has ${facts} live fact(s) and ${related} live link(s), so it is not empty. ` +
          'Forget the facts, retire the links or merge it into the right entity instead.',
      }
    }

    await tx.update(entities).set({ retiredAt: now }).where(eq(entities.id, entityId))
    return { ok: true, name: entity.canonicalName }
  })
}
