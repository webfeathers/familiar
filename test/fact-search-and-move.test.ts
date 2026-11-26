import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.TEST_DATABASE_URL

describe('fact search and move_facts', { skip: !url && 'TEST_DATABASE_URL is not set' }, async () => {
  if (!url) return
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.pathname.includes('test'),
    'TEST_DATABASE_URL must name a loopback-only test database')
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = url
  const { db, pool, entities, observations } = await import('../src/store/index.ts')
  const { eq, inArray } = await import('drizzle-orm')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')

  async function connect(scope: string) {
    const server = new McpServer({ name: 'fact-tools-test', version: '0' })
    const client = new Client({ name: 'fact-tools-test', version: '0' })
    registerTools(server, scope, 'fixture-owner')
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    await client.connect(clientSide)
    return { client, close: async () => { await client.close(); await server.close() } }
  }
  const writer = await connect('context:read context:write')
  const reader = await connect('context:read')

  const entityIds: string[] = []
  async function entity(values: Partial<typeof entities.$inferInsert> = {}) {
    const [row] = await db.insert(entities).values({
      type: 'project', canonicalName: `Fact ${randomUUID()}`, ...values,
    }).returning()
    entityIds.push(row!.id)
    return row!
  }
  async function observe(entityId: string, statement: string, extra: Partial<typeof observations.$inferInsert> = {}) {
    const [row] = await db.insert(observations).values({
      entityId, statement, category: 'attribute', confidence: 0.8, validFrom: new Date('2026-09-01T00:00:00Z'), ...extra,
    }).returning()
    return row!
  }
  const call = async (client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args })
    return { res, text: (res.content as { text: string }[]).map(c => c.text).join('\n') }
  }

  after(async () => {
    await writer.close(); await reader.close()
    if (entityIds.length) await db.delete(entities).where(inArray(entities.id, entityIds))
    await pool.end()
  })

  test('search returns stored facts with their entity and id, and never a retired fact', async () => {
    const tag = randomUUID().slice(0, 8)
    const e = await entity({ canonicalName: `Searchable ${tag}` })
    const live = await observe(e.id, `Quokka ${tag} renewals are owned by the account manager inside the window`)
    await observe(e.id, `Quokka ${tag} renewals were owned by finance`, { invalidatedAt: new Date() })
    const { text } = await call(reader.client, 'search', { query: `quokka ${tag} renewals` })
    assert.match(text, /## Stored facts/)
    assert.ok(text.includes(live.id), 'the live fact id is listed')
    assert.ok(text.includes(`Searchable ${tag}`), 'the owning entity is named')
    assert.ok(!text.includes('owned by finance'), 'a retired fact is not returned')
  })

  test('search finds an identifier the full-text tokenizer splits', async () => {
    const tag = randomUUID().slice(0, 8)
    const e = await entity()
    const fact = await observe(e.id, `Field Zq_${tag}__c is the system of record for the plan path`)
    const { text } = await call(reader.client, 'search', { query: `Zq_${tag}__c` })
    assert.ok(text.includes(fact.id), 'substring pass finds the identifier')
  })

  test('move_facts re-homes facts by target name, keeping id, confidence and provenance', async () => {
    const from = await entity()
    const to = await entity({ canonicalName: `Topic ${randomUUID()}`, aliases: ['Topic alias'] })
    const a = await observe(from.id, 'Alpha fact')
    const b = await observe(from.id, 'Beta fact', { confidence: 0.55 })
    const stay = await observe(from.id, 'Gamma fact stays')
    const { res, text } = await call(writer.client, 'move_facts', { observation_ids: [a.id, b.id], to: to.canonicalName })
    assert.ok(!res.isError, text)
    assert.match(text, /Moved 2/)
    const rows = await db.select().from(observations).where(inArray(observations.id, [a.id, b.id, stay.id]))
    const byId = new Map(rows.map(r => [r.id, r]))
    assert.equal(byId.get(a.id)!.entityId, to.id)
    assert.equal(byId.get(b.id)!.entityId, to.id)
    assert.equal(byId.get(b.id)!.confidence, 0.55)
    assert.equal(byId.get(a.id)!.createdAt.getTime(), a.createdAt.getTime())
    assert.equal(byId.get(stay.id)!.entityId, from.id)
  })

  test('move_facts resolves an alias and skips retired facts', async () => {
    const from = await entity()
    const to = await entity({ aliases: [`Alias ${randomUUID()}`] })
    const live = await observe(from.id, 'Delta fact')
    const dead = await observe(from.id, 'Epsilon fact', { invalidatedAt: new Date() })
    const { text } = await call(writer.client, 'move_facts', { observation_ids: [live.id, dead.id], to: to.aliases[0] })
    assert.match(text, /Moved 1/)
    assert.match(text, /not moved/i)
    const [deadRow] = await db.select().from(observations).where(eq(observations.id, dead.id))
    assert.equal(deadRow!.entityId, from.id)
  })

  test('move_facts refuses an unknown or merged target and changes nothing', async () => {
    const from = await entity()
    const winner = await entity()
    const merged = await entity({ mergedInto: winner.id })
    const f = await observe(from.id, 'Zeta fact')
    for (const to of [`No such entity ${randomUUID()}`, merged.id]) {
      const { res } = await call(writer.client, 'move_facts', { observation_ids: [f.id], to })
      assert.ok(res.isError, `refused target ${to}`)
    }
    const [row] = await db.select().from(observations).where(eq(observations.id, f.id))
    assert.equal(row!.entityId, from.id)
  })

  test('move_facts needs write scope', async () => {
    const from = await entity()
    const to = await entity()
    const f = await observe(from.id, 'Eta fact')
    await call(reader.client, 'move_facts', { observation_ids: [f.id], to: to.id })
    const [row] = await db.select().from(observations).where(eq(observations.id, f.id))
    assert.equal(row!.entityId, from.id)
  })
})
