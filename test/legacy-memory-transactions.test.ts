import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.TEST_DATABASE_URL

describe('session writes serialize per entity', { skip: !url }, async () => {
  if (!url) return
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.includes('test')) {
    throw new Error('Only a local test database is allowed')
  }
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = url
  process.env.PCL_SELF = `Preference race ${randomUUID()}`
  const { db, pool, entities, observations } = await import('../src/store/index.ts')
  const { rememberFact } = await import('../src/store/remember.ts')
  const { mergeEntities } = await import('../src/store/merge.ts')
  const { notePreference, selfEntity } = await import('../src/store/preferences.ts')
  const { eq, inArray } = await import('drizzle-orm')
  const entityIds: string[] = []
  async function entity() {
    const [row] = await db.insert(entities).values({ type: 'person', canonicalName: `Race ${randomUUID()}` }).returning()
    entityIds.push(row!.id)
    return row!
  }
  after(async () => {
    if (entityIds.length) await db.delete(entities).where(inArray(entities.id, entityIds))
    await pool.end()
  })
  test('wrong-entity or stale correction IDs reject without inserting', async () => {
    const a = await entity(), b = await entity()
    const old = await rememberFact({ entityId: a.id, statement: 'Works in Paris', category: 'state' })
    await assert.rejects(rememberFact({ entityId: b.id, statement: 'Works in London', category: 'state', supersedes: [old.created.id] }))
    assert.equal((await db.select().from(observations).where(eq(observations.entityId, b.id))).length, 0)
    const replacement = await rememberFact({ entityId: a.id, statement: 'Works in Berlin', category: 'state', supersedes: [old.created.id] })
    await assert.rejects(rememberFact({ entityId: a.id, statement: 'Works in Rome', category: 'state', supersedes: [old.created.id] }))
    const rows = await db.select().from(observations).where(eq(observations.entityId, a.id))
    assert.equal(rows.length, 2)
    assert.equal(rows.find(r => r.id === old.created.id)!.invalidatedBy, replacement.created.id)
  })
  test('concurrent corrections cannot both retire the same target', async () => {
    const a = await entity()
    const old = await rememberFact({ entityId: a.id, statement: 'Owns the old project', category: 'attribute' })
    const results = await Promise.allSettled(['Owns Project Alpha', 'Owns Project Beta'].map(statement =>
      rememberFact({ entityId: a.id, statement, category: 'attribute', supersedes: [old.created.id] })))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const rows = await db.select().from(observations).where(eq(observations.entityId, a.id))
    assert.equal(rows.length, 2)
  })
  test('merge and remember serialize, never leaving a fact on the merged loser', async () => {
    const loser = await entity(), winner = await entity()
    await Promise.allSettled([
      mergeEntities(loser.id, winner.id),
      rememberFact({ entityId: loser.id, statement: 'Owns a project', category: 'attribute' }),
    ])
    const [row] = await db.select().from(entities).where(eq(entities.id, loser.id))
    assert.equal(row!.mergedInto, winner.id)
    assert.equal((await db.select().from(observations).where(eq(observations.entityId, loser.id))).length, 0)
    await assert.rejects(mergeEntities(loser.id, winner.id), /already merged/)
    await assert.rejects(rememberFact({ entityId: loser.id, statement: 'Must fail', category: 'attribute' }), /already merged/)
  })
  test('invalid preference correction rolls back reinforcement count', async () => {
    const self = await selfEntity(); entityIds.push(self.id)
    const recorded = await notePreference({ statement: 'Prefers short precise replies' })
    assert.equal(recorded.action, 'recorded')
    if (recorded.action !== 'recorded') return
    await assert.rejects(notePreference({ statement: recorded.statement, supersedes: [randomUUID()] }))
    const [row] = await db.select().from(observations).where(eq(observations.id, recorded.id))
    assert.equal(row!.observationCount, 1)
  })
})
