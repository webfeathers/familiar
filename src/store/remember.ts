/** Session writes. A correction and the fact that replaces it land atomically. */
import { and, eq, inArray, isNull, lte, or, gte } from 'drizzle-orm'
import { db } from './index.ts'
import { entities, observations, type ObservationCategory } from './schema.ts'
import { FACT_RESTATEMENT_THRESHOLD, similarity } from './similarity.ts'

export type MemoryTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Serialises writers on one entity; recheck identity after waiting. */
export async function lockLegacyEntity(tx: MemoryTx, entityId: string) {
  const [entity] = await tx.select().from(entities).where(eq(entities.id, entityId)).for('update')
  if (!entity || entity.mergedInto) throw new Error('Entity is missing or already merged; resolve it again before writing')
  return entity
}

export async function liveCorrectionRows(tx: MemoryTx, entityId: string, supersedes: string[], now: Date) {
  const rows = await tx.select().from(observations).where(and(eq(observations.entityId, entityId),
    isNull(observations.invalidatedAt), lte(observations.validFrom, now),
    or(isNull(observations.validTo), gte(observations.validTo, now))))
    .orderBy(observations.id).for('update')
  if (supersedes.some(id => !rows.some(row => row.id === id))) {
    throw new Error('Every supersedes ID must be a live fact on this exact entity; nothing was recorded or retired')
  }
  return rows
}

export async function retireCorrectionRows(tx: MemoryTx, entityId: string, ids: string[], keeperId: string, now: Date) {
  const targets = [...new Set(ids)].filter(id => id !== keeperId)
  if (!targets.length) return []
  const retired = await tx.update(observations).set({ invalidatedAt: now, validTo: now, invalidatedBy: keeperId })
    .where(and(eq(observations.entityId, entityId), inArray(observations.id, targets), isNull(observations.invalidatedAt)))
    .returning()
  if (retired.length !== targets.length) throw new Error('Correction target changed; nothing was recorded or retired')
  return retired
}

export async function rememberFact(args: {
  entityId: string; statement: string; category: ObservationCategory; supersedes?: string[];
}) {
  return db.transaction(async tx => {
    await lockLegacyEntity(tx, args.entityId)
    const now = new Date()
    const rows = await liveCorrectionRows(tx, args.entityId, args.supersedes ?? [], now)
    const auto = ['attribute', 'state'].includes(args.category)
      ? rows.filter(row => ['attribute', 'state'].includes(row.category) &&
        similarity(row.statement, args.statement) >= FACT_RESTATEMENT_THRESHOLD).map(row => row.id) : []
    const [created] = await tx.insert(observations).values({ entityId: args.entityId, statement: args.statement,
      category: args.category, confidence: 0.95, validFrom: now, sourceEpisodeIds: [] }).returning()
    const retired = await retireCorrectionRows(tx, args.entityId, [...auto, ...(args.supersedes ?? [])], created!.id, now)
    return { created: created!, retired }
  })
}
