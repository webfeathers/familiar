/**
 * Working-style preferences — the part that beats a hand-written CLAUDE.md.
 *
 * A static instructions file has three failure modes this is built to avoid:
 * it is written once and never revisited, it carries no evidence for anything
 * it claims, and a line that stopped being true looks exactly like a line that
 * is still true.
 *
 * So preferences here behave differently from every other observation:
 *
 *  - REINFORCEMENT, NOT DUPLICATION. Ordinary facts get deduplicated by
 *    reflection — two rows saying the same thing is noise. But a preference
 *    observed on five separate occasions is *stronger evidence* than one seen
 *    once, and collapsing them would throw that away. So a repeat observation
 *    raises confidence and the observation count instead of inserting a twin.
 *  - CONFIDENCE STARTS LOW. A single instance of someone asking for shorter
 *    answers may be about that one answer. It takes repetition to become "how
 *    the owner works", and the number should say so.
 *  - CONTRADICTION IS VISIBLE. Superseding is explicit, so "prefers X" giving
 *    way to "prefers Y" leaves a trail rather than silently overwriting.
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { entities, observations, type Entity } from './schema.ts'
import { lockLegacyEntity, liveCorrectionRows, retireCorrectionRows, type MemoryTx } from './remember.ts'
import { RESTATEMENT_THRESHOLD, similarity } from './similarity.ts'
import { OWNER_NAME } from '../owner.ts'

/** Who the preferences are about: `PCL_SELF`, see src/owner.ts. */
export const SELF_NAME = OWNER_NAME

/** First observation of a preference. Deliberately tentative. */
const INITIAL_CONFIDENCE = 0.55

/** Each independent re-observation closes part of the gap to certainty. */
const REINFORCEMENT_STEP = 0.12

/** Never reaches 1.0 — a behavioural inference is not a stated fact. */
const CONFIDENCE_CEILING = 0.95

async function findSelfEntity(): Promise<Entity | undefined> {
  const [found] = await db
    .select()
    .from(entities)
    .where(and(sql`lower(${entities.canonicalName}) = lower(${SELF_NAME})`, isNull(entities.mergedInto)))
    .limit(1)
  return found
}

export async function selfEntity(): Promise<Entity> {
  const found = await findSelfEntity()
  if (found) return found

  const [created] = await db
    .insert(entities)
    .values({ type: 'person', canonicalName: SELF_NAME, summary: 'The owner of this context layer' })
    .returning()
  return created!
}

/**
 * Restatement detection now lives in `./similarity.ts`, shared with `remember`
 * so facts and preferences agree on what "the same thing said again" means.
 * Behaviour here is unchanged: same tokeniser, same 0.55 threshold, and the
 * reasoning for that number is documented alongside it.
 */

/**
 * How close an existing preference must be to be offered back as a possible
 * twin when a new one is recorded. Deliberately far below the merge threshold:
 * measured 2026-09-10, a same-meaning rewording of a real preference scored
 * 0.14 against it, and 162 of 417 stored preferences restated another one while
 * no pair scored above 0.52. Wording alone cannot catch those, so the job of
 * this list is to put the likely twin in front of the caller, who can judge.
 */
const NEAR_MATCH_FLOOR = 0.1
const NEAR_MATCH_LIMIT = 3

export interface NearMatch {
  id: string
  statement: string
  score: number
}

export type PreferenceResult = (
  | {
      action: 'recorded'
      id: string
      statement: string
      confidence: number
      observations: number
      /** Closest existing preferences, strongest first — possible twins. */
      nearest: NearMatch[]
    }
  | {
      action: 'reinforced'
      id: string
      /** The stored wording, which is kept; the new wording is not. */
      statement: string
      confidence: number
      observations: number
      /** `id` when the caller named the preference, `wording` when similarity found it. */
      matchedBy: 'id' | 'wording'
      score: number
    }
  | { action: 'not_found'; reinforces: string }
  | { action: 'ambiguous'; reinforces: string; candidates: number }
) & { retired?: { id: string; statement: string; category: string }[] }

async function livePreferences(entityId: string, tx: MemoryTx) {
  return tx
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.entityId, entityId),
        eq(observations.category, 'preference'),
        isNull(observations.invalidatedAt),
      ),
    )
}

type Row = Awaited<ReturnType<typeof livePreferences>>[number]

/**
 * Reinforce one preference. The increments happen in SQL rather than from the
 * row we read: several sessions write preferences concurrently, and a
 * read-modify-write would let two simultaneous reinforcements count as one.
 */
async function reinforce(
  tx: MemoryTx,
  row: Row,
  matchedBy: 'id' | 'wording',
  score: number,
  episodeId?: string,
): Promise<PreferenceResult> {
  const [updated] = await tx
    .update(observations)
    .set({
      confidence: sql`least(${CONFIDENCE_CEILING}, ${observations.confidence} + ${REINFORCEMENT_STEP})`,
      observationCount: sql`${observations.observationCount} + 1`,
      ...(episodeId
        ? { sourceEpisodeIds: sql`array_append(${observations.sourceEpisodeIds}, ${episodeId}::uuid)` }
        : {}),
    })
    .where(eq(observations.id, row.id))
    .returning()

  return {
    action: 'reinforced',
    id: row.id,
    statement: row.statement,
    confidence: updated!.confidence,
    observations: updated!.observationCount,
    matchedBy,
    score,
  }
}

/**
 * Record a working-style preference, reinforcing an existing one if this is
 * really the same trait seen again.
 *
 * Two ways to reinforce, because wording alone cannot do it reliably:
 *  - `reinforces`: the caller names the preference by id (a full id or an
 *    unambiguous prefix of at least 8 characters, as shown in `how_i_work`).
 *    This is the reliable path. A re-observation is usually written fresh from
 *    a new incident and shares few words with the stored line.
 *  - Similarity: without `reinforces`, the BEST-scoring live preference at or
 *    above the restatement threshold is reinforced. This catches a near-verbatim
 *    restatement and nothing looser.
 *
 * A `reinforces` id that matches nothing records nothing. The caller asked to
 * strengthen something specific, so writing a new row instead would be the
 * silent duplicate this function exists to prevent.
 */
export async function notePreference(args: {
  statement: string
  reinforces?: string
  episodeId?: string
  supersedes?: string[]
  expectedEntityId?: string
}): Promise<PreferenceResult> {
  const self = await selfEntity()
  if (args.expectedEntityId && args.expectedEntityId !== self.id) throw new Error('Owner entity changed; resolve it again')
  return db.transaction(async tx => {
    await lockLegacyEntity(tx, self.id)
    const now = new Date()
    await liveCorrectionRows(tx, self.id, args.supersedes ?? [], now)
    const result = await notePreferenceLocked(tx, self.id, args)
    if (result.action !== 'recorded' && result.action !== 'reinforced') return result
    const retired = await retireCorrectionRows(tx, self.id, args.supersedes ?? [], result.id, now)
    return { ...result, retired }
  })
}

async function notePreferenceLocked(tx: MemoryTx, entityId: string, args: {
  statement: string; reinforces?: string; episodeId?: string;
}): Promise<PreferenceResult> {
  const existing = await livePreferences(entityId, tx)

  if (args.reinforces) {
    const key = args.reinforces.trim().toLowerCase()
    const hits = existing.filter((o) => o.id.startsWith(key))
    if (hits.length === 0) return { action: 'not_found', reinforces: args.reinforces }
    if (hits.length > 1) {
      return { action: 'ambiguous', reinforces: args.reinforces, candidates: hits.length }
    }
    const row = hits[0]!
    return reinforce(tx, row, 'id', similarity(row.statement, args.statement), args.episodeId)
  }

  // Best match, not first match: with hundreds of rows in no particular order,
  // "the first one over the threshold" reinforced an arbitrary row.
  const ranked = existing
    .map((row) => ({ row, score: similarity(row.statement, args.statement) }))
    .sort((a, b) => b.score - a.score || b.row.observationCount - a.row.observationCount)

  const best = ranked[0]
  if (best && best.score >= RESTATEMENT_THRESHOLD) {
    return reinforce(tx, best.row, 'wording', best.score, args.episodeId)
  }

  const [created] = await tx
    .insert(observations)
    .values({
      entityId,
      statement: args.statement,
      category: 'preference',
      confidence: INITIAL_CONFIDENCE,
      observationCount: 1,
      validFrom: new Date(),
      sourceEpisodeIds: args.episodeId ? [args.episodeId] : [],
    })
    .returning()

  return {
    action: 'recorded',
    id: created!.id,
    statement: args.statement,
    confidence: INITIAL_CONFIDENCE,
    observations: 1,
    nearest: ranked
      .filter((r) => r.score >= NEAR_MATCH_FLOOR)
      .slice(0, NEAR_MATCH_LIMIT)
      .map((r) => ({ id: r.row.id, statement: r.row.statement, score: r.score })),
  }
}

/**
 * Default size of a `how_i_work` answer.
 *
 * This used to return EVERY live preference, which is fine at twenty and
 * useless at three hundred: measured 2026-08-29, the set had reached 281
 * statements / ~15k tokens, all but eight of them at the 0.55 floor because
 * incident-specific phrasing never re-observes and so never strengthens. An
 * unranked wall that large is read as noise no matter how good the ordering is.
 *
 * Capping is the honest half of the fix (the other half is writing preferences
 * general enough to reinforce). Ordering is by confidence, so the cap keeps
 * what repetition has actually earned and drops the long tail of one-offs.
 */
const DEFAULT_STYLE_LIMIT = 40

/** What the owner is currently believed to want, strongest first. */
export async function workingStyle(
  limit: number = DEFAULT_STYLE_LIMIT,
): Promise<
  { id: string; statement: string; confidence: number; observations: number; since: Date }[]
> {
  // Reading preferences must not create an owner entity on a fresh store.
  const self = await findSelfEntity()
  if (!self) return []
  const rows = await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.entityId, self.id),
        eq(observations.category, 'preference'),
        isNull(observations.invalidatedAt),
      ),
    )
    .orderBy(sql`${observations.confidence} desc, ${observations.validFrom} desc`)
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    statement: r.statement,
    confidence: r.confidence,
    observations: r.observationCount,
    since: r.validFrom,
  }))
}


/**
 * How long a preference may sit at one observation before it is retired.
 *
 * Measured 2026-11-21: 639 live preferences, 40 of them visible in
 * `how_i_work`, growing by 60 to 80 a week. A preference outside the visible
 * set can only be reinforced by a near-verbatim restatement, which almost never
 * happens, so one that was noted once and not seen again in six weeks is an
 * incident, not a way of working. Retiring it is `forget`: the row is kept and
 * `restore` brings it back.
 */
const STALE_PREFERENCE_DAYS = 45

/**
 * Retire the owner's preferences that were observed exactly once, still sit at
 * the starting confidence, and are older than the window. Anything reinforced,
 * or written above the starting confidence, is left alone.
 */
export async function retireStalePreferences(
  now = new Date(),
): Promise<{ id: string; statement: string }[]> {
  const self = await findSelfEntity()
  if (!self) return []
  const cutoff = new Date(now.getTime() - STALE_PREFERENCE_DAYS * 86_400_000)
  return db
    .update(observations)
    .set({ invalidatedAt: now, validTo: now })
    .where(
      and(
        eq(observations.entityId, self.id),
        eq(observations.category, 'preference'),
        isNull(observations.invalidatedAt),
        eq(observations.observationCount, 1),
        // `real` stores 0.55 inexactly, so compare with headroom below the
        // first reinforcement (0.67).
        lt(observations.confidence, INITIAL_CONFIDENCE + 0.01),
        lt(observations.createdAt, cutoff),
      ),
    )
    .returning({ id: observations.id, statement: observations.statement })
}
