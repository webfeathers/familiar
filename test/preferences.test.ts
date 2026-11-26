/**
 * The preference write path, exercised through the real MCP tool surface
 * (client and server over the SDK's in-memory transport) against a real
 * Postgres. No mocks: the defects this guards against lived in how rows are
 * matched, counted and ordered, which a fake store would not reproduce.
 *
 * Run against a MIGRATED scratch database:
 *   TEST_DATABASE_URL=postgresql://user@localhost:5432/familiar_test pnpm test
 *
 * Each run writes under its own freshly named owner entity and deletes it
 * afterwards, so it never touches existing rows. As a second guard it refuses
 * any database that is not local with "test" in its name.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const TEST_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(raw: string) {
  const u = new URL(raw)
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)
  if (!local || !u.pathname.toLowerCase().includes('test')) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL must be a local database with "test" in its name (got ${u.hostname}${u.pathname}).`,
    )
  }
}

describe('preference write path', { skip: TEST_URL ? false : 'TEST_DATABASE_URL is not set' }, async () => {
  if (!TEST_URL) return
  assertSafeTestDatabase(TEST_URL)

  // Point the store at the test database BEFORE it is imported: the pool is
  // created at import time, and outside production runtimeDatabaseUrl() prefers
  // DATABASE_PUBLIC_URL, which could be a real deployment.
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = TEST_URL
  process.env.PCL_SELF = `Test Owner ${randomUUID()}`

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')
  const { selfEntity, SELF_NAME } = await import('../src/store/preferences.ts')
  const { db, pool, entities, observations } = await import('../src/store/index.ts')
  const { and, eq, isNull } = await import('drizzle-orm')

  const client = new Client({ name: 'test', version: '0' })
  let selfId = ''

  before(async () => {
    const server = new McpServer({ name: 'familiar-test', version: '0' })
    registerTools(server, 'context:read context:write')
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    await client.connect(clientSide)
    selfId = (await selfEntity()).id
  })

  after(async () => {
    await db.delete(entities).where(eq(entities.canonicalName, SELF_NAME)) // cascades to observations
    await client.close()
    await pool.end()
  })

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await client.callTool({ name, arguments: args })
    const first = (r.content as { type: string; text: string }[])[0]
    return first?.text ?? ''
  }

  /** Live preference rows about the test owner, read straight from the table. */
  async function prefs() {
    return db
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.entityId, selfId),
          eq(observations.category, 'preference'),
          isNull(observations.invalidatedAt),
        ),
      )
  }

  const byStatement = async (s: string) => (await prefs()).filter((p) => p.statement === s)

  test('a restatement is counted, and how_i_work shows the real count', async () => {
    const s = 'prefers conclusions before the reasoning behind them'
    await call('note_preference', { statement: s })
    await call('note_preference', { statement: s })

    const rows = await byStatement(s)
    assert.equal(rows.length, 1, 'restatement must reinforce, not duplicate')
    assert.equal(rows[0]!.observationCount, 2)

    const style = await call('how_i_work', {})
    const line = style.split('\n').find((l) => l.startsWith(`- ${s}  `))
    assert.ok(line, 'preference is listed')
    assert.match(line, /seen 2×/, 'the count must be visible, not pinned at 1')
  })

  test('each how_i_work line carries its date and the id that reinforces takes', async () => {
    const s = 'wants abbreviations expanded the first time they are used'
    await call('note_preference', { statement: s })
    const [row] = await byStatement(s)
    const style = await call('how_i_work', {})
    const line = style.split('\n').find((l) => l.startsWith(`- ${s}  `))
    assert.ok(line)
    assert.match(line, new RegExp(`since ${row!.validFrom.toISOString().slice(0, 10)}`))
    assert.match(line, new RegExp(`id ${row!.id.slice(0, 8)}`))
  })

  test('reinforces by id merges a reworded restatement instead of duplicating it', async () => {
    // The pair from the 2026-09-10 test: same meaning, new words, similarity 0.14.
    const original =
      'wants a preference written generally enough that a later session can re-observe it, rather than tied to the one incident that prompted it'
    const reworded =
      'prefers memory entries phrased broadly enough to recur in future sessions, instead of anchored to the specific incident that triggered them'
    await call('note_preference', { statement: original })
    const [row] = await byStatement(original)

    await call('note_preference', { statement: reworded, reinforces: row!.id.slice(0, 8) })

    assert.equal((await byStatement(reworded)).length, 0, 'the reworded copy must not be recorded')
    const [after] = await byStatement(original)
    assert.equal(after!.observationCount, 2)
    assert.ok(Math.abs(after!.confidence - 0.67) < 1e-6)
  })

  test('without an id, a wording match reinforces the BEST match, not the first', async () => {
    // Token sets built so both clear the 0.55 threshold against the statement,
    // with the weaker one inserted first.
    const statement = 'alpha bravo charlie delta echo foxtrot golf hotel'
    const weaker = 'alpha bravo charlie delta echo foxtrot juliet kilo' // 6/10 = 0.60
    const stronger = 'alpha bravo charlie delta echo foxtrot golf hotel india' // 8/9 = 0.89
    const base = { entityId: selfId, category: 'preference' as const, confidence: 0.55, validFrom: new Date() }
    await db.insert(observations).values({ ...base, statement: weaker })
    await db.insert(observations).values({ ...base, statement: stronger })

    await call('note_preference', { statement })

    const [w] = await byStatement(weaker)
    const [s] = await byStatement(stronger)
    assert.ok(Math.abs(s!.confidence - 0.67) < 1e-6, 'the strongest match is reinforced')
    assert.ok(Math.abs(w!.confidence - 0.55) < 1e-6, 'a weaker match that happens to come first is left alone')
  })

  test('remember with category preference about the owner goes through the same merge', async () => {
    const s = 'prefers a paste-ready command over a summary of one'
    await call('remember', { about: SELF_NAME, category: 'preference', statement: s })
    let rows = await byStatement(s)
    assert.equal(rows.length, 1)
    assert.ok(Math.abs(rows[0]!.confidence - 0.55) < 1e-6, 'starts tentative like any preference, not at 0.95')

    await call('remember', { about: SELF_NAME, category: 'preference', statement: s })
    rows = await byStatement(s)
    assert.equal(rows.length, 1, 'a second remember reinforces instead of adding a twin')
    assert.equal(rows[0]!.observationCount, 2)
  })

  test('a reinforces id that matches nothing records nothing', async () => {
    const s = 'this should never be written'
    await call('note_preference', { statement: s, reinforces: 'deadbeef-not-a-real-id' })
    assert.equal((await byStatement(s)).length, 0)
  })

  test('concurrent reinforcements are all counted', async () => {
    const s = 'wants status answered from the live system rather than memory'
    await call('note_preference', { statement: s })
    await Promise.all(Array.from({ length: 5 }, () => call('note_preference', { statement: s })))
    const rows = await byStatement(s)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.observationCount, 6, 'every one of the five concurrent reinforcements lands')
  })
})

