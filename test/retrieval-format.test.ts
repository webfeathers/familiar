import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PgDialect } from 'drizzle-orm/pg-core'

// Never permit these unit tests to open a connection to a configured database.
process.env.NODE_ENV = 'test'
delete process.env.DATABASE_PUBLIC_URL
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:1/fixture'
const { db } = await import('../src/store/index.ts')
const { assembleContext, formatBundle, headlineFact, live, searchEpisodes } = await import('../src/retrieval/index.ts')
const dialect = new PgDialect()
const when = new Date('2026-01-01T00:00:00Z')
const episodeId = 'episode-full-id'

function query(rows: unknown[], calls: { kind: string; value: unknown }[]) {
  const chain: any = {}
  for (const kind of ['from', 'where', 'orderBy']) chain[kind] = (...value: unknown[]) => {
    calls.push({ kind, value }); return chain
  }
  chain.limit = (n: number) => { calls.push({ kind: 'limit', value: n }); return Promise.resolve(rows) }
  return chain
}
function observation(id: string, sourceEpisodeIds = [episodeId], validFrom = when) {
  return { id, entityId: 'entity', statement: `${id} fact`, category: 'attribute', confidence: 0.9,
    sourceEpisodeIds, validFrom, validTo: null, invalidatedAt: null }
}
const alice = { id: 'entity', canonicalName: 'Alice', type: 'person', aliases: [], mergedInto: null }

test('live predicate excludes future and expired observations', () => {
  const sql = dialect.sqlToQuery(live!).sql
  assert.match(sql, /"valid_from" <= now\(\)/)
  assert.match(sql, /"valid_to" >= now\(\)/)
  assert.match(sql, /"invalidated_at" is null/)
})

test('a briefing is two reads: the entity and its facts, with source episodes shown where they exist', async () => {
  const calls: { kind: string; value: unknown }[] = []
  const batches = [[alice], [observation('b'), observation('a'), observation('c', [])]]
  const select = mock.method(db, 'select', () => query(batches.shift()!, calls))
  try {
    const bundle = await assembleContext('Alice', { hops: 0, limit: 3 })
    assert.ok(bundle)
    // Same score and same date, so the id is the last tie-break.
    assert.deepEqual(bundle.facts.map(f => f.id), ['a', 'b', 'c'])
    assert.equal(select.mock.callCount(), 2)
    const rendered = formatBundle(bundle)
    assert.match(rendered, /- a fact  \[attribute, 0\.90, id a, source episodes episode-full-id\]/)
    assert.match(rendered, /- c fact  \[attribute, 0\.90, id c\]/)
  } finally { select.mock.restore() }
})

test('equal scores are ordered newest first before the id tie-break', async () => {
  const calls: { kind: string; value: unknown }[] = []
  const newer = new Date('2026-06-01T00:00:00Z')
  const batches = [[alice], [observation('a'), observation('z', [episodeId], newer)]]
  const select = mock.method(db, 'select', () => query(batches.shift()!, calls))
  try {
    const bundle = await assembleContext('Alice', { hops: 0, limit: 3 })
    assert.deepEqual(bundle!.facts.map(f => f.id), ['z', 'a'])
  } finally { select.mock.restore() }
})

test('capped empty fact buckets do not imply that no facts exist', () => {
  const bundle: any = { subject: { name: 'Project', type: 'project' }, facts: [], anticipations: [],
    related: [], omitted: 5, candidateTruncated: true }
  const rendered = formatBundle(bundle)
  assert.match(rendered, /No established facts selected; candidate retrieval is capped, more may exist/)
  assert.match(rendered, /omitted count covers only retrieved candidates/)
  assert.doesNotMatch(rendered, /nothing recorded yet/)
})

test('an anticipation is rendered apart from established facts and labelled on its own line', () => {
  const bundle: any = { subject: { name: 'Alice', type: 'person' },
    facts: [{ id: 'known', statement: 'Known fact', category: 'attribute', confidence: 0.9, via: null }],
    anticipations: [{ id: 'guess', statement: 'A guess', category: 'anticipation', confidence: 0.5, via: null }],
    related: [], omitted: 0 }
  const rendered = formatBundle(bundle)
  const [known, inferred] = rendered.split('## Worth a look (inferred, not observed)')
  assert.match(known!, /- Known fact  \[attribute, 0\.90, id known\]/)
  assert.doesNotMatch(known!, /A guess/)
  assert.match(inferred!, /- A guess  _\(inferred, 0\.50, id guess\)_/)
})

test('the headline is the top established fact', async () => {
  const calls: { kind: string; value: unknown }[] = []
  const batches = [[alice], [observation('lead')]]
  const select = mock.method(db, 'select', () => query(batches.shift()!, calls))
  try {
    assert.equal(await headlineFact('Alice'), 'Alice — lead fact')
  } finally { select.mock.restore() }
})

test('episode search exposes exact source refs and hashes for both search paths', async () => {
  const calls: { kind: string; value: unknown }[] = []
  const row = { id: 'one', source: 'gcal_work', sourceRef: 'calendar:event-id', contentHash: 'sha256-content',
    kind: 'event', occurredAt: when, body: { text: 'Alice owns the project.' } }
  const batches = [[row], [{ ...row, id: 'two' }]]
  const select = mock.method(db, 'select', () => query(batches.shift()!, calls))
  try {
    const hits = await searchEpisodes('Alice', 2)
    assert.equal(hits.length, 2)
    assert.deepEqual(hits.map(h => h.matchedBy), ['full-text', 'substring'])
    for (const hit of hits) {
      assert.equal(hit.sourceRef, row.sourceRef)
      assert.equal(hit.contentHash, row.contentHash)
    }
  } finally { select.mock.restore() }
})
