/**
 * `pnpm seed` — import curated work context.
 *
 * Run by hand when the seed file changes. Writes episodes only: they become
 * searchable source material. Nothing turns them into entities or facts on its
 * own; a session does that with `remember`.
 */
import { upsertEpisodes } from '../store/repo.ts'
import { seedToEpisodes, type SeedDocument } from '../ingest/seed.ts'

const path = process.argv[2] ?? '../../seed/work.ts'

let doc: SeedDocument
try {
  const mod = (await import(path)) as { seed?: SeedDocument; default?: SeedDocument }
  const found = mod.seed ?? mod.default
  if (!found) throw new Error('module exports neither `seed` nor a default export')
  doc = found
} catch (e) {
  console.error(
    `\n✗ Could not load a seed from "${path}".\n` +
      `  ${(e as Error).message}\n\n` +
      `  If you have not created one yet:\n` +
      `    cp seed/work.example.ts seed/work.ts\n`,
  )
  process.exit(1)
}

const episodes = seedToEpisodes(doc)
if (!episodes.length) {
  console.log('Seed loaded but contains no entries — nothing to import.')
  process.exit(0)
}

const { inserted, updated } = await upsertEpisodes(episodes)
const byKind = episodes.reduce<Record<string, number>>((acc, e) => {
  acc[e.kind] = (acc[e.kind] ?? 0) + 1
  return acc
}, {})

console.log(`\nSeed "${doc.key}" (${doc.org}) — ${episodes.length} entries`)
for (const [kind, n] of Object.entries(byKind)) {
  console.log(`  ${kind.padEnd(16)} ${n}`)
}
console.log(`\n${inserted} new, ${updated} changed, ${episodes.length - inserted - updated} unchanged`)
console.log(
  inserted || updated
    ? 'Stored as searchable source material; nothing derives facts from it.'
    : 'Nothing changed.',
)
process.exit(0)
