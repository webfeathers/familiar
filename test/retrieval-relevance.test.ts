/**
 * What comes back from a large entity, and how much of it is padding.
 *
 * Measured on production 2026-11-21: one entity held 1,582 live facts, nearly all at
 * confidence 0.95 and so at an identical score, and get_context returned them
 * in UUID order (ids 0004, 0020, 00cd, ...). These tests pin the replacement:
 * recency breaks ties, a topic narrows the read, numeric arguments survive a
 * client that sends them as text, and empty provenance is not serialised.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.TEST_DATABASE_URL

describe('retrieval relevance and response size', { skip: !url && 'TEST_DATABASE_URL is not set' }, async () => {
  if (!url) return
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.pathname.includes('test'),
    'TEST_DATABASE_URL must name a loopback-only test database')
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = url
  process.env.PCL_SELF = `Relevance Owner ${randomUUID()}`
  const { db, pool, entities, observations } = await import('../src/store/index.ts')
  const { eq, inArray } = await import('drizzle-orm')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')
  const { selfEntity, retireStalePreferences } = await import('../src/store/preferences.ts')

  const server = new McpServer({ name: 'relevance-test', version: '0' })
  const client = new Client({ name: 'relevance-test', version: '0' })
  registerTools(server, 'context:read context:write', 'fixture-owner')
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  await client.connect(clientSide)

  const entityIds: string[] = []
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args })
    return { res, text: (res.content as { text: string }[]).map(c => c.text).join('\n'), data: res.structuredContent as any }
  }
  const DAY = 86_400_000
  const base = new Date('2026-01-01T00:00:00Z').getTime()

  // 300 same-confidence attributes, one per day, plus two old on-topic facts
  // that sit well outside the newest 250.
  const [big] = await db.insert(entities).values({ type: 'project', canonicalName: `Big ${randomUUID()}` }).returning()
  entityIds.push(big!.id)
  await db.insert(observations).values(Array.from({ length: 300 }, (_, i) => ({
    entityId: big!.id, statement: `Routine fact number ${i} about plumbing`, category: 'attribute' as const,
    confidence: 0.95, validFrom: new Date(base + (i + 10) * DAY),
  })))
  await db.insert(observations).values([
    { entityId: big!.id, statement: 'The zebrafish importer retries three times', category: 'attribute', confidence: 0.95, validFrom: new Date(base) },
    { entityId: big!.id, statement: 'Zebrafish_Import__c is the staging object', category: 'attribute', confidence: 0.95, validFrom: new Date(base + DAY) },
  ])

  after(async () => {
    await client.close(); await server.close()
    const self = await selfEntity()
    await db.delete(entities).where(inArray(entities.id, [...entityIds, self.id]))
    await pool.end()
  })

  test('equal-score facts come back newest first, not in id order', async () => {
    const r = await call('get_context', { subject: big!.canonicalName, limit: 5 })
    assert.deepEqual(r.data.facts.map((f: any) => f.statement),
      [299, 298, 297, 296, 295].map(i => `Routine fact number ${i} about plumbing`))
  })

  test('a topic returns the matching facts even when they are old', async () => {
    const r = await call('get_context', { subject: big!.canonicalName, topic: 'zebrafish' })
    assert.deepEqual(r.data.facts.map((f: any) => f.statement).sort(),
      ['The zebrafish importer retries three times', 'Zebrafish_Import__c is the staging object'])
    assert.match(r.text, /topic "zebrafish"/)
    assert.equal(r.data.topic, 'zebrafish')
  })

  test('a topic that matches nothing says so instead of falling back to everything', async () => {
    const r = await call('get_context', { subject: big!.canonicalName, topic: 'quetzalcoatl' })
    assert.equal(r.data.facts?.length ?? 0, 0)
    assert.match(r.text, /No stored fact .* matches topic "quetzalcoatl"/)
  })

  test('numeric arguments sent as text are accepted', async () => {
    const ctx = await call('get_context', { subject: big!.canonicalName, limit: '2' })
    assert.notEqual(ctx.res.isError, true, ctx.text)
    assert.equal(ctx.data.facts.length, 2)
    const know = await call('what_do_you_know', { about: big!.canonicalName, limit: '3', offset: '1' })
    assert.notEqual(know.res.isError, true, know.text)
    assert.equal(know.data.observations.length, 3)
    const found = await call('search', { query: 'zebrafish', limit: '1' })
    assert.notEqual(found.res.isError, true, found.text)
    const bad = await call('what_do_you_know', { about: big!.canonicalName, limit: 'lots' })
    assert.equal(bad.res.isError, true)
  })

  test('numeric arguments are still published as integers in the tool schema', async () => {
    const { tools } = await client.listTools()
    const schema = (name: string) => tools.find(t => t.name === name)!.inputSchema.properties as any
    assert.equal(schema('get_context').limit.type, 'integer')
    assert.equal(schema('get_context').limit.maximum, 60)
    assert.equal(schema('what_do_you_know').offset.type, 'integer')
    assert.equal(schema('get_context').topic.type, 'string')
  })

  test('unlinked facts carry no empty provenance fields', async () => {
    const r = await call('get_context', { subject: big!.canonicalName, limit: 3 })
    for (const f of r.data.facts) {
      assert.deepEqual(Object.keys(f).sort(), ['category', 'confidence', 'id', 'since', 'statement'])
    }
    assert.doesNotMatch(r.text, /Source episodes: unlinked|Evidence: no reviewed evidence/)
    assert.match(r.text, new RegExp(`id ${r.data.facts[0].id}`))

    const know = await call('what_do_you_know', { about: big!.canonicalName, limit: 2 })
    for (const o of know.data.observations) {
      for (const key of ['tsv', 'embedding', 'entityId', 'review', 'invalidatedAt', 'validTo', 'sourceEpisodeIds']) {
        assert.ok(!(key in o), `${key} should be omitted when empty`)
      }
      assert.ok(o.id && o.statement && o.category && o.validFrom)
    }
    assert.ok(!('tsv' in know.data.entity) && !('embedding' in know.data.entity))
    assert.equal(know.data.total, 302)
  })

  test('a preference seen once and never again is retired after 45 days, and can be restored', async () => {
    const self = await selfEntity()
    const now = new Date('2026-11-21T00:00:00Z')
    const old = new Date(now.getTime() - 46 * DAY)
    const recent = new Date(now.getTime() - 44 * DAY)
    const pref = (statement: string, validFrom: Date, extra: Partial<typeof observations.$inferInsert> = {}) => ({
      entityId: self.id, statement, category: 'preference' as const, confidence: 0.55, validFrom, createdAt: validFrom, ...extra,
    })
    const rows = await db.insert(observations).values([
      pref('stale one-off', old),
      pref('recent one-off', recent),
      pref('old but reinforced', old, { observationCount: 2, confidence: 0.67 }),
      pref('old one-off written at high confidence', old, { confidence: 0.95 }),
      { ...pref('old fact, not a preference', old), category: 'attribute' as const },
    ]).returning()
    const [other] = await db.insert(entities).values({ type: 'person', canonicalName: `Other ${randomUUID()}` }).returning()
    entityIds.push(other!.id)
    const [foreign] = await db.insert(observations).values({ ...pref('someone else', old), entityId: other!.id }).returning()

    const retired = await retireStalePreferences(now)
    assert.deepEqual(retired.map(r => r.statement), ['stale one-off'])

    const live = async (id: string) => (await db.select().from(observations).where(eq(observations.id, id)))[0]!.invalidatedAt === null
    assert.equal(await live(rows[0]!.id), false)
    for (const row of [...rows.slice(1), foreign!]) assert.equal(await live(row.id), true, row.statement)

    assert.deepEqual(await retireStalePreferences(now), [], 'a second sweep finds nothing new')
    const back = await call('restore', { observation_id: rows[0]!.id })
    assert.notEqual(back.res.isError, true, back.text)
    assert.equal(await live(rows[0]!.id), true)
  })
})
