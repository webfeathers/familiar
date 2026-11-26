/**
 * Curated seed import — work context as data, not as a live connection.
 *
 * The design always treated employer context this way (a seed source has been
 * in the Source union since the schema was written). It is not a feed: it is
 * relatively static reference knowledge — who is on which team, what the
 * recurring commitments are, what the internal vocabulary means — that would
 * otherwise have to be inferred badly from calendar titles, or not at all.
 *
 * Deliberately NOT a Connector. A connector implements `sync(since)` and runs on
 * a schedule; re-reading a static file every 15 minutes is pointless. This runs
 * when the file changes, by hand: `pnpm seed`.
 *
 * WHY A TYPESCRIPT FILE rather than YAML or JSON: it is typechecked, so a
 * malformed seed fails at `pnpm typecheck` rather than silently importing
 * half a team; it supports comments, which a seed absolutely needs; and it
 * needs no parser dependency.
 *
 * Episodes from here are trusted by definition — the user wrote them. That is
 * exactly why the file is gitignored: it is the one input that can assert
 * anything it likes.
 *
 * Since the deriver was removed (2026-09-10), seeded episodes are stored and
 * searchable but no longer turned into beliefs on their own.
 */
import type { NewEpisode } from '../store/schema.ts'
import { contentHash } from '../store/repo.ts'

export interface SeedPerson {
  name: string
  /** Role/title. Becomes a durable `attribute`. */
  role?: string
  team?: string
  /** Anything worth knowing that a calendar would never say. */
  notes?: string[]
}

export interface SeedTeam {
  name: string
  purpose?: string
  members?: string[]
  notes?: string[]
}

export interface SeedTerm {
  term: string
  meaning: string
}

export interface SeedWorkflow {
  name: string
  /** "weekly, Wednesdays" — cadence in plain language. */
  cadence?: string
  description: string
}

export interface SeedDocument {
  /** Namespaces the sourceRefs, so two seeds can coexist without collision. */
  key: string
  org: string
  people?: SeedPerson[]
  teams?: SeedTeam[]
  glossary?: SeedTerm[]
  workflows?: SeedWorkflow[]
  /** Free-form statements that fit none of the above. */
  notes?: string[]
}

/**
 * One episode per item rather than one per document. The deriver processes an
 * episode at a time, so a single giant blob would be one extraction call trying
 * to hold an entire org — and a wrong detail anywhere would be unattributable.
 * Per-item keeps provenance sharp and lets one bad entry be corrected alone.
 */
export function seedToEpisodes(doc: SeedDocument): NewEpisode[] {
  const out: NewEpisode[] = []
  // Static reference material has no natural event time. Using a fixed instant
  // rather than now() keeps re-imports idempotent: a re-run must not look like
  // the facts changed.
  const occurredAt = new Date('2020-01-01T00:00:00Z')

  const push = (kind: string, ref: string, body: object) =>
    out.push({
      source: 'work_seed',
      sourceRef: `${doc.key}:${ref}`,
      kind,
      body: { org: doc.org, ...body },
      occurredAt,
      dedupHash: contentHash(body),
    })

  for (const p of doc.people ?? []) push('seed_person', `person:${p.name}`, p)
  for (const t of doc.teams ?? []) push('seed_team', `team:${t.name}`, t)
  for (const g of doc.glossary ?? [])
    push('seed_glossary', `term:${g.term}`, g)
  for (const w of doc.workflows ?? [])
    push('seed_workflow', `workflow:${w.name}`, w)
  doc.notes?.forEach((n, i) => push('seed_note', `note:${i}`, { note: n }))

  return out
}
