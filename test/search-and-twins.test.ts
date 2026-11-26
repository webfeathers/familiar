/**
 * Search stays readable and pageable, a write reports its likely twins, and
 * the full-text indexes exist where the queries expect them.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const url = process.env.TEST_DATABASE_URL

describe('search paging, similar facts and indexes', { skip: !url && 'TEST_DATABASE_URL is not set' }, async () => {
  if (!url) return
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.pathname.includes('test'),
    'TEST_DATABASE_URL must name a loopback-only test database')
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = url
  const { db, pool, entities, observations } = await import('../src/store/index.ts')
  const { inArray, sql } = await import('drizzle-orm')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')
  const { applyMigrations, migrationState } = await import('../src/store/migrate.ts')

  const server = new McpServer({ name: 'search-test', version: '0' })
  const client = new Client({ name: 'search-test', version: '0' })
  registerTools(server, 'context:read context:write', 'fixture-owner')
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  await client.connect(clientSide)
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args })
    return { res, text: (res.content as { text: string }[]).map(c => c.text).join('\n') }
  }

  // A word no other suite uses, so hits belong to this run alone.
  const word = `quokka${randomUUID().replace(/-/g, '').slice(0, 10)}`
  const entityIds: string[] = []
  const names = [`Search A ${randomUUID()}`, `Search B ${randomUUID()}`]
  for (const canonicalName of names) {
    const [row] = await db.insert(entities).values({ type: 'project', canonicalName }).returning()
    entityIds.push(row!.id)
  }
  await db.insert(observations).values(Array.from({ length: 7 }, (_, i) => ({
    entityId: entityIds[0]!, statement: `${word} short fact ${i}`, category: 'attribute' as const,
    confidence: 0.9, validFrom: new Date(Date.UTC(2026, 0, 1 + i)), createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
  })))
  const long = `${word} digest ` + 'lorem ipsum dolor sit amet '.repeat(40)
  await db.insert(observations).values({ entityId: entityIds[0]!, statement: long, category: 'event', confidence: 0.9,
    validFrom: new Date(Date.UTC(2026, 1, 1)), createdAt: new Date(Date.UTC(2026, 1, 1)) })

  after(async () => {
    await client.close(); await server.close()
    await db.delete(entities).where(inArray(entities.id, entityIds))
    await pool.end()
  })

  test('a long statement is clipped in search results and keeps its id', async () => {
    const r = await call('search', { query: `${word} digest`, limit: 5 })
    const line = r.text.split('\n').find(l => l.includes('lorem ipsum'))!
    assert.ok(line.length < 400, `clipped line is ${line.length} chars`)
    assert.match(line, new RegExp(`\\(\\+${long.length - 240} chars\\)`))
    assert.match(r.text, /observation_id=[0-9a-f-]{36}/)
  })

  test('offset pages through stored facts without repeating or dropping any', async () => {
    const ids = (text: string) => [...text.matchAll(/observation_id=([0-9a-f-]{36})/g)].map(m => m[1])
    const first = await call('search', { query: word, limit: 3 })
    assert.match(first.text, /call again with offset=3/)
    const second = await call('search', { query: word, limit: 3, offset: 3 })
    const third = await call('search', { query: word, limit: 3, offset: 6 })
    const all = [...ids(first.text), ...ids(second.text), ...ids(third.text)]
    assert.equal(all.length, 8)
    assert.equal(new Set(all).size, 8)
    assert.doesNotMatch(third.text, /call again with offset/)
    const past = await call('search', { query: word, limit: 3, offset: 9 })
    assert.match(past.text, /No more stored facts match/)
  })

  test('remember reports a near-identical fact stored under another entity', async () => {
    const first = await call('remember', { about: names[0], statement: `The ${word} loader resends failed batches three times before paging` })
    assert.doesNotMatch(first.text, /Similar facts already stored/)
    const firstId = first.text.match(/observation_id: ([0-9a-f-]{36})/)![1]
    const second = await call('remember', { about: names[1], statement: `The ${word} loader resends failed batches three times, then pages` })
    assert.match(second.text, /Similar facts already stored/)
    assert.match(second.text, new RegExp(`id=${firstId}`))
    assert.match(second.text, new RegExp(`\\[${names[0]}\\]`))
    const unrelated = await call('remember', { about: names[1], statement: 'Renewal forecasts are reviewed every Tuesday morning' })
    assert.doesNotMatch(unrelated.text, new RegExp(firstId!))
  })

  test('pending migrations are a no-op on a migrated database and the full-text indexes exist', async () => {
    await applyMigrations()
    assert.equal(await migrationState(), 'current')
    // The state must be able to say "pending": remove the journal rows from the
    // FTS migration onward and it names that migration, then applying re-runs
    // it (and every later one) and recreates the indexes. The count comes from
    // the journal so a newer migration does not move the test off 0009.
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
      entries: { when: number; tag: string }[]
    }
    const fts = journal.entries.find((e) => e.tag === '0009_fts_indexes')!
    const fromFts = journal.entries.filter((e) => e.when >= fts.when).length
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at >= ${fts.when}`)
    await db.execute(sql`drop index if exists observations_statement_fts_idx`)
    await db.execute(sql`drop index if exists episodes_body_fts_idx`)
    assert.equal(await migrationState(), `${fromFts} pending (next: 0009_fts_indexes)`)
    await applyMigrations()
    assert.equal(await migrationState(), 'current')
    const rows = await db.execute(sql`select indexname from pg_indexes where indexname in ('observations_statement_fts_idx', 'episodes_body_fts_idx') order by 1`)
    assert.deepEqual(rows.rows.map((r: any) => r.indexname), ['episodes_body_fts_idx', 'observations_statement_fts_idx'])
  })
})
