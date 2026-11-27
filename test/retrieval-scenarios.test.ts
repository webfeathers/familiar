/**
 * Does a briefing carry only what the task needs?
 *
 * The claim under test: get_context on a project returns the project, not the
 * private lives of everyone on it, and get_context on a teammate (the read
 * before writing them an email) returns the teammate, not every detail of
 * every project they touch. Both used to fail the same way: a neighbour's
 * durable attribute scores (0.95 + 0.6 + 0.5) × 0.45 ≈ 0.92, comfortably over
 * the 0.55 floor, so the one-hop ring filled every spare slot with facts that
 * were about the neighbour and had nothing to do with the subject.
 *
 * All fixtures are synthetic. The world is a small team: an owner who manages
 * four people, two projects that share two of them, and a customer.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const url = process.env.TEST_DATABASE_URL

describe('retrieval scenarios: only what the task needs', { skip: !url && 'TEST_DATABASE_URL is not set' }, async () => {
  if (!url) return
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.pathname.includes('test'),
    'TEST_DATABASE_URL must name a loopback-only test database')
  process.env.NODE_ENV = 'test'
  delete process.env.DATABASE_PUBLIC_URL
  process.env.DATABASE_URL = url
  const tag = randomUUID().slice(0, 6)
  process.env.PCL_SELF = `Scenario Owner ${tag}`
  const { db, pool, entities, observations, links } = await import('../src/store/index.ts')
  const { inArray } = await import('drizzle-orm')
  const { assembleContext, formatBundle, mentionPattern, subjectNames } = await import('../src/retrieval/index.ts')
  const { sql } = await import('drizzle-orm')
  const { selfEntity } = await import('../src/store/preferences.ts')

  const ids: string[] = []
  const DAY = 86_400_000
  const now = Date.now()
  type Cat = 'attribute' | 'state' | 'event' | 'preference' | 'anticipation'

  async function entity(type: string, name: string, summary?: string) {
    const [row] = await db.insert(entities).values({ type, canonicalName: name, summary }).returning()
    ids.push(row!.id)
    return row!
  }
  async function facts(entityId: string, rows: [string, Cat?, number?][]) {
    await db.insert(observations).values(rows.map(([statement, category = 'attribute', ageDays = 10]) => ({
      entityId, statement, category, confidence: 0.95, validFrom: new Date(now - ageDays * DAY),
    })))
  }
  async function link(from: string, relation: string, to: string) {
    await db.insert(links).values({ fromEntity: from, toEntity: to, relation, confidence: 0.9, validFrom: new Date(now - 30 * DAY) })
  }

  // ── The world ─────────────────────────────────────────────────────────────
  const owner = await selfEntity()
  ids.push(owner.id)
  await db.insert(observations).values(Array.from({ length: 30 }, (_, i) => ({
    entityId: owner.id, statement: `Owner working preference number ${i}`, category: 'preference' as const,
    confidence: 0.85, validFrom: new Date(now - i * DAY),
  })))

  const atlas = await entity('project', `Atlas ${tag}`, 'Billing platform migration')
  const beacon = await entity('project', `Beacon ${tag}`, 'Pricing page relaunch')
  const northwind = await entity('org', `Northwind ${tag}`, 'Customer')
  const people = {
    dana: await entity('person', `Dana Whitfield ${tag}`, 'Staff engineer'),
    eli: await entity('person', `Eli Moreno ${tag}`, 'Product designer'),
    farah: await entity('person', `Farah Okafor ${tag}`, 'Engineering manager'),
    gus: await entity('person', `Gus Lindqvist ${tag}`, 'Data analyst'),
  }
  const personal = (first: string): [string, Cat?, number?][] => [
    [`${first}'s partner is a nurse`], [`${first} has two kids`], [`${first}'s birthday is in May`],
    [`${first}'s mobile ends in 4412`], [`${first} runs marathons`],
  ]

  const ATLAS_OWN = [
    `${atlas.canonicalName} moves invoicing off the legacy ledger`,
    'Cutover is planned for March 3',
    'Rollback plan is a dual-write window of two weeks',
    'Budget is approved through Q2',
    'The ledger export job is the critical path',
    'Weekly sync is Tuesdays at 10',
    'Status is amber because of the export job',
    'Dana owns the cutover runbook',
  ]
  await facts(atlas.id, ATLAS_OWN.map((s, i) => [s, i === 6 ? 'state' : 'attribute', 3] as [string, Cat, number]))
  const BEACON_OWN = [
    'Beacon launches the new pricing page in April', 'Pricing tiers are Starter, Team and Scale',
    'Copy review is with legal', 'Experiment targets a 5% lift in trial starts',
    'Dana is building the price calculator',
  ]
  await facts(beacon.id, BEACON_OWN.map((s) => [s] as [string]))
  const NORTHWIND_OWN = ['Northwind renews in September', `Northwind signed the ${atlas.canonicalName} statement of work`]
  await facts(northwind.id, NORTHWIND_OWN.map((s) => [s] as [string]))

  const DANA_OWN = [
    'Staff engineer on the platform team', ...personal('Dana').map(([s]) => s),
    `Leads the data migration for ${atlas.canonicalName}`, 'Prefers written updates over calls',
  ]
  await facts(people.dana.id, DANA_OWN.map((s) => [s] as [string]))
  await facts(people.eli.id, [['Product designer'], ...personal('Eli'), [`Joined ${atlas.canonicalName} in June`]])
  await facts(people.farah.id, [['Engineering manager for platform'], ...personal('Farah')])
  await facts(people.gus.id, [['Data analyst'], ...personal('Gus'), ['Owns the Beacon experiment dashboard']])

  for (const p of [people.dana, people.eli, people.farah]) await link(p.id, 'member_of', atlas.id)
  for (const p of [people.dana, people.gus]) await link(p.id, 'member_of', beacon.id)
  await link(atlas.id, 'for_customer', northwind.id)
  for (const p of Object.values(people)) await link(owner.id, 'manages', p.id)
  await link(owner.id, 'sponsors', atlas.id)

  after(async () => {
    await db.delete(entities).where(inArray(entities.id, ids))
    await pool.end()
  })

  /** Statements returned, and which of them the scenario did not ask for. */
  async function read(subject: string, allowed: string[], topic?: string) {
    const b = (await assembleContext(subject, { topic }))!
    const got = [...b.facts, ...b.anticipations].map((f) => f.statement)
    const leaked = got.filter((s) => !allowed.includes(s))
    const missing = allowed.filter((s) => !got.includes(s))
    return { b, got, leaked, missing, text: formatBundle(b) }
  }

  test('a project briefing carries the project, not its team members\' private lives', async () => {
    const allowed = [
      ...ATLAS_OWN,
      `Leads the data migration for ${atlas.canonicalName}`,
      `Joined ${atlas.canonicalName} in June`,
      `Northwind signed the ${atlas.canonicalName} statement of work`,
    ]
    const r = await read(atlas.canonicalName, allowed)
    assert.deepEqual(r.leaked, [], `leaked into the Atlas briefing:\n${r.leaked.join('\n')}`)
    assert.deepEqual(r.missing, [])
    // Who is on it still shows, as one line per person, without their facts.
    assert.match(r.text, /Dana Whitfield .* → member_of →/)
    assert.match(r.text, /Staff engineer/)
  })

  test('a teammate briefing (before an email) carries the teammate, not their projects\' details', async () => {
    const allowed = [...DANA_OWN, 'Dana owns the cutover runbook', 'Dana is building the price calculator']
    const r = await read(people.dana.canonicalName, allowed)
    assert.deepEqual(r.leaked, [], `leaked into the Dana briefing:\n${r.leaked.join('\n')}`)
    assert.deepEqual(r.missing, [])
    assert.ok(!r.got.some((s) => s.startsWith('Owner working preference')), 'how_i_work already carries these')
  })

  test('a topic opens the neighbours back up, to that topic only', async () => {
    const r = await read(people.dana.canonicalName, ['Dana owns the cutover runbook', 'Cutover is planned for March 3'], 'cutover')
    assert.deepEqual(r.leaked, [])
    assert.deepEqual(r.missing, [])
  })

  test('the owner\'s own briefing still returns the owner\'s facts', async () => {
    const b = (await assembleContext(owner.canonicalName))!
    assert.ok(b.facts.length > 0)
    assert.ok(b.facts.every((f) => f.via === null))
  })

  test('a mention is a whole word, and a name ending in punctuation still matches', async () => {
    assert.deepEqual(subjectNames({ type: 'person', canonicalName: 'Dana Whitfield', aliases: ['DW'] }), ['Dana Whitfield', 'DW', 'Dana'])
    assert.deepEqual(subjectNames({ type: 'person', canonicalName: 'Al Gore', aliases: [] }), ['Al Gore'])
    assert.deepEqual(subjectNames({ type: 'project', canonicalName: 'Project Atlas', aliases: ['Atlas'] }), ['Project Atlas', 'Atlas'])
    const hit = async (text: string, names: string[]) =>
      (await db.execute(sql`select ${text} ~* ${mentionPattern(names)} as m`)).rows[0]!.m
    assert.equal(await hit('Moved the Atlas cutover', ['Atlas']), true)
    assert.equal(await hit('Files tickets in Atlassian', ['Atlas']), false)
    assert.equal(await hit('Chairs the C++ guild', ['C++']), true)
    assert.equal(await hit('Costs $5 (approx.)', ['(approx.)']), true)
  })

  test('latency: a briefing over a large graph stays fast', async () => {
    // A hub with 12 heavy neighbours, every one past the candidate ceiling.
    const hub = await entity('project', `Hub ${tag}`)
    await facts(hub.id, Array.from({ length: 1500 }, (_, i) => [`Hub fact ${i}`, 'attribute', i % 400] as [string, Cat, number]))
    for (let n = 0; n < 12; n++) {
      const nb = await entity('person', `Neighbour ${n} ${tag}`)
      await facts(nb.id, Array.from({ length: 400 }, (_, i) =>
        [i % 50 === 0 ? `Works on Hub ${tag} item ${i}` : `Neighbour ${n} fact ${i}`, 'attribute', i % 300] as [string, Cat, number]))
      await link(nb.id, 'member_of', hub.id)
    }
    for (let i = 0; i < 5; i++) await assembleContext(hub.canonicalName) // warm
    const times: number[] = []
    for (let i = 0; i < 40; i++) {
      const t = performance.now()
      await assembleContext(hub.canonicalName)
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    const p50 = times[20]!, p95 = times[38]!
    console.log(`get_context latency over 6,300 facts: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`)
    assert.ok(p95 < 250, `p95 ${p95.toFixed(1)} ms`)
  })
})
