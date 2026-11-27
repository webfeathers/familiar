/**
 * Retrieval — assembling the smallest set of high-signal facts about a subject.
 *
 * The failure this module exists to prevent is not "we couldn't find it". It is
 * the opposite: returning EVERYTHING known and letting the model sort it out.
 * Stuffed context measurably degrades answers ("context rot"), and a flat dump
 * ordered by confidence puts a 0.95 phone number above the one fact that
 * actually matters. So the contract here is selective assembly: start at the
 * subject entity, walk ONE hop of live relations, rank, and cut.
 *
 * Three disciplines carry it:
 *
 *  - RANKING IS PLAIN CODE, NEVER A MODEL CALL. This sits inside a tool
 *    response. A model in the retrieval path would put a multi-second, failable
 *    dependency between the user and their own memory, and the deriver already
 *    spent the expensive reasoning offline so this doesn't have to.
 *  - DECAY LIVES IN RANKING, NOT IN STORAGE. Nothing here writes. An old fact
 *    is not deleted or invalidated, it simply stops winning — which is what
 *    lets `attribute` stay durable while `state` gets out of the way, without
 *    two different storage policies.
 *  - ONE HOP, NOT N. Two hops from a person reaches their colleague's spouse's
 *    employer, which is noise wearing the costume of relevance. The neighbour
 *    ring is there to answer "who is this to me", not to transit the graph.
 *  - A NEIGHBOUR'S FACT MUST BE ABOUT THE SUBJECT. One hop bounds how far the
 *    read walks, not what it brings back. A teammate's birthday is one hop from
 *    their project and scores well over the floor, yet it has nothing to say
 *    about the project. So a neighbour contributes a fact only when that fact
 *    names the subject, or matches the topic the caller asked about; the
 *    neighbour itself still appears under Related, with its summary, which is
 *    what "who is this to me" actually needs.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '../store/index.ts'
import { entities, episodes, links, observations, syncState } from '../store/schema.ts'
import type { Entity, Observation, ObservationCategory, SyncState } from '../store/schema.ts'
import { similarity, tokens } from '../store/similarity.ts'

// ── Live predicate ───────────────────────────────────────────────────────────

/**
 * Live = not invalidated and not past its validity window. Exported because
 * "what counts as current" must have exactly one definition — a tool that
 * checks only `invalidatedAt` silently resurrects expired anticipations.
 */
export const live = and(
  isNull(observations.invalidatedAt),
  lte(observations.validFrom, sql`now()`),
  or(isNull(observations.validTo), gte(observations.validTo, sql`now()`)),
)

// ── Ranking weights ──────────────────────────────────────────────────────────
// The score is additive over four signals, then scaled by graph distance. All
// four are on roughly the 0–1 scale so the weights below are directly
// comparable to each other, and to `confidence`, which is the anchor at 1.0.

/**
 * Confidence, straight through. Everything else is expressed relative to this,
 * so "how much can I trust this" is never outvoted by a single other signal.
 */
const W_CONFIDENCE = 1.0

/**
 * Recency. Deliberately smaller than the attribute/state category gap: a fresh
 * `state` should beat a stale one, but freshness alone must not let "in a
 * meeting until 4pm" outrank "is my brother". Set this above ~0.8 and the
 * durable-attribute invariant breaks.
 */
const W_RECENCY = 0.6

/**
 * Corroboration — how many distinct episodes produced this belief. Small on
 * purpose: it is a tiebreaker between otherwise comparable facts, not a
 * popularity contest. A thing mentioned in ten meetings is not more true than
 * a thing stated once, only better evidenced.
 */
const W_CORROBORATION = 0.3

/**
 * Per-category prior — the "what kind of claim is this" term.
 *
 *   attribute    durable and identity-defining; the thing you want first.
 *   preference   durable but revisable, so just below attribute.
 *   state        true right now, may not be in a week. Fine when fresh, and
 *                the recency half-life below is what demotes it when it isn't.
 *   event        happened once; still true forever, but rarely the headline.
 *   anticipation NEGATIVE, and that is the point. It is an inference, not an
 *                observation. Surfacing it is useful; letting a 0.9-confidence
 *                guess sit above an established fact is how a memory system
 *                starts confidently making things up. Sized so that even a
 *                maximally-confident fresh anticipation scores below a mediocre
 *                attribute. The absolute separation is the second bucket in
 *                `assembleContext` — this weight is what keeps the two
 *                consistent instead of fighting, since a single stale-enough
 *                fact can still be out-scored by a very confident guess.
 */
const CATEGORY_WEIGHT: Record<ObservationCategory, number> = {
  attribute: 0.5,
  preference: 0.35,
  state: 0.2,
  event: 0.1,
  anticipation: -0.4,
}

/**
 * Recency half-life in days, per category — because a single global decay is
 * exactly the mistake the schema was designed to avoid. `attribute` is
 * Infinity, which makes the decay term evaluate to 1 forever: "spouse is Dave"
 * must not fade just because it was learned in April.
 */
const HALF_LIFE_DAYS: Record<ObservationCategory, number> = {
  attribute: Infinity,
  preference: 365,
  event: 60,
  state: 14,
  // Shortest of all: a forward-looking guess whose moment has passed is worse
  // than no guess, and `validTo` alone won't catch one whose expiry was set
  // generously.
  anticipation: 7,
}

/**
 * Where corroboration stops paying. Going from one source to two is real
 * evidence; going from nine to ten is noise, and without saturation a
 * chatty recurring meeting would dominate the ranking by volume alone.
 */
const CORROBORATION_SATURATION = 5

/**
 * Multiplier applied to facts about a neighbour rather than the subject. Kept
 * multiplicative rather than a flat subtraction so a strong neighbour fact can
 * still surface when the subject itself is thin, while never crowding out the
 * subject's own facts when it isn't.
 */
const HOP_DECAY = 0.45

/**
 * Shortest first name used to recognise a person in a neighbour's facts.
 * "Dana owns the runbook" names Dana Whitfield; a two-letter token ("Al", "Jo")
 * appears inside too many unrelated sentences to stand for anyone.
 */
const MIN_FIRST_NAME = 3

/**
 * Facts scoring below this are dropped even when there is room left in the
 * budget. "Smallest high-signal set" means returning four facts when only four
 * are worth reading — filling the quota with the dregs of the neighbour ring is
 * the load-everything failure re-introduced through the back door.
 */
const RELEVANCE_FLOOR = 0.55

/** Default size of a bundle. Roughly what fits in a glance without scrolling. */
const DEFAULT_FACT_LIMIT = 18

/** Neighbours to walk. Past this, the "Related" list stops being readable. */
const MAX_NEIGHBOURS = 12

/** Candidate ceiling per read: the most that is ranked before the cut. */
const MAX_CANDIDATE_FACTS = 250

/** Merge chains should be one deep; the cap is a cycle guard, not a traversal. */
const MAX_MERGE_HOPS = 8

// ── Scoring ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/**
 * Exponential decay on valid-time. Uses `validFrom` (when the fact became true)
 * rather than `createdAt` (when we noticed) on purpose: back-filling a year of
 * calendar history should not make every fact in it look brand new.
 */
function recencyScore(validFrom: Date, category: ObservationCategory): number {
  const halfLife = HALF_LIFE_DAYS[category]
  if (!Number.isFinite(halfLife)) return 1
  const ageDays = (Date.now() - validFrom.getTime()) / DAY_MS
  // A fact dated in the future (a scheduled state change) is as relevant as one
  // dated now, not more so.
  return 0.5 ** (Math.max(0, ageDays) / halfLife)
}

/** Logarithmic, so the first corroborating source is worth far more than the fifth. */
function corroborationScore(sources: number): number {
  if (sources <= 0) return 0
  return Math.min(1, Math.log1p(sources) / Math.log1p(CORROBORATION_SATURATION))
}

/**
 * Exported so the invariants can be asserted against fixtures without a
 * database — "a durable attribute outranks a stale state" and "an anticipation
 * never outranks an established fact" are properties of these numbers, and the
 * only way to know a weight change broke one is to check it directly.
 */
export function scoreObservation(o: Observation, hops: number): number {
  const raw =
    W_CONFIDENCE * o.confidence +
    W_RECENCY * recencyScore(o.validFrom, o.category) +
    CATEGORY_WEIGHT[o.category] +
    W_CORROBORATION * corroborationScore(o.sourceEpisodeIds.length)

  // Clamp before the hop multiplier: an anticipation can score negative, and
  // multiplying a negative by 0.45 would REWARD it for being further away.
  return Math.max(0, raw) * (hops > 0 ? HOP_DECAY : 1)
}

// ── Entity resolution (read side) ────────────────────────────────────────────

/**
 * Follow `merged_into` to the surviving row. Merges are soft, so a name the
 * user still uses ("Sam") resolves to a row that has since been merged into
 * "Sam Rivera" — and the facts all live on the winner.
 */
async function followMerges(start: Entity): Promise<Entity> {
  let current = start
  for (let i = 0; i < MAX_MERGE_HOPS && current.mergedInto; i++) {
    const [next] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, current.mergedInto))
      .limit(1)
    if (!next || next.id === current.id) break
    current = next
  }
  return current
}

/**
 * Best-substantiated first. When two rows both match "Dave", the one carrying
 * facts is nearly always the one meant; the hollow duplicate is usually a
 * misparse the consolidation pass hasn't reached yet.
 */
const substantiation = sql`(
  select count(*) from observations o
  where o.entity_id = ${entities.id} and o.invalidated_at is null
)`

/**
 * Resolve a user-supplied name to an entity, in descending order of certainty.
 * Ordered rather than one big OR because an exact canonical-name hit must never
 * lose to a substring match on a longer name.
 *
 * `fuzzy: false` stops before the substring pass. Reads want the loose net —
 * guessing wrong only shows the wrong briefing, which the user immediately
 * sees. WRITES must not use it: attaching a new fact to a substring-matched
 * entity is a silent wrong merge, the one failure mode this graph cannot detect
 * afterwards.
 */
export async function resolveSubject(
  subject: string,
  opts: { fuzzy?: boolean } = {},
): Promise<Entity | null> {
  const needle = subject.trim()
  if (!needle) return null
  const fuzzy = opts.fuzzy ?? true

  const attempts = [
    // 1. Exact canonical name.
    sql`lower(${entities.canonicalName}) = lower(${needle})`,
    // 2. Exact alias. Case-insensitive over the array, so "Yeşim" matching an
    //    alias stored with different casing still lands.
    sql`exists (select 1 from unnest(${entities.aliases}) a where lower(a) = lower(${needle}))`,
    // 3. An email handle. Only tried when the needle actually looks like one:
    //    an address is a real-world identifier for a person that is almost
    //    never their canonical name, but very often appears verbatim in a
    //    "Has email address …" observation. This is what lets the brief hand a
    //    raw calendar attendee straight to `assembleContext`.
    needle.includes('@')
      ? sql`exists (
          select 1 from observations o
          where o.entity_id = ${entities.id}
            and o.invalidated_at is null
            and o.statement ILIKE ${'%' + needle + '%'}
        )`
      : null,
    // 4. Substring, either direction — "Dave" for "Dave Chen", "Dave Chen
    //    (Acme)" for "Dave Chen". Last resort precisely because it is the
    //    one that can pick the wrong Dave.
    fuzzy
      ? sql`(${entities.canonicalName} ILIKE ${'%' + needle + '%'}
             or ${needle} ILIKE '%' || ${entities.canonicalName} || '%')`
      : null,
  ]

  for (const attempt of attempts) {
    if (!attempt) continue
    const [row] = await db
      .select()
      .from(entities)
      .where(attempt)
      .orderBy(desc(substantiation), sql`char_length(${entities.canonicalName})`, asc(entities.id))
      .limit(1)
    if (row) return followMerges(row)
  }
  return null
}

// ── The bundle ───────────────────────────────────────────────────────────────

export interface RankedFact {
  id: string
  statement: string
  category: ObservationCategory
  confidence: number
  score: number
  /** Ingested episodes behind it. Empty for a fact a session wrote directly. */
  sourceEpisodeIds: string[]
  since: Date
  /** Null when the fact is the subject's own; otherwise the neighbour it came from. */
  via: { name: string; relation: string } | null
}

export interface RelatedEntity {
  id: string
  name: string
  relation: string
  /** 'out' = subject → other; 'in' = other → subject. Direction changes meaning. */
  direction: 'out' | 'in'
  /** The neighbour's one-line summary, when it has one: who they are, without their facts. */
  summary?: string
}

export interface ContextBundle {
  subject: {
    id: string
    name: string
    type: string
    summary: string | null
    aliases: string[]
    /** Set when resolution could not place this confidently — say so, don't hide it. */
    provisional: string | null
  }
  facts: RankedFact[]
  /** Held apart from `facts` rather than merely ranked below them — see below. */
  anticipations: RankedFact[]
  related: RelatedEntity[]
  /** Live facts considered and cut. Surfaced so a thin bundle isn't mistaken for a thin graph. */
  omitted: number
  /** More live candidates exist beyond the bounded retrieval window. */
  candidateTruncated?: boolean
  /** Set when the read was narrowed to facts matching these words. */
  topic?: string
}

function toRanked(
  o: Observation,
  hops: number,
  via: { name: string; relation: string } | null,
): RankedFact {
  return {
    id: o.id,
    statement: o.statement,
    category: o.category,
    confidence: o.confidence,
    score: scoreObservation(o, hops),
    sourceEpisodeIds: o.sourceEpisodeIds,
    since: o.validFrom,
    via,
  }
}

export interface AssembleOptions {
  /** Maximum established facts; anticipations get a smaller slice. */
  limit?: number
  /**
   * 0 skips the neighbour ring entirely. The brief uses it: for "who am I
   * meeting" the headline fact about the person is the answer, and their
   * neighbours' facts are pure cost.
   */
  hops?: 0 | 1
  /** See `resolveSubject` — false stops before the substring pass. */
  fuzzy?: boolean
  /**
   * Restrict the read to facts matching these words. A large entity holds far
   * more than one briefing can carry, and without this the only way to reach
   * "what do we know about X on this project" was paging `what_do_you_know`.
   */
  topic?: string
}

/**
 * Narrow a read to one topic. Same two passes as `searchFacts`, folded into one
 * predicate: full-text for stemming, and an every-term substring match for the
 * identifiers the tokenizer splits (`Commercial_Path__c`, an issue number).
 */
function topicFilter(topic: string) {
  const terms = topic.split(/\s+/).filter(Boolean)
  const tsv = sql`to_tsvector('english', ${observations.statement})`
  const tsquery = sql`plainto_tsquery('english', ${topic})`
  return {
    match: or(
      sql`${tsv} @@ ${tsquery}`,
      and(...terms.map((t) => sql`${observations.statement} ILIKE ${'%' + t + '%'}`)),
    ),
    rank: sql<number>`ts_rank_cd(${tsv}, ${tsquery})`,
  }
}

/**
 * The names a neighbour's fact would use for the subject: canonical name,
 * aliases, and a person's first name. Type-agnostic on purpose, so a new entity
 * type is covered the day it is added; a project that goes by a shorter name
 * gets it as an alias, which is what aliases are for.
 */
export function subjectNames(e: Pick<Entity, 'canonicalName' | 'aliases' | 'type'>): string[] {
  const names = [e.canonicalName, ...e.aliases]
  if (e.type === 'person') {
    const first = e.canonicalName.trim().split(/\s+/)[0] ?? ''
    if (first.length >= MIN_FIRST_NAME) names.push(first)
  }
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))]
}

/**
 * Whole-word, case-insensitive "names one of these" over the statement, as a
 * Postgres regex so the neighbour ring is filtered before it is fetched, not
 * after. `\m`/`\M` are word boundaries, so "Atlas" does not match
 * "Atlassian". Each is applied only where the name starts or ends with a word
 * character: a boundary next to the "+" of "C++" could never match.
 */
export function mentionPattern(names: string[]): string {
  return names.map((n) => {
    const body = n.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    return (/^\w/.test(n) ? '\\m' : '') + body + (/\w$/.test(n) ? '\\M' : '')
  }).join('|')
}

function mentionsAny(names: string[]) {
  return sql`${observations.statement} ~* ${mentionPattern(names)}`
}

async function observationCandidates(
  entityIds: string[],
  topic?: string,
  mustMention?: string[],
): Promise<{ rows: Observation[]; truncated: boolean }> {
  const filter = topic ? topicFilter(topic) : null
  const rows = await db
    .select()
    .from(observations)
    .where(and(inArray(observations.entityId, entityIds), live, filter?.match,
      mustMention?.length ? mentionsAny(mustMention) : undefined))
    // The ceiling has to cut the least useful rows. Nearly every session-written
    // fact carries the same confidence, so confidence alone left the cut to the
    // id tie-break: on an entity past the ceiling, an arbitrary 250 by UUID
    // (measured on production, 1,582 facts on one entity, 2026-11-21). Recency decides instead, and
    // with a topic the best lexical matches go first.
    .orderBy(...(filter ? [desc(filter.rank)] : [desc(observations.confidence)]),
      desc(observations.validFrom), asc(observations.id))
    // The extra row distinguishes a full result from a capped one.
    .limit(MAX_CANDIDATE_FACTS + 1)
  return { rows: rows.slice(0, MAX_CANDIDATE_FACTS), truncated: rows.length > MAX_CANDIDATE_FACTS }
}

/**
 * The main read. Resolve → traverse one hop → rank → cut.
 *
 * Returns null rather than an empty bundle when the subject is unknown: "I have
 * never heard of them" and "I know them but have nothing to say" are different
 * answers, and collapsing them makes the graph look emptier than it is.
 */
export async function assembleContext(
  subject: string,
  opts: AssembleOptions = {},
): Promise<ContextBundle | null> {
  const limit = opts.limit ?? DEFAULT_FACT_LIMIT
  const hops = opts.hops ?? 1
  const topic = opts.topic?.trim() || undefined

  const entity = await resolveSubject(subject, { fuzzy: opts.fuzzy })
  if (!entity) return null

  // The subject's facts and its two link directions do not depend on each
  // other, so they are read together rather than as three round trips.
  // One hop, both directions: a link is a relationship whichever way it was
  // recorded, and dropping the inbound half means "manages" is visible from the
  // manager but not the report.
  const linked = (near: AnyPgColumn, far: AnyPgColumn) =>
    db
      .select({ id: entities.id, name: entities.canonicalName, relation: links.relation, summary: entities.summary })
      .from(links)
      .innerJoin(entities, eq(far, entities.id))
      .where(and(eq(near, entity.id), isNull(links.invalidatedAt), isNull(entities.mergedInto)))
      .orderBy(desc(links.confidence), asc(links.id))
      .limit(MAX_NEIGHBOURS)
  const [ownCandidates, outbound, inbound] = await Promise.all([
    observationCandidates([entity.id], topic),
    hops > 0 ? linked(links.fromEntity, links.toEntity) : [],
    hops > 0 ? linked(links.toEntity, links.fromEntity) : [],
  ])

  const related: RelatedEntity[] = []
  if (hops > 0) {
    const seen = new Set<string>([entity.id])
    for (const r of [
      ...outbound.map((r) => ({ ...r, direction: 'out' as const })),
      ...inbound.map((r) => ({ ...r, direction: 'in' as const })),
    ]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      const { summary, ...rest } = r
      related.push(summary ? { ...rest, summary } : rest)
      if (related.length >= MAX_NEIGHBOURS) break
    }
  }

  // With a topic, the caller has said what is relevant and the topic filter is
  // the gate. Without one, a neighbour's fact has to name the subject.
  const neighbourCandidates = related.length
    ? await observationCandidates(related.map(r => r.id), topic, topic ? undefined : subjectNames(entity))
    : { rows: [], truncated: false }

  const byEntity = new Map(related.map((r) => [r.id, r]))
  const ranked = [
    ...ownCandidates.rows.map((o) => toRanked(o, 0, null)),
    ...neighbourCandidates.rows.map((o) => {
      const n = byEntity.get(o.entityId)
      return toRanked(o, 1, n ? { name: n.name, relation: n.relation } : null)
    }),
    // Newest first among equal scores. Durable attributes never decay, so a
    // large entity's attributes all tie, and an id tie-break returned them in
    // an order that meant nothing.
  ].sort((a, b) => b.score - a.score || b.since.getTime() - a.since.getTime() || a.id.localeCompare(b.id))

  // Anticipations need structural separation, not just a lower score: an
  // inference must never be read with the authority of something observed.
  const facts: RankedFact[] = []
  const anticipations: RankedFact[] = []
  let omitted = 0
  for (const f of ranked) {
    const bucket = f.category === 'anticipation' ? anticipations : facts
    const room = bucket === anticipations ? Math.max(2, Math.floor(limit / 4)) : limit
    if (f.score < RELEVANCE_FLOOR || bucket.length >= room) {
      omitted++
      continue
    }
    bucket.push(f)
  }

  return {
    subject: {
      id: entity.id,
      name: entity.canonicalName,
      type: entity.type,
      summary: entity.summary,
      aliases: entity.aliases,
      provisional: entity.provisional,
    },
    facts,
    anticipations,
    related,
    omitted,
    candidateTruncated: ownCandidates.truncated || neighbourCandidates.truncated,
    ...(topic ? { topic } : {}),
  }
}

/** The id every fact carries, plus its source episodes when it has any. */
function factRef(f: RankedFact): string {
  return `id ${f.id}${f.sourceEpisodeIds?.length ? `, source episodes ${f.sourceEpisodeIds.join(' ')}` : ''}`
}

/**
 * The bundle's text projection.
 *
 * Lives here, next to the shape it renders, so the `mcp` module stays what it
 * is meant to be — auth, validation, delegation — and so a change to the bundle
 * cannot leave a formatter elsewhere silently dropping a field.
 */
export function formatBundle(b: ContextBundle): string {
  const out: string[] = [`# ${b.subject.name} (${b.subject.type})`]
  if (b.subject.summary) out.push(b.subject.summary)
  if (b.subject.provisional) {
    out.push(`_Identity unconfirmed: ${b.subject.provisional}_`)
  }
  if (b.topic) out.push(`_Filtered to topic "${b.topic}"._`)

  out.push('', b.facts.length ? '## Known' : b.topic
    ? `## Known\nNo stored fact about ${b.subject.name} matches topic "${b.topic}". Call again without a topic for the general briefing, or use search.`
    : b.candidateTruncated
      ? '## Known\n(No established facts selected; candidate retrieval is capped, more may exist.)'
      : '## Known\n(no established facts selected)')
  for (const f of b.facts) {
    const via = f.via ? ` (via ${f.via.name})` : ''
    out.push(`- ${f.statement}${via}  [${f.category}, ${f.confidence.toFixed(2)}, ${factRef(f)}]`)
  }

  if (b.anticipations.length) {
    // Labelled as inference in the heading AND on every line: a section header
    // scrolls out of view, the per-line marker does not.
    out.push('', '## Worth a look (inferred, not observed)')
    for (const a of b.anticipations) {
      out.push(`- ${a.statement}  _(inferred, ${a.confidence.toFixed(2)}, ${factRef(a)})_`)
    }
  }

  if (b.related.length) {
    out.push('', '## Related')
    for (const r of b.related) {
      // Inbound links are spelled out in full rather than mirrored. "manages"
      // read backwards is a different claim about a real person, and there is
      // no arrow convention a reader reliably gets right.
      const who = r.summary ? ` — ${r.summary}` : ''
      out.push(
        r.direction === 'out'
          ? `- ${r.relation} → ${r.name}${who}`
          : `- ${r.name} → ${r.relation} → ${b.subject.name}${who}`,
      )
    }
  }

  if (b.omitted) {
    // Say what was left out, or a deliberately small bundle reads as an empty
    // graph and the next move is to distrust the whole system.
    out.push('', `_${b.omitted} lower-signal fact(s) not shown — ask for more if needed._`)
  }
  if (b.candidateTruncated) {
    out.push('', '_Candidate retrieval was capped; additional live observations may exist. The omitted count covers only retrieved candidates._')
  }
  return out.join('\n')
}

/**
 * The single headline fact about someone, for inline use in a brief.
 *
 * Exact resolution only. A briefing line has no room to show its reasoning, so
 * a substring match printing "Sam" 's facts next to a meeting with Samantha is
 * indistinguishable from the truth to whoever reads it — and unlike a
 * `get_context` call, nobody asked for this lookup and nobody will check it.
 */
export async function headlineFact(subject: string): Promise<string | null> {
  const b = await assembleContext(subject, { limit: 1, hops: 0, fuzzy: false })
  if (!b) return null
  const top = b.facts[0] ?? b.anticipations[0]
  return `${b.subject.name}${top ? ` — ${top.statement}` : ''}`
}

// ── Episode search ───────────────────────────────────────────────────────────

export interface EpisodeHit {
  id: string
  source: string
  sourceRef?: string
  contentHash?: string
  kind: string
  occurredAt: Date
  snippet: string
  /** How it matched. Worth showing: a substring-only hit is a weaker result. */
  matchedBy: 'full-text' | 'substring'
}

/**
 * Full-text over the raw episode body, computed at query time.
 *
 * The schema declares a `tsv` column, but nothing populates it yet — no
 * trigger, no generated column, and neither ingest nor the deriver writes it.
 * Reading that column would therefore match nothing at all, silently. Computing
 * `to_tsvector` per row is a sequential scan, which is entirely fine at
 * personal scale (hundreds of episodes); when the column is eventually filled
 * by a migration, swap this expression for it and the query plan improves
 * without the results changing.
 */
const bodyTsv = sql`to_tsvector('english', ${episodes.body}::text)`

/** Window of characters shown around a match. */
const SNIPPET_RADIUS = 110

function snippet(body: unknown, terms: string[]): string {
  const text = JSON.stringify(body)
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  // No term located (a stemmed full-text match — "meetings" matching "meeting")
  // still deserves a result, so fall back to the head of the record.
  if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2)
  const from = Math.max(0, at - SNIPPET_RADIUS)
  return (from > 0 ? '…' : '') + text.slice(from, at + SNIPPET_RADIUS) + '…'
}

/**
 * Search the raw material, for when the graph does not have the answer.
 *
 * Two passes, because neither alone is honest. Full-text gets stemming, stop
 * words and relevance ranking — but `plainto_tsquery` will not match a partial
 * word or an identifier that the tokenizer chopped up (an email address, an
 * order number, "gcal"), and those are exactly the things you search a personal
 * archive for. So a substring pass runs when full-text comes up short, and
 * results say which pass found them.
 */
export async function searchEpisodes(query: string, limit: number): Promise<EpisodeHit[]> {
  const q = query.trim()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)

  const tsquery = sql`plainto_tsquery('english', ${q})`
  const rank = sql<number>`ts_rank_cd(${bodyTsv}, ${tsquery})`

  const fts = await db
    .select({
      id: episodes.id,
      source: episodes.source,
      sourceRef: episodes.sourceRef,
      contentHash: episodes.dedupHash,
      kind: episodes.kind,
      occurredAt: episodes.occurredAt,
      body: episodes.body,
      rank,
    })
    .from(episodes)
    .where(sql`${bodyTsv} @@ ${tsquery}`)
    // Recency breaks rank ties: among equally-relevant calendar records, the
    // one you mean is almost always the recent one.
    .orderBy(desc(rank), desc(episodes.occurredAt), asc(episodes.id))
    .limit(limit)

  const hits: EpisodeHit[] = fts.map((r) => ({
    id: r.id,
    source: r.source,
    sourceRef: r.sourceRef,
    contentHash: r.contentHash,
    kind: r.kind,
    occurredAt: r.occurredAt,
    snippet: snippet(r.body, terms),
    matchedBy: 'full-text',
  }))
  if (hits.length >= limit) return hits

  // Fallback: every term must appear somewhere in the record. ANDing the terms
  // matters — a single OR'd substring over a whole-life archive returns the
  // whole archive, which is not a search result.
  const seen = new Set(hits.map((h) => h.id))
  const substring = await db
    .select({
      id: episodes.id,
      source: episodes.source,
      sourceRef: episodes.sourceRef,
      contentHash: episodes.dedupHash,
      kind: episodes.kind,
      occurredAt: episodes.occurredAt,
      body: episodes.body,
    })
    .from(episodes)
    .where(
      and(
        ...terms.map((t) => sql`${episodes.body}::text ILIKE ${'%' + t + '%'}`),
      ),
    )
    // No lexical score exists for a substring match, so recency is the only
    // ordering that isn't invented.
    .orderBy(desc(episodes.occurredAt), asc(episodes.id))
    .limit(limit)

  for (const r of substring) {
    if (seen.has(r.id) || hits.length >= limit) continue
    hits.push({
      id: r.id,
      source: r.source,
      sourceRef: r.sourceRef,
      contentHash: r.contentHash,
      kind: r.kind,
      occurredAt: r.occurredAt,
      snippet: snippet(r.body, terms),
      matchedBy: 'substring',
    })
  }
  return hits
}

// ── Fact search ──────────────────────────────────────────────────────────────

export interface FactHit {
  id: string
  entityId: string
  entityName: string
  statement: string
  category: ObservationCategory
  confidence: number
  createdAt: Date
  matchedBy: 'full-text' | 'substring'
}

/**
 * Search the stored beliefs themselves, across every entity.
 *
 * Without this, a session that wants to know "is this already remembered?"
 * has to guess which entity holds it and page `what_do_you_know` 200 rows at a
 * time, and duplicates slip in whenever the guess is wrong. Live facts only:
 * an invalidated or expired row is history, not an answer. Same two passes as
 * `searchEpisodes`, for the same reason: full-text cannot match an identifier
 * the tokenizer splits (`Commercial_Path__c`, an issue number).
 */
export async function searchFacts(query: string, limit: number, offset = 0): Promise<FactHit[]> {
  const q = query.trim()
  if (!q) return []
  // Paging reads the first `offset + limit` hits and drops the head. The two
  // passes are merged in a fixed order, so a page boundary cannot fall between
  // them inconsistently; at this size re-reading the head is cheaper than
  // teaching each pass its own offset.
  if (offset > 0) return (await searchFacts(q, offset + limit)).slice(offset)
  const terms = q.split(/\s+/).filter(Boolean)
  const live = and(
    isNull(observations.invalidatedAt),
    or(isNull(observations.validTo), gte(observations.validTo, sql`now()`)),
  )
  const cols = {
    id: observations.id,
    entityId: observations.entityId,
    entityName: entities.canonicalName,
    statement: observations.statement,
    category: observations.category,
    confidence: observations.confidence,
    createdAt: observations.createdAt,
  }
  const tsv = sql`to_tsvector('english', ${observations.statement})`
  const tsquery = sql`plainto_tsquery('english', ${q})`
  const rank = sql<number>`ts_rank_cd(${tsv}, ${tsquery})`

  const fts = await db
    .select(cols)
    .from(observations)
    .innerJoin(entities, eq(entities.id, observations.entityId))
    .where(and(live, sql`${tsv} @@ ${tsquery}`))
    .orderBy(desc(rank), desc(observations.createdAt), asc(observations.id))
    .limit(limit)
  const hits: FactHit[] = fts.map((r) => ({ ...r, matchedBy: 'full-text' as const }))
  if (hits.length >= limit) return hits

  const seen = new Set(hits.map((h) => h.id))
  const substring = await db
    .select(cols)
    .from(observations)
    .innerJoin(entities, eq(entities.id, observations.entityId))
    .where(and(live, ...terms.map((t) => sql`${observations.statement} ILIKE ${'%' + t + '%'}`)))
    .orderBy(desc(observations.createdAt), asc(observations.id))
    .limit(limit)
  for (const r of substring) {
    if (seen.has(r.id) || hits.length >= limit) continue
    hits.push({ ...r, matchedBy: 'substring' })
  }
  return hits
}

// ── Similar facts ────────────────────────────────────────────────────────────

/** Below this, two statements merely share a topic. */
const SIMILAR_FLOOR = 0.35

/**
 * Facts anywhere in the store that say nearly what `statement` says.
 *
 * `remember` only compares a new fact with the same entity's facts, so the
 * same thing written under two entities was never noticed: the writer had to
 * think to `search` first, and mostly did not. This runs after the write and
 * hands back the likely twins, on any entity, for the writer to judge.
 *
 * Candidates come from the full-text index (any shared content word), and the
 * shortlist is scored with the same similarity `remember` uses, so "similar"
 * means one thing in both places.
 */
export async function similarFacts(statement: string, excludeId: string, limit = 3): Promise<(FactHit & { score: number })[]> {
  const words = [...tokens(statement)].slice(0, 16)
  if (!words.length) return []
  const tsv = sql`to_tsvector('english', ${observations.statement})`
  const tsquery = sql`to_tsquery('english', ${words.join(' | ')})`
  const rows = await db
    .select({
      id: observations.id,
      entityId: observations.entityId,
      entityName: entities.canonicalName,
      statement: observations.statement,
      category: observations.category,
      confidence: observations.confidence,
      createdAt: observations.createdAt,
    })
    .from(observations)
    .innerJoin(entities, eq(entities.id, observations.entityId))
    .where(and(live, sql`${tsv} @@ ${tsquery}`, sql`${observations.id} <> ${excludeId}`))
    .orderBy(desc(sql`ts_rank_cd(${tsv}, ${tsquery})`), asc(observations.id))
    .limit(12)
  return rows
    .map((r) => ({ ...r, matchedBy: 'full-text' as const, score: similarity(r.statement, statement) }))
    .filter((r) => r.score >= SIMILAR_FLOOR)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
}

// ── Calendar freshness ───────────────────────────────────────────────────────

/**
 * The calendar connector runs every 15 minutes, so an hour without a successful
 * sync is four missed ticks — past a slow run or a restart, into "something is
 * wrong".
 */
const CALENDAR_STALE_AFTER_MS = 60 * 60_000

const CALENDAR_SOURCES = ['gcal_work', 'gcal_personal'] as const

function ago(from: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000))
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)} days ago`
}

/**
 * Why an empty calendar window is empty, so absent-by-design and broken stop
 * reading the same. `sync_state` already records both halves: `last_synced_at`
 * advances only on success, and `last_error` is set on failure and cleared by
 * the next success.
 *
 * Returns a sentence to append to "Nothing on the calendar". The healthy case
 * still says when the calendar last synced — that is the evidence the window is
 * genuinely clear rather than an assurance that it is.
 */
export async function calendarFreshnessNote(now = new Date()): Promise<string> {
  const rows = await db
    .select()
    .from(syncState)
    .where(inArray(syncState.source, [...CALENDAR_SOURCES]))
  return describeCalendarFreshness(rows, now)
}

/** The pure half of `calendarFreshnessNote`, over already-loaded rows. */
export function describeCalendarFreshness(
  rows: Pick<SyncState, 'lastSyncedAt' | 'lastRunAt' | 'lastError'>[],
  now: Date,
): string {
  const synced = rows.filter((r) => r.lastSyncedAt)
  if (!synced.length) {
    return 'Calendar ingestion has never completed a sync, so this is not a real answer yet.'
  }

  const failed = rows.find((r) => r.lastError)
  // The oldest successful sync bounds how current the whole view is.
  const oldest = synced
    .map((r) => r.lastSyncedAt!)
    .reduce((a, b) => (a < b ? a : b))

  if (failed) {
    const when = failed.lastRunAt ? ` ${ago(failed.lastRunAt, now)}` : ''
    return (
      `But the last calendar sync failed${when} (${failed.lastError!.slice(0, 120)}), ` +
      `and the last good one was ${ago(oldest, now)} — the calendar may not be current.`
    )
  }
  if (now.getTime() - oldest.getTime() > CALENDAR_STALE_AFTER_MS) {
    return `But the calendar last synced ${ago(oldest, now)}, so this may be out of date.`
  }
  return `The calendar last synced ${ago(oldest, now)}, so that is current.`
}
