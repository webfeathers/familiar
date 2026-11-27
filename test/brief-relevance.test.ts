/**
 * The brief's "Worth a look" is about who you are seeing, not the whole store.
 *
 * Before: the ten most confident anticipations anywhere, so a quiet day with a
 * single meeting still listed guesses about people nowhere near the calendar.
 * Synthetic fixtures only.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.TEST_DATABASE_URL

describe('brief relevance', { skip: !url && 'TEST_DATABASE_URL is not set' }, async () => {
  if (!url) return
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.pathname.includes('test'),
    'TEST_DATABASE_URL must name a loopback-only test database')
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = url
  const tag = randomUUID().slice(0, 6)
  process.env.PCL_SELF = `Brief Owner ${tag}`
  const { db, pool, entities, observations, episodes } = await import('../src/store/index.ts')
  const { inArray } = await import('drizzle-orm')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')

  const server = new McpServer({ name: 'brief-test', version: '0' })
  const client = new Client({ name: 'brief-test', version: '0' })
  registerTools(server, 'context:read', 'fixture-owner')
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  await client.connect(clientSide)

  const now = Date.now()
  const ids: string[] = []
  const episodeIds: string[] = []
  const person = async (name: string) => {
    const [row] = await db.insert(entities).values({ type: 'person', canonicalName: name }).returning()
    ids.push(row!.id)
    return row!
  }
  const guess = (entityId: string, statement: string, confidence: number) => ({
    entityId, statement, category: 'anticipation' as const, confidence,
    validFrom: new Date(now - 3_600_000), validTo: new Date(now + 7 * 86_400_000),
  })

  const priya = await person(`Priya Raman ${tag}`)
  await db.insert(observations).values([
    guess(priya.id, 'Likely to ask about the Q3 renewal numbers', 0.6),
    { entityId: priya.id, statement: 'VP Finance at the customer', category: 'attribute', confidence: 0.95, validFrom: new Date(now - 86_400_000) },
  ])
  // Six strangers with more confident guesses than Priya's.
  for (let i = 0; i < 6; i++) {
    const p = await person(`Stranger ${i} ${tag}`)
    await db.insert(observations).values(guess(p.id, `Stranger ${i} may change jobs`, 0.9))
  }
  const [ep] = await db.insert(episodes).values({
    source: 'gcal_work', sourceRef: `brief-${tag}`, kind: 'event', dedupHash: `brief-${tag}`,
    occurredAt: new Date(now + 2 * 3_600_000),
    body: { summary: 'Renewal review', attendees: [{ name: priya.canonicalName, email: `priya-${tag}@example.test` }] },
  }).returning()
  episodeIds.push(ep!.id)

  after(async () => {
    await client.close(); await server.close()
    await db.delete(episodes).where(inArray(episodes.id, episodeIds))
    await db.delete(entities).where(inArray(entities.id, ids))
    await pool.end()
  })

  test('inferences about the day\'s attendees lead, and the rest of the store is capped', async () => {
    const res = await client.callTool({ name: 'brief', arguments: { hours: 24 } })
    const text = (res.content as { text: string }[]).map((c) => c.text).join('\n')
    const section = text.split('## Worth a look')[1]?.split('\n## ')[0] ?? ''
    const lines = section.split('\n').filter((l) => l.startsWith('- '))
    assert.match(lines[0] ?? '', /Priya Raman .*Q3 renewal/, text)
    assert.ok(lines.filter((l) => l.includes('Stranger')).length <= 3, section)
    assert.match(text, /Renewal review\n\s+with: Priya Raman .* — VP Finance/)
  })
})
