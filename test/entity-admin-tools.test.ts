import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.TEST_DATABASE_URL

describe('entity admin MCP tools', { skip: !url && 'TEST_DATABASE_URL is not set' }, async () => {
  if (!url) return
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.pathname.includes('test'),
    'TEST_DATABASE_URL must name a loopback-only test database')
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = url
  const { db, pool, entities, observations, links } = await import('../src/store/index.ts')
  const { eq, inArray } = await import('drizzle-orm')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')

  async function connect(scope: string) {
    const server = new McpServer({ name: 'entity-admin-test', version: '0' })
    const client = new Client({ name: 'entity-admin-test', version: '0' })
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
      type: 'person', canonicalName: `Admin ${randomUUID()}`, ...values,
    }).returning()
    entityIds.push(row!.id)
    return row!
  }
  const reload = async (id: string) => (await db.select().from(entities).where(eq(entities.id, id)))[0]!
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await writer.client.callTool({ name, arguments: args })
    return { res, text: (res.content as { text: string }[]).map(c => c.text).join('\n') }
  }
  async function observe(entityId: string, statement: string) {
    await db.insert(observations).values({ entityId, statement, category: 'state', confidence: 0.9, validFrom: new Date() })
  }

  after(async () => {
    await writer.close(); await reader.close()
    if (entityIds.length) {
      await db.delete(links).where(inArray(links.fromEntity, entityIds))
      await db.delete(entities).where(inArray(entities.id, entityIds))
    }
    await pool.end()
  })

  test('retire_link invalidates a stale live link and leaves others alone', async () => {
    const boss = await entity()
    const report = await entity()
    const validFrom = new Date('2020-01-01T00:00:00Z')
    await db.insert(links).values([
      { fromEntity: report.id, toEntity: boss.id, relation: 'reports_to', confidence: 0.9, validFrom },
      { fromEntity: report.id, toEntity: boss.id, relation: 'works_with', confidence: 0.9, validFrom },
    ])
    const r = await call('retire_link', { from_entity_id: report.id, to_entity_id: boss.id, relation: 'reports_to', reason: 'reorg' })
    assert.notEqual(r.res.isError, true, r.text)
    assert.match(r.text, /Retired 1 link/)
    const rows = await db.select().from(links).where(eq(links.fromEntity, report.id))
    const reports = rows.find(l => l.relation === 'reports_to')!
    assert.ok(reports.invalidatedAt)
    assert.ok(reports.validTo)
    assert.equal(rows.find(l => l.relation === 'works_with')!.invalidatedAt, null)
    const again = await call('retire_link', { from_entity_id: report.id, to_entity_id: boss.id, relation: 'reports_to' })
    assert.equal(again.res.isError, true)
    assert.match(again.text, /No live link/)
  })

  test('restore brings a forgotten observation back and refuses a live one', async () => {
    const e = await entity()
    const [row] = await db.insert(observations).values({
      entityId: e.id, statement: `restorable ${randomUUID()}`, category: 'state', confidence: 0.9, validFrom: new Date(),
    }).returning()
    const live = await call('restore', { observation_id: row!.id })
    assert.equal(live.res.isError, true)
    assert.match(live.text, /not forgotten/)
    await call('forget', { observation_id: row!.id, reason: 'test' })
    const gone = (await db.select().from(observations).where(eq(observations.id, row!.id)))[0]!
    assert.ok(gone.invalidatedAt)
    const back = await call('restore', { observation_id: row!.id, reason: 'wrongly retired' })
    assert.notEqual(back.res.isError, true, back.text)
    assert.match(back.text, /Restored/)
    const now = (await db.select().from(observations).where(eq(observations.id, row!.id)))[0]!
    assert.equal(now.invalidatedAt, null)
    assert.equal(now.validTo, null)
    assert.equal(now.invalidatedBy, null)
    const missing = await call('restore', { observation_id: randomUUID() })
    assert.equal(missing.res.isError, true)
  })

  test('merge_entities folds a link both entities share instead of violating the unique index', async () => {
    const loser = await entity({ canonicalName: `Dup ${randomUUID()}` })
    const winner = await entity({ canonicalName: `Keep ${randomUUID()}` })
    const shared = await entity({ type: 'project' })
    const validFrom = new Date('2020-01-01T00:00:00Z')
    const [srcA, srcB] = [randomUUID(), randomUUID()]
    await db.insert(links).values([
      { fromEntity: loser.id, toEntity: shared.id, relation: 'built', confidence: 0.6, validFrom, sourceEpisodeIds: [srcA] },
      { fromEntity: winner.id, toEntity: shared.id, relation: 'built', confidence: 0.9, validFrom, sourceEpisodeIds: [srcB] },
      { fromEntity: shared.id, toEntity: loser.id, relation: 'built_by', confidence: 0.9, validFrom },
      { fromEntity: shared.id, toEntity: winner.id, relation: 'built_by', confidence: 0.9, validFrom },
      // reciprocal links between the pair become self-links; both directions, same relation and time
      { fromEntity: loser.id, toEntity: winner.id, relation: 'same_as', confidence: 0.9, validFrom },
      { fromEntity: winner.id, toEntity: loser.id, relation: 'same_as', confidence: 0.9, validFrom },
    ])
    const { res, text } = await call('merge_entities', { loser_id: loser.id, winner_id: winner.id })
    assert.notEqual(res.isError, true, text)
    assert.equal((await reload(loser.id)).mergedInto, winner.id)
    const out = await db.select().from(links).where(eq(links.fromEntity, winner.id))
    const built = out.filter(l => l.toEntity === shared.id && l.relation === 'built')
    assert.equal(built.length, 1)
    assert.deepEqual([...built[0]!.sourceEpisodeIds].sort(), [srcA, srcB].sort())
    assert.equal(built[0]!.confidence, 0.9)
    const into = await db.select().from(links).where(eq(links.toEntity, winner.id))
    assert.equal(into.filter(l => l.fromEntity === shared.id && l.relation === 'built_by').length, 1)
    assert.equal(out.filter(l => l.toEntity === winner.id).length, 0, 'no self-links')
    assert.equal((await db.select().from(links).where(eq(links.fromEntity, loser.id))).length, 0)
    assert.equal((await db.select().from(links).where(eq(links.toEntity, loser.id))).length, 0)
  })

  test('merge_entities moves observations and links, sets merged_into and aliases', async () => {
    const loser = await entity({ canonicalName: `Sam ${randomUUID()}`, aliases: ['S'] })
    const winner = await entity({ canonicalName: `Sam Rivera ${randomUUID()}` })
    const other = await entity()
    await observe(loser.id, 'Likes tea')
    await observe(loser.id, 'Lives in CA')
    await db.insert(links).values({ fromEntity: loser.id, toEntity: other.id, relation: 'knows', confidence: 0.9, validFrom: new Date() })
    const { res, text } = await call('merge_entities', { loser_id: loser.id, winner_id: winner.id, reason: 'duplicate' })
    assert.notEqual(res.isError, true, text)
    assert.ok(text.includes(loser.canonicalName) && text.includes(winner.canonicalName))
    assert.ok(text.includes(loser.id.slice(0, 8)) && text.includes(winner.id.slice(0, 8)))
    assert.match(text, /observations moved: 2/i)
    assert.match(text, /links moved: 1/i)
    assert.match(text, /soft/i)
    const l = await reload(loser.id), w = await reload(winner.id)
    assert.equal(l.mergedInto, winner.id)
    assert.ok(w.aliases.includes(loser.canonicalName) && w.aliases.includes('S'))
    assert.equal((await db.select().from(observations).where(eq(observations.entityId, winner.id))).length, 2)
  })

  test('merging an already-merged entity returns error text, not a throw', async () => {
    const loser = await entity(), winner = await entity(), third = await entity()
    await call('merge_entities', { loser_id: loser.id, winner_id: winner.id })
    const again = await call('merge_entities', { loser_id: loser.id, winner_id: third.id })
    assert.equal(again.res.isError, true)
    assert.match(again.text, /already merged/i)
    const self = await call('merge_entities', { loser_id: third.id, winner_id: third.id })
    assert.equal(self.res.isError, true)
    assert.match(self.text, /itself/i)
    const missing = await call('merge_entities', { loser_id: third.id, winner_id: randomUUID() })
    assert.equal(missing.res.isError, true)
    assert.match(missing.text, /not found/i)
  })

  test('write scope denied returns the denial and changes nothing', async () => {
    const a = await entity(), b = await entity()
    for (const [name, args] of [
      ['merge_entities', { loser_id: a.id, winner_id: b.id }],
      ['update_entity', { entity_id: a.id, type: 'org' }],
    ] as const) {
      const res = await reader.client.callTool({ name, arguments: args })
      assert.equal(res.isError, true, name)
      assert.match(JSON.stringify(res.content), /context:write is required/)
    }
    assert.equal((await reload(a.id)).mergedInto, null)
    assert.equal((await reload(a.id)).type, 'person')
  })

  test('update_entity retypes, edits summary, and reports before -> after', async () => {
    const e = await entity({ type: 'person', canonicalName: `Project Atlas ${randomUUID()}` })
    const { res, text } = await call('update_entity', { entity_id: e.id, type: 'project', summary: 'RevOps layer' })
    assert.notEqual(res.isError, true, text)
    assert.match(text, /person -> project/)
    assert.match(text, /RevOps layer/)
    const row = await reload(e.id)
    assert.equal(row.type, 'project')
    assert.equal(row.summary, 'RevOps layer')
  })

  test('update_entity rename turns the old name into an alias and keeps aliases clean', async () => {
    const oldName = `CCO Acme Corp ${randomUUID()}`
    const newName = `Acme Corp ${randomUUID()}`
    const e = await entity({ type: 'org', canonicalName: oldName, aliases: ['AC', 'drop-me'] })
    const { res, text } = await call('update_entity', {
      entity_id: e.id, canonical_name: newName, add_aliases: ['AC', 'AC', newName, 'Acme'], remove_aliases: ['drop-me'],
    })
    assert.notEqual(res.isError, true, text)
    const row = await reload(e.id)
    assert.equal(row.canonicalName, newName)
    assert.deepEqual([...row.aliases].sort(), ['AC', 'Acme', oldName].sort())
    assert.ok(!row.aliases.includes(newName))
    assert.ok(text.includes(oldName) && text.includes(newName))
  })

  test('update_entity rejects empty input, missing entities and merged entities', async () => {
    const e = await entity()
    const empty = await call('update_entity', { entity_id: e.id })
    assert.equal(empty.res.isError, true)
    assert.match(empty.text, /no field/i)
    const missing = await call('update_entity', { entity_id: randomUUID(), type: 'org' })
    assert.equal(missing.res.isError, true)
    assert.match(missing.text, /not found|no entity/i)
    const winner = await entity({ canonicalName: `Winner ${randomUUID()}` })
    await call('merge_entities', { loser_id: e.id, winner_id: winner.id })
    const merged = await call('update_entity', { entity_id: e.id, type: 'org' })
    assert.equal(merged.res.isError, true)
    assert.ok(merged.text.includes(winner.canonicalName) && merged.text.includes(winner.id.slice(0, 8)))
    assert.equal((await reload(e.id)).type, 'person')
  })

  test('update_entity rejects a type outside ENTITY_TYPES at the schema', async () => {
    const e = await entity()
    const res = await writer.client.callTool({ name: 'update_entity', arguments: { entity_id: e.id, type: 'spaceship' } })
    assert.equal(res.isError, true)
    assert.match(JSON.stringify(res.content), /invalid/i)
    assert.doesNotMatch(JSON.stringify(res.content), /not found/i)
    assert.equal((await reload(e.id)).type, 'person')
  })

  test('retire_entity retires an empty entity and the brief stops listing it', async () => {
    const name = `Misread ${randomUUID().slice(0, 6)}`
    const e = await entity({ canonicalName: name, createdAt: new Date(Date.now() - 3 * 86_400_000) })
    const brief = async () => (await call('brief', { hours: 1 })).text
    assert.match(await brief(), new RegExp(`${name}.*entity_id=${e.id}`))

    const denied = await reader.client.callTool({ name: 'retire_entity', arguments: { entity_id: e.id } })
    assert.equal(denied.isError, true)
    assert.equal((await reload(e.id)).retiredAt, null)

    const { res, text } = await call('retire_entity', { entity_id: e.id, reason: 'misread title' })
    assert.ok(!res.isError, text)
    assert.ok((await reload(e.id)).retiredAt)
    assert.doesNotMatch(await brief(), new RegExp(name))

    // An empty entity's id is reachable by name, not only from the brief.
    assert.match((await call('what_do_you_know', { about: name })).text, new RegExp(`no live beliefs\\. entity_id=${e.id}`))

    const again = await call('retire_entity', { entity_id: e.id })
    assert.equal(again.res.isError, true)
    assert.match(again.text, /already retired/)
  })

  test('retire_entity refuses an entity with a live fact or link', async () => {
    const withFact = await entity()
    await observe(withFact.id, 'Works at the customer')
    const r1 = await call('retire_entity', { entity_id: withFact.id })
    assert.equal(r1.res.isError, true)
    assert.match(r1.text, /1 live fact/)

    const a = await entity(); const b = await entity()
    await db.insert(links).values({ fromEntity: a.id, toEntity: b.id, relation: 'knows', confidence: 0.9, validFrom: new Date() })
    const r2 = await call('retire_entity', { entity_id: b.id })
    assert.equal(r2.res.isError, true)
    assert.match(r2.text, /1 live link/)
    assert.equal((await reload(b.id)).retiredAt, null)
  })

  test('remembering a fact about a retired entity un-retires it', async () => {
    const e = await entity()
    assert.ok(!(await call('retire_entity', { entity_id: e.id })).res.isError)
    const { res, text } = await call('remember', { about: e.canonicalName, statement: 'Real after all' })
    assert.ok(!res.isError, text)
    assert.equal((await reload(e.id)).retiredAt, null)
  })
})
