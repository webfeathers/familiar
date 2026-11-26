/**
 * TEMPLATE — copy to `seed/work.ts` and fill in.
 *
 *   cp seed/work.example.ts seed/work.ts
 *
 * `seed/work.ts` is GITIGNORED on purpose. It holds colleagues' names,
 * reporting lines and internal vocabulary — employer context that does not
 * belong in a git history, even a private one. This template stays committed so
 * the shape is documented and reproducible.
 *
 * Everything here is trusted by definition. Write what is true, not what is
 * aspirational — it is served back to every session as your own account of
 * things.
 *
 * Import with `pnpm seed`. Re-run whenever this file changes; upserts key on
 * (source, source_ref) so re-importing is harmless. Seeded entries are stored
 * and searchable; since the deriver was removed (2026-09-10) they are no
 * longer turned into beliefs automatically.
 */
import type { SeedDocument } from '../src/ingest/seed.ts'

export const seed: SeedDocument = {
  key: 'acme',
  org: 'Acme',

  people: [
    {
      name: 'Jane Example',
      role: 'Director, Professional Services',
      team: 'Professional Services',
      notes: [
        'Reports to me',
        'Owns the implementation backlog',
      ],
    },
  ],

  teams: [
    {
      name: 'Professional Services',
      purpose: 'Customer implementations and onboarding',
      members: ['Jane Example'],
      notes: ['Weekly staff meeting Mondays'],
    },
  ],

  /**
   * Internal vocabulary. This is disproportionately valuable: acronyms are
   * exactly what a calendar title is full of and what nothing else can decode.
   */
  glossary: [
    { term: 'MM', meaning: 'Management Meeting — weekly GTM leadership sync' },
    { term: 'TSS', meaning: 'Technical Support Services' },
  ],

  workflows: [
    {
      name: 'Weekly GTM update',
      cadence: 'weekly, Wednesdays',
      description:
        'Prepare the PS and TSS sections for the GTM management meeting doc.',
    },
  ],

  /** Anything that fits none of the above. */
  notes: [
    'I lead Professional Services and Support at Acme.',
  ],
}
