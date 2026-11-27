/**
 * The MCP tool surface (README lists every tool).
 *
 * These are deliberately thin — auth, validation, delegation. Anything that
 * decides WHAT to return lives in `retrieval`; a tool that starts ranking is a
 * tool whose behaviour can no longer be changed without touching the wire
 * surface.
 */
import { oauthToolMeta, writeDenied } from './scopes.ts'
import { intArg } from './args.ts'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../store/index.ts'
import { ENTITY_TYPES, entities, episodes, links, observations } from '../store/schema.ts'
import { mergeEntities } from '../store/merge.ts'
import { moveFacts } from '../store/move.ts'
import {
  assembleContext,
  calendarFreshnessNote,
  formatBundle,
  headline,
  live,
  resolveSubject,
  searchEpisodes,
  searchFacts,
  similarFacts,
  type ContextBundle,
  type RankedFact,
} from '../retrieval/index.ts'
import {
  notePreference,
  selfEntity,
  workingStyle,
  SELF_NAME,
  type PreferenceResult,
} from '../store/preferences.ts'
import { rememberFact } from '../store/remember.ts'
import { registerHowIWorkTool } from './how-i-work.ts'
import { isOwnerEmail } from '../owner.ts'
import { formatWhen, type EventStart } from '../when.ts'
import { retireEntity } from '../store/retire.ts'

const calendarCoverage = 'Coverage: the calendars Grimalkin ingests itself. This is not a complete calendar check.'

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

/**
 * Longest statement `search` prints in full. A search is for finding the row,
 * and one session digest printed whole (1,000+ characters) used to outweigh
 * the rest of the page; the id is there to read the full text.
 */
const SEARCH_STATEMENT_MAX = 240
const clip = (s: string) =>
  s.length <= SEARCH_STATEMENT_MAX ? s : `${s.slice(0, SEARCH_STATEMENT_MAX)}… (+${s.length - SEARCH_STATEMENT_MAX} chars)`

/** Drop keys that say nothing: null, undefined and empty arrays. */
function dropEmpty<T extends Record<string, unknown>>(row: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>
}

/**
 * The structured copy of a fact: only what it has. A fact a session wrote
 * directly has no source episodes, and serialising that emptiness (with a
 * ranking score the array order already conveys) was about half of every
 * briefing.
 */
function slimFact(f: RankedFact) {
  const { score: _score, ...rest } = f
  return dropEmpty(rest)
}

function slimBundle(b: ContextBundle) {
  return {
    ...b,
    subject: dropEmpty(b.subject),
    facts: b.facts.map(slimFact),
    anticipations: b.anticipations.map(slimFact),
  }
}

/** Long enough to be unambiguous across a few hundred rows, short enough to scan. */
const shortId = (id: string) => id.slice(0, 8)

/** One wire format for a preference write, shared by note_preference and remember. */
function describePreference(r: PreferenceResult): string {
  switch (r.action) {
    case 'reinforced':
      return (
        `Reinforced ${shortId(r.id)}: "${r.statement}"\n` +
        `Now ${r.confidence.toFixed(2)} confidence, seen ${r.observations}×` +
        (r.matchedBy === 'wording' ? ` (matched your wording at similarity ${r.score.toFixed(2)}).` : '.')
      )
    case 'recorded': {
      const lines = [
        `Recorded ${shortId(r.id)}: "${r.statement}"`,
        `Starting at ${r.confidence.toFixed(2)}, seen 1×. observation_id: ${r.id}`,
      ]
      if (r.nearest.length) {
        lines.push(
          `Closest existing preferences. If this restates one of them, forget ${r.id} ` +
            `and call note_preference again with reinforces set to that id:`,
          ...r.nearest.map((n) => `  - ${shortId(n.id)} (${n.score.toFixed(2)}) "${n.statement}"`),
        )
      }
      return lines.join('\n')
    }
    case 'not_found':
      return `No live preference matches reinforces="${r.reinforces}". Nothing was recorded. Take the id from how_i_work.`
    case 'ambiguous':
      return `reinforces="${r.reinforces}" matches ${r.candidates} preferences. Nothing was recorded. Pass more characters of the id.`
  }
}

/** Most inferences a brief lists, and how many of those may be about people outside the window. */
const BRIEF_ANTICIPATIONS = 10
const BRIEF_UNRELATED_ANTICIPATIONS = 3
/** "Named but never substantiated" lists only entities this recent; older ones are counted. */
const HOLLOW_RECENT_DAYS = 7

export function registerTools(server: McpServer, scope: string, reviewer = 'authenticated-owner', writeAuthChallenge?: string) {
  // ── request_memory_write_access ────────────────────────────────────────────
  // The one way a read-only connection asks for write scope: the denial carries
  // the OAuth challenge, and the client runs the consent flow from it.
  server.registerTool('request_memory_write_access', {
    title: 'Request Grimalkin memory write permission',
    description: 'Call only when the owner explicitly asks to enable Grimalkin memory write access. Requests an OAuth read/write consent flow if this connection lacks context:write, or verifies the current grant. The owner must approve the OAuth consent screen. Does not create or upgrade tokens itself, access the database, or change memory.',
    inputSchema: {},
    outputSchema: { reporter: z.string(), grantedScopes: z.array(z.string()), writeScopeGranted: z.literal(true) },
    _meta: oauthToolMeta('write'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const denied = writeDenied(scope, writeAuthChallenge)
    if (denied) return denied
    const value = { reporter: reviewer, grantedScopes: scope.split(/\s+/).filter(Boolean), writeScopeGranted: true as const }
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value }
  })

  // ── get_context ────────────────────────────────────────────────────────────
  server.registerTool(
    'get_context',
    {
      title: 'Get context',
      description:
        'The briefing on a person, project, org or place: who or what this is, what is known, and what is open.',
      inputSchema: {
        subject: z.string().describe('Name of the person, project, org or place'),
        limit: intArg(1, 60)
          .optional()
          .describe('Maximum per separate established-fact and source-report bucket. Leave unset unless the default reads too thin.'),
        topic: z
          .string()
          .optional()
          .describe('Words to narrow the briefing to, e.g. "renewal forecast". Use on a large entity, where the default shows only its most recent facts.'),
      },
      _meta: oauthToolMeta('read'),
      annotations: { readOnlyHint: true },
    },
    async ({ subject, limit, topic }) => {
      const bundle = await assembleContext(subject, { limit, topic })
      if (!bundle) return text(`No entity named "${subject}" is known yet.`)
      return { ...text(formatBundle(bundle)), structuredContent: JSON.parse(JSON.stringify(slimBundle(bundle))) }
    },
  )

  // ── upcoming ───────────────────────────────────────────────────────────────
  server.registerTool(
    'upcoming',
    {
      title: 'Upcoming',
      description:
        'Calendar view of the next N hours, from the calendars Grimalkin ingests itself.',
      inputSchema: {
        hours: intArg(1, 24 * 14).default(24),
      },
      _meta: oauthToolMeta('read'),
      annotations: { readOnlyHint: true },
    },
    async ({ hours }) => {
      const until = new Date(Date.now() + hours * 3600_000)
      const rows = await db
        .select()
        .from(episodes)
        .where(
          and(
            or(
              eq(episodes.source, 'gcal_work'),
              eq(episodes.source, 'gcal_personal'),
            ),
            gte(episodes.occurredAt, new Date()),
            lte(episodes.occurredAt, until),
          ),
        )
        .orderBy(episodes.occurredAt)
        .limit(50)

      if (!rows.length) {
        return text(
          `No native-ingested calendar entries found in the next ${hours}h. ${await calendarFreshnessNote()} ${calendarCoverage}`,
        )
      }
      return text(
        `${calendarCoverage}\n` + rows
          .map((r) => {
            const b = r.body as { summary?: string; start?: EventStart }
            return `- ${formatWhen(r.occurredAt, b.start)} — ${b.summary ?? r.kind}`
          })
          .join('\n'),
      )
    },
  )

  // ── remember ───────────────────────────────────────────────────────────────
  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        'Record one atomic fact. If the statement needs the word "and", call this twice instead. ' +
        'Record only what a later session could not find elsewhere: a decision and its reason, a fact about a person, account or system, ' +
        'a trap that cost time. Do NOT record what the repo, git history or the issue tracker already holds (what a PR changed, an issue\'s status, code structure). ' +
        'The reply lists similar facts already stored on any entity; if the new one repeats one of them, forget the new id. ' +
        'To CORRECT something already believed, pass the stale observation ids in `supersedes` — ' +
        'writing a contradicting fact on its own does NOT retire the old one, it just adds a rival. ' +
        'Get ids from search or what_do_you_know.',
      inputSchema: {
        statement: z.string().describe('A single atomic fact'),
        entity_type: z.enum(['person', 'org', 'project', 'place', 'commitment', 'account']).optional()
          .describe('Type for a new entity; omitted types are unknown. Existing entities keep their type.'),
        about: z.string().describe('The entity this is about'),
        category: z
          .enum(['state', 'attribute', 'event', 'preference'])
          .default('attribute')
          .describe(
            'state = supersedable current fact; attribute = durable trait; event = happened once; preference = revisable liking',
          ),
        supersedes: z
          .array(z.string().uuid())
          .optional()
          .describe(
            'observation_ids this fact replaces. They are invalidated and stamped with this ' +
              'observation as the reason. Use when the new fact CONTRADICTS them - a correction ' +
              'usually shares no wording with what it corrects, so nothing detects it for you.',
          ),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false },
    },
    async ({ statement, about, category, supersedes, entity_type }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      // Exact-match only. A substring hit would quietly file "prefers mornings"
      // about the wrong Dave, and nothing downstream would ever flag it; a
      // duplicate entity is the cheaper mistake and consolidation cleans it up.
      let entity = await resolveSubject(about, { fuzzy: false })
      if (!entity) {
        const created = await db
          .insert(entities)
          .values({ type: entity_type ?? 'unknown', canonicalName: about })
          .returning()
        entity = created[0]!
      }

      // A preference about the owner is a working preference, and those have one
      // write path: note_preference, which reinforces instead of duplicating.
      // Writing them here used to skip that check entirely and stamp 0.95 at
      // birth, so a one-off project decision outranked every preference that
      // repetition had actually earned (five of the top five on 2026-09-10).
      const self = await selfEntity()
      if (category === 'preference' && entity.id === self.id) {
        const r = await notePreference({ statement, supersedes, expectedEntityId: entity.id })
        const lines = [
          'Routed to note_preference: preferences about the owner reinforce rather than duplicate.',
          describePreference(r),
        ]
        if (r.retired?.length) lines.push(`Superseded ${r.retired.length} belief(s):`,
          ...r.retired.map(o => `  - "${o.statement}" (${o.category}, id=${o.id})`))
        return text(lines.join('\n'))
      }

      const { created, retired } = await rememberFact({ entityId: entity.id, statement, category, supersedes })
      const lines = [
        `Recorded about ${entity.canonicalName}: "${statement}" [${category}]`,
        `observation_id: ${created.id}`,
      ]
      if (retired.length) lines.push(`Superseded ${retired.length} belief(s):`,
        ...retired.map(o => `  - "${o.statement}" (${o.category}, id=${o.id})`))
      // The write has landed; a failed lookup must not turn it into an error.
      const twins = await similarFacts(statement, created.id).catch(() => [])
      if (twins.length) lines.push(
        `Similar facts already stored. If this repeats one, forget ${created.id}; if it corrects one, forget that one:`,
        ...twins.map(t => `  - [${t.entityName}] ${clip(t.statement)} (id=${t.id}, similarity ${t.score.toFixed(2)})`))
      return text(lines.join('\n'))
    },
  )

  // ── what_do_you_know ───────────────────────────────────────────────────────
  server.registerTool(
    'what_do_you_know',
    {
      title: 'What do you know',
      description:
        'Inspect stored beliefs about an entity, with confidence and provenance. Use this to audit ' +
        'or correct the memory. Paginate with `offset` and re-sort with `order` — the oldest beliefs ' +
        'are usually the stale ones, and `order: "oldest"` reaches them directly.',
      inputSchema: {
        about: z.string(),
        limit: intArg(1, 200).default(100),
        offset: intArg(0).default(0),
        order: z
          .enum(['recent', 'oldest', 'confidence'])
          .default('recent')
          .describe('recent = newest first (default); oldest = first recorded, where stale beliefs live'),
        category: z
          .enum(['state', 'attribute', 'event', 'preference', 'anticipation'])
          .optional()
          .describe('Restrict to one category. `attribute` is where durable-but-wrong beliefs hide.'),
      },
      _meta: oauthToolMeta('read'),
      annotations: { readOnlyHint: true },
    },
    async ({ about, limit, offset, order, category }) => {
      const entity = await resolveSubject(about)
      if (!entity) return text(`Nothing known about "${about}".`)

      const where = and(
        eq(observations.entityId, entity.id),
        live,
        category ? eq(observations.category, category) : undefined,
      )

      // Total first, so a caller can tell "that is everything" from "there are
      // four hundred more". Without it this tool silently truncated at 100 and
      // an audit could not even discover what it was not being shown.
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(observations)
        .where(where)

      const orderBy =
        order === 'oldest'
          ? observations.createdAt
          : order === 'confidence'
            ? desc(observations.confidence)
            : desc(observations.createdAt)

      const rows = await db
        .select()
        .from(observations)
        .where(where)
        .orderBy(orderBy, observations.id)
        .limit(limit)
        .offset(offset)

      if (!rows.length) {
        return text(
          total
            ? `"${entity.canonicalName}" has ${total} live belief(s) but none at offset ${offset}.`
            // The id is the one thing an empty entity can be acted on by
            // (retire_entity, merge_entities), so it must be shown here.
            : `"${entity.canonicalName}" exists but has no live beliefs${category ? ` in category ${category}` : ''}. entity_id=${entity.id}`,
        )
      }

      const shown = offset + rows.length
      const header =
        `${entity.canonicalName}: showing ${offset + 1}-${shown} of ${total}` +
        `${category ? ` (category=${category})` : ''} ordered by ${order}.`
      const footer =
        shown < total
          ? `\n\n${total - shown} more — call again with offset=${shown}` +
            `${order === 'recent' ? `, or order="oldest" to jump to the stalest` : ''}.`
          : ''

      const rendered = header + '\n' + rows.map(r =>
        `- ${r.statement}\n    id=${r.id} category=${r.category} confidence=${r.confidence.toFixed(2)} seen=${r.observationCount}` +
        `${r.sourceEpisodeIds.length ? ` source_episode_ids=${JSON.stringify(r.sourceEpisodeIds)}` : ''} since=${r.validFrom.toISOString()}`,
      ).join('\n') + footer
      // The structured copy drops what every row repeats or leaves empty: the
      // entity id (it is on `entity`), the never-populated search columns, and
      // null or empty fields. 200 rows used to overflow the tool result limit.
      const slimRow = ({ tsv: _t, embedding: _e, entityId: _id, ...row }: (typeof rows)[number]) => dropEmpty(row)
      const { tsv: _t, embedding: _e, ...entityRow } = entity
      return { ...text(rendered), structuredContent: JSON.parse(JSON.stringify({ entity: dropEmpty(entityRow), total, offset, observations: rows.map(slimRow) })) }
    },
  )

  // ── forget ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'forget',
    {
      title: 'Forget',
      description:
        'Correct a wrong belief by invalidating one observation. Takes an observation_id from what_do_you_know.',
      inputSchema: {
        observation_id: z.string().uuid(),
        reason: z.string().optional(),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ observation_id, reason }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      // Invalidate rather than DELETE: provenance and "what did I believe on
      // date X" survive. Hard deletes are reserved for PII purges.
      const updated = await db
        .update(observations)
        .set({ invalidatedAt: new Date(), validTo: new Date() })
        .where(and(eq(observations.id, observation_id), isNull(observations.invalidatedAt)))
        .returning()

      if (!updated.length) return text('No live observation with that id.')
      return text(
        `Forgotten: "${updated[0]!.statement}"${reason ? ` (${reason})` : ''}\nThe record is retained as invalidated, so provenance is preserved.`,
      )
    },
  )

  // ── merge_entities ─────────────────────────────────────────────────────────
  server.registerTool(
    'merge_entities',
    {
      title: 'Merge duplicate entities',
      description:
        'Fix a duplicate: fold one entity (the loser) into another (the winner) when resolution split one real thing in two. ' +
        'Takes entity ids from what_do_you_know\'s `entity.id`. Observations and links move to the winner, and the loser\'s name and aliases become aliases of the winner. ' +
        'The merge is soft: the loser row is kept with merged_into set, so its identity and provenance survive. There is no unmerge tool, so check both ids first.',
      inputSchema: {
        loser_id: z.string().uuid().describe('Entity to fold away (entity.id from what_do_you_know).'),
        winner_id: z.string().uuid().describe('Entity that survives (entity.id from what_do_you_know).'),
        reason: z.string().optional(),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ loser_id, winner_id, reason }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      try {
        const result = await mergeEntities(loser_id, winner_id)
        const rows = await db.select().from(entities).where(inArray(entities.id, [loser_id, winner_id]))
        const label = (id: string) => {
          const row = rows.find(r => r.id === id)
          return `"${row?.canonicalName ?? 'unknown'}" (${id.slice(0, 8)})`
        }
        return text(
          `Merged ${label(loser_id)} into ${label(winner_id)}${reason ? ` (${reason})` : ''}.\n` +
            `Observations moved: ${result.observations}. Links moved: ${result.links}.\n` +
            `Winner aliases now: ${result.aliases.length ? result.aliases.join(', ') : '(none)'}.\n` +
            `The merge is soft: the loser keeps merged_into=${winner_id.slice(0, 8)}, so its identity and provenance are preserved.`,
        )
      } catch (err) {
        return { ...text(`Merge failed: ${err instanceof Error ? err.message : String(err)}`), isError: true }
      }
    },
  )

  // ── move_facts ─────────────────────────────────────────────────────────────
  server.registerTool(
    'move_facts',
    {
      title: 'Move facts to another entity',
      description:
        'Re-file facts written on the wrong (usually too broad) entity: moves live observations to the target entity, keeping each row\'s id, confidence, ' +
        'reinforcement count, provenance and created date. Takes observation ids (from search or what_do_you_know) and the target as an entity id, name or alias. ' +
        'Retired facts are not moved. For two entities that are one thing, use merge_entities instead.',
      inputSchema: {
        observation_ids: z.array(z.string().uuid()).min(1).max(200),
        to: z.string().min(1).describe('Target entity: its id, canonical name or an alias. Must already exist.'),
        reason: z.string().optional(),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ observation_ids, to, reason }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      try {
        const isId = z.string().uuid().safeParse(to).success
        let target: { id: string; canonicalName: string } | null = null
        if (isId) {
          const [row] = await db.select().from(entities).where(eq(entities.id, to))
          target = row ?? null
        } else {
          target = await resolveSubject(to, { fuzzy: false })
        }
        if (!target) return { ...text(`Move failed: no entity matches "${to}". Create it first with remember.`), isError: true }
        const result = await moveFacts(observation_ids, target.id)
        const lines = [`Moved ${result.moved.length} fact(s) to "${target.canonicalName}" (${target.id.slice(0, 8)})${reason ? ` (${reason})` : ''}.`]
        if (result.skipped.length) {
          lines.push(`${result.skipped.length} not moved:`)
          for (const s of result.skipped) lines.push(`- ${s.id}: ${s.reason}`)
        }
        return text(lines.join('\n'))
      } catch (err) {
        return { ...text(`Move failed: ${err instanceof Error ? err.message : String(err)}`), isError: true }
      }
    },
  )

  // ── update_entity ──────────────────────────────────────────────────────────
  server.registerTool(
    'update_entity',
    {
      title: 'Update an entity',
      description:
        'Fix an entity\'s type, canonical name, summary or aliases, for example a project typed as a person or a misnamed org. ' +
        'Takes entity_id from what_do_you_know\'s `entity.id`. Renaming keeps the old name as an alias. Merged entities cannot be edited; edit the one they were merged into.',
      inputSchema: {
        entity_id: z.string().uuid(),
        type: z.enum(ENTITY_TYPES).optional(),
        canonical_name: z.string().trim().min(1).optional(),
        summary: z.string().optional(),
        add_aliases: z.array(z.string()).optional(),
        remove_aliases: z.array(z.string()).optional(),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ entity_id, type, canonical_name, summary, add_aliases, remove_aliases }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      const fail = (msg: string) => ({ ...text(msg), isError: true })
      if (type === undefined && canonical_name === undefined && summary === undefined &&
          add_aliases === undefined && remove_aliases === undefined) {
        return fail('No field given: pass at least one of type, canonical_name, summary, add_aliases, remove_aliases.')
      }
      return db.transaction(async tx => {
        const [before] = await tx.select().from(entities).where(eq(entities.id, entity_id)).for('update')
        if (!before) return fail('Entity not found.')
        if (before.mergedInto) {
          const [into] = await tx.select().from(entities).where(eq(entities.id, before.mergedInto))
          return fail(`Entity was merged into "${into?.canonicalName ?? 'unknown'}" (${before.mergedInto.slice(0, 8)}); update that entity instead.`)
        }
        const name = canonical_name ?? before.canonicalName
        const removals = new Set(remove_aliases ?? [])
        const aliases = Array.from(new Set([
          ...before.aliases,
          ...(name !== before.canonicalName ? [before.canonicalName] : []),
          ...(add_aliases ?? []),
        ])).filter(a => a !== name && !removals.has(a))
        const next = { type: type ?? before.type, canonicalName: name, summary: summary ?? before.summary, aliases }
        await tx.update(entities).set(next).where(eq(entities.id, entity_id))

        const changes: string[] = []
        if (next.type !== before.type) changes.push(`type: ${before.type} -> ${next.type}`)
        if (next.canonicalName !== before.canonicalName) changes.push(`name: "${before.canonicalName}" -> "${next.canonicalName}"`)
        if (next.summary !== before.summary) changes.push(`summary: ${JSON.stringify(before.summary)} -> ${JSON.stringify(next.summary)}`)
        if (next.aliases.join('\u0000') !== before.aliases.join('\u0000')) {
          changes.push(`aliases: [${before.aliases.join(', ')}] -> [${next.aliases.join(', ')}]`)
        }
        return text(
          `Updated "${next.canonicalName}" (${entity_id.slice(0, 8)}):\n` +
            (changes.length ? changes.map(c => `  ${c}`).join('\n') : '  no change (values already matched)'),
        )
      })
    },
  )

  // ── retire_entity ──────────────────────────────────────────────────────────
  server.registerTool(
    'retire_entity',
    {
      title: 'Retire an empty entity',
      description:
        'Retire an entity nothing is attached to, such as a misread calendar title the brief lists under "Named but never substantiated". ' +
        'Takes entity_id from what_do_you_know\'s `entity.id`. Refused while the entity has any live fact or link. ' +
        'Soft: the row is kept, and remembering a fact about it later un-retires it.',
      inputSchema: {
        entity_id: z.string().uuid(),
        reason: z.string().optional(),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ entity_id, reason }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      const r = await retireEntity(entity_id)
      if (!r.ok) return { ...text(r.reason), isError: true }
      return text(`Retired "${r.name}"${reason ? ` (${reason})` : ''}. Remembering a fact about it un-retires it.`)
    },
  )

  // ── restore ────────────────────────────────────────────────────────────────
  // The undo for forget. Unattended maintenance retires rows in bulk, and
  // re-typing a wrongly retired row by hand loses its id, confidence and
  // provenance; clearing the invalidation keeps all three.
  server.registerTool(
    'restore',
    {
      title: 'Restore',
      description:
        'Undo a forget: make a forgotten observation live again, with its original id, confidence and provenance. ' +
        'Takes the full observation_id from the forget result or a maintenance report.',
      inputSchema: {
        observation_id: z.string().uuid(),
        reason: z.string().optional(),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ observation_id, reason }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      const restored = await db
        .update(observations)
        .set({ invalidatedAt: null, validTo: null, invalidatedBy: null })
        .where(and(eq(observations.id, observation_id), isNotNull(observations.invalidatedAt)))
        .returning()
      if (restored.length) {
        return text(`Restored: "${restored[0]!.statement}"${reason ? ` (${reason})` : ''}`)
      }
      const [exists] = await db.select({ id: observations.id }).from(observations).where(eq(observations.id, observation_id))
      return { ...text(exists ? 'That observation is not forgotten; nothing to restore.' : 'No observation with that id.'), isError: true }
    },
  )

  // ── retire_link ────────────────────────────────────────────────────────────
  // Facts can be superseded, but links (reports_to, works_at...) had no way to
  // end, so a reorg left get_context naming people as reports long after they
  // moved. Retiring sets invalidated_at/valid_to; the row stays as history.
  server.registerTool(
    'retire_link',
    {
      title: 'Retire a link',
      description:
        'End a relationship that is no longer true, such as someone who no longer reports to the owner. ' +
        'Takes the from and to entity ids (from what_do_you_know\'s `entity.id`, or a get_context related entry) and the relation exactly as get_context shows it. ' +
        'The link is kept as history and stops appearing in get_context.',
      inputSchema: {
        from_entity_id: z.string().uuid(),
        to_entity_id: z.string().uuid(),
        relation: z.string().min(1),
        reason: z.string().optional(),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ from_entity_id, to_entity_id, relation, reason }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      const now = new Date()
      const retired = await db
        .update(links)
        .set({ invalidatedAt: now, validTo: now })
        .where(and(
          eq(links.fromEntity, from_entity_id),
          eq(links.toEntity, to_entity_id),
          eq(links.relation, relation),
          isNull(links.invalidatedAt),
        ))
        .returning({ id: links.id })
      if (!retired.length) {
        return { ...text(`No live link ${from_entity_id.slice(0, 8)} -[${relation}]-> ${to_entity_id.slice(0, 8)}; nothing retired.`), isError: true }
      }
      const names = await db.select({ id: entities.id, name: entities.canonicalName }).from(entities)
        .where(inArray(entities.id, [from_entity_id, to_entity_id]))
      const name = (id: string) => names.find(n => n.id === id)?.name ?? id.slice(0, 8)
      return text(
        `Retired ${retired.length} link${retired.length > 1 ? 's' : ''}: ${name(from_entity_id)} -[${relation}]-> ${name(to_entity_id)}` +
          `${reason ? ` (${reason})` : ''}. Kept as history; no longer shown by get_context.`,
      )
    },
  )

  // ── how_i_work ─────────────────────────────────────────────────────────────
  // Authored policy remains stable while learned preferences retain their
  // evidence. The active client applies both using its live task context.
  registerHowIWorkTool(server, workingStyle, SELF_NAME)

  // ── note_preference ────────────────────────────────────────────────────────
  server.registerTool(
    'note_preference',
    {
      title: 'Note a working preference',
      description:
        'Record something learned about how the owner likes to work — a correction they made, a format they asked for, a way of working they confirmed. Call this whenever it comes up, not only the first time: re-observing a preference strengthens it. ' +
        'If how_i_work already lists it, pass that line\'s id as `reinforces` — a reworded restatement shares too few words to be recognised and would be recorded as a duplicate. ' +
        'Keep statements short and general (about a dozen words, no incident or date) so they can recur.',
      inputSchema: {
        statement: z
          .string()
          .describe(
            'One atomic preference, phrased as an observation: "prefers conclusions before reasoning", not "be concise".',
          ),
        reinforces: z
          .string()
          .min(8)
          .optional()
          .describe(
            'Id of the existing preference this re-observes (the id shown in how_i_work, or a full observation_id). ' +
              'Strengthens that preference and keeps its wording; nothing new is recorded.',
          ),
      },
      _meta: oauthToolMeta('write'),
      annotations: { readOnlyHint: false },
    },
    async ({ statement, reinforces }) => {
      const denied = writeDenied(scope, writeAuthChallenge)
      if (denied) return denied
      return text(describePreference(await notePreference({ statement, reinforces })))
    },
  )

  // ── brief ──────────────────────────────────────────────────────────────────
  // The daily digest. Pull-timed and read-only by deliberate choice: the one
  // interaction pattern that survives daily use is a digest you choose to open,
  // not a stream of interrupts. Proactive push is where trust dies.
  server.registerTool(
    'brief',
    {
      title: 'Daily brief',
      description:
        'What to know right now: upcoming commitments, who they involve, and anything worth attention.',
      inputSchema: {
        hours: intArg(1, 168).default(24),
      },
      _meta: oauthToolMeta('read'),
      annotations: { readOnlyHint: true },
    },
    async ({ hours }) => {
      const until = new Date(Date.now() + hours * 3600_000)
      const sections: string[] = [calendarCoverage]
      // Everyone the window's meetings resolved to. "Worth a look" is about
      // them first: an inference about someone you are not seeing today is
      // the brief reading out the whole store.
      const inWindow = new Set<string>()

      // 1. What's coming.
      const upcoming = await db
        .select()
        .from(episodes)
        .where(
          and(
            or(eq(episodes.source, 'gcal_work'), eq(episodes.source, 'gcal_personal')),
            gte(episodes.occurredAt, new Date()),
            lte(episodes.occurredAt, until),
          ),
        )
        .orderBy(episodes.occurredAt)
        .limit(25)

      if (upcoming.length) {
        // Per-invocation, not module-level: the same person appears in half a
        // day's meetings and re-resolving them each time is pure waste, but
        // cached across invocations it would serve a belief a later `remember`
        // or `forget` has since corrected.
        const seenAttendee = new Map<string, string | null>()
        const lookup = async (handle: string) => {
          if (!seenAttendee.has(handle)) {
            const h = await headline(handle)
            if (h) inWindow.add(h.entityId)
            seenAttendee.set(handle, h?.line ?? null)
          }
          return seenAttendee.get(handle) ?? null
        }

        const lines = await Promise.all(
          upcoming.map(async (e) => {
            const b = e.body as {
              summary?: string
              start?: EventStart
              attendees?: { email?: string; name?: string; self?: boolean }[]
            }
            const when = formatWhen(e.occurredAt, b.start)
            // Who is this with, and what do we already know about them? This is
            // the whole point of a brief over a calendar: the calendar already
            // tells you the time.
            const others = (b.attendees ?? [])
              .filter((a) => !!a.email && !a.self && !isOwnerEmail(a.email))
              .slice(0, 3)

            const context: string[] = []
            for (const a of others) {
              // Display name first, address as the fallback. A name resolves
              // through canonical names and aliases; an address only ever
              // matches if someone recorded it as a fact, so it finds strictly
              // less. Both go through the same ranked assembly, which is why an
              // attendee's headline is now their best fact rather than merely
              // their most confident one.
              const note =
                (a.name ? await lookup(a.name) : null) ?? (a.email ? await lookup(a.email) : null)
              if (note) context.push(note)
            }
            return `- ${when}  ${b.summary ?? e.kind}` +
              (context.length ? `\n    with: ${context.join('; ')}` : '')
          }),
        )
        sections.push(`## Next ${hours}h\n${lines.join('\n')}`)
      } else {
        sections.push(`## Next ${hours}h\nNo native-ingested calendar entries found.`)
      }

      // 2. Anticipations — inferences, flagged as such, never as fact. Those
      //    about the window's attendees come first; the rest of the store gets
      //    a few lines at most, so the section stays about what is coming.
      // With no attendees in the window this must still be an expression, not
      // a bare `false`: Postgres rejects a constant in ORDER BY, and an empty
      // calendar is exactly the day the brief broke on.
      const attendeeFirst = inWindow.size
        ? sql<boolean>`${observations.entityId} in (${sql.join([...inWindow].map((id) => sql`${id}::uuid`), sql`, `)})`
        : sql<boolean>`(${observations.entityId} is null)`
      const anticRows = await db
        .select({
          statement: observations.statement,
          confidence: observations.confidence,
          name: entities.canonicalName,
          attendee: attendeeFirst,
        })
        .from(observations)
        .innerJoin(entities, eq(entities.id, observations.entityId))
        // `live` rather than a hand-rolled copy: an anticipation whose expiry
        // has passed is precisely the row that must not appear here, and it is
        // the `validTo` half of the predicate that excludes it.
        .where(and(eq(observations.category, 'anticipation'), live))
        .orderBy(desc(attendeeFirst), desc(observations.confidence))
        .limit(BRIEF_ANTICIPATIONS)
      let elsewhere = 0
      const antic = anticRows.filter((a) => a.attendee || elsewhere++ < BRIEF_UNRELATED_ANTICIPATIONS)

      if (antic.length) {
        sections.push(
          `## Worth a look\n` +
            antic
              .map(
                (a) =>
                  `- ${a.name}: ${a.statement}  _(inferred, ${a.confidence.toFixed(2)})_`,
              )
              .join('\n'),
        )
      }

      // 3. Anything the graph itself is unsure about — surfaced rather than
      //    silently trusted. Two distinct problems, and conflating them is why
      //    a phantom went unnoticed until it was asked about directly.
      // Hollow entities: named once, never substantiated. A real person
      // accumulates facts; a misparse ("Carson Sr" from "Carson Sr photos")
      // stays empty forever, which is why only the past week's are listed.
      // Listing every one meant the same names opened every brief, with no way
      // to clear them; older ones get a count instead.
      const hollow = sql`not exists (
        select 1 from observations o
        where o.entity_id = ${entities.id} and o.invalidated_at is null
      ) and not exists (
        select 1 from links l
        where (l.from_entity = ${entities.id} or l.to_entity = ${entities.id})
          and l.invalidated_at is null
      ) and ${entities.createdAt} < now() - interval '1 day'`
      const suspect = await db
        .select({
          id: entities.id,
          name: entities.canonicalName,
          summary: entities.summary,
          provisional: entities.provisional,
          facts: sql<number>`(
            select count(*)::int from observations o
            where o.entity_id = ${entities.id} and o.invalidated_at is null
          )`,
        })
        .from(entities)
        .where(
          and(
            isNull(entities.mergedInto),
            isNull(entities.retiredAt),
            or(
              sql`${entities.provisional} is not null`,
              sql`${hollow} and ${entities.createdAt} >= now() - interval '${sql.raw(String(HOLLOW_RECENT_DAYS))} days'`,
            ),
          ),
        )
        .orderBy(desc(entities.createdAt))
        .limit(8)
      const [olderRow] = await db
        .select({ older: sql<number>`count(*)::int` })
        .from(entities)
        .where(and(
          isNull(entities.mergedInto),
          isNull(entities.retiredAt),
          isNull(entities.provisional),
          sql`${hollow} and ${entities.createdAt} < now() - interval '${sql.raw(String(HOLLOW_RECENT_DAYS))} days'`,
        ))
      const older = olderRow?.older ?? 0

      // Provisional-AND-empty is the strong tell for something that was never
      // real; provisional-with-facts is a genuine identity question.
      const phantom = suspect.filter((s) => s.facts === 0)
      const ambiguous = suspect.filter((s) => s.facts > 0)

      if (phantom.length) {
        // Deliberately describes what is TRUE of these rows rather than
        // asserting why. "No facts attached" fits both a misread calendar title
        // ("Carson Sr" from "Carson Sr photos") and a real address-book entry
        // nothing has been learned about yet — and those look identical from
        // here. Calling a real person "probably not real" is a worse error than
        // leaving the judgement to the reader.
        sections.push(
          `## Named but never substantiated\n` +
            phantom
              .map(
                (p) =>
                  `- ${p.name}${p.summary ? ` — ${p.summary.slice(0, 70)}` : ''}  entity_id=${p.id}`,
              )
              .join('\n') +
            `\n_Nothing has attached to these. Either a misread title, or someone nothing is known about yet. retire_entity clears a misread one._` +
            (older ? `\n_${older} older ${older === 1 ? 'one is' : 'ones are'} not listed._` : ''),
        )
      }
      if (ambiguous.length) {
        sections.push(
          `## Unconfirmed identities\n` +
            ambiguous.map((p) => `- ${p.name} — could not be matched confidently`).join('\n'),
        )
      }

      return text(sections.join('\n\n'))
    },
  )

  // ── search ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'search',
    {
      title: 'Search facts and episodes',
      description:
        'Search across everything stored: first the remembered facts on every entity (with each fact\'s entity and observation id), ' +
        'then the raw ingested source material. Use it to check whether something is already remembered before writing it, ' +
        'or when the entity graph does not have the answer. Long statements are clipped; page stored facts with `offset`.',
      inputSchema: {
        query: z.string(),
        limit: intArg(1, 50).default(10),
        offset: intArg(0, 2000).default(0).describe('Skip this many stored-fact hits. Source material is shown on the first page only.'),
      },
      _meta: oauthToolMeta('read'),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, offset }) => {
      const [facts, hits] = await Promise.all([
        searchFacts(query, limit, offset),
        offset === 0 ? searchEpisodes(query, limit) : [],
      ])
      if (!facts.length && !hits.length) {
        return text(offset ? `No more stored facts match "${query}" at offset ${offset}.` : `Nothing stored matches "${query}".`)
      }
      const sections: string[] = []
      if (facts.length) {
        sections.push(
          '## Stored facts\n' +
            facts
              .map(
                (f) =>
                  `- [${f.entityName}] ${clip(f.statement)}` +
                  (f.matchedBy === 'substring' ? ' _(substring match)_' : '') +
                  `\n    observation_id=${f.id} entity_id=${f.entityId} ${f.category} conf=${f.confidence.toFixed(2)} since=${f.createdAt.toISOString().slice(0, 10)}`,
              )
              .join('\n') +
            (facts.length === limit ? `\n_More may match: call again with offset=${offset + limit}._` : ''),
        )
      }
      if (hits.length) {
        sections.push(
          '## Source material\n' +
            hits
              .map(
                (r) =>
                  `- [${r.source}] ${r.occurredAt.toISOString().slice(0, 16)}` +
                  // Flagged because a substring-only hit means full-text found
                  // nothing — worth knowing before treating the result as relevant.
                  (r.matchedBy === 'substring' ? ' _(substring match)_' : '') +
                  `\n    episode_id=${r.id} source_ref=${r.sourceRef} content_hash=${r.contentHash}\n    ${r.snippet}`,
              )
              .join('\n'),
        )
      }
      return text(sections.join('\n\n'))
    },
  )
}
