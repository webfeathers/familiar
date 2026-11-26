/**
 * The worker. Runs ingestion on cron, when nobody is in a session, so `brief`,
 * `upcoming` and `search` read a store that is already current, and runs the
 * daily retention sweep.
 *
 * No model runs here. The shadow deriver that used to share this process was
 * removed on 2026-11-21: in two months it rejected every episode it saw and
 * nothing it produced ever reached memory.
 *
 * No public port. Schedules live here, not in code sprinkled across connectors.
 */
import { boss, QUEUES } from './queue.ts'
import { connectors, runSync } from '../ingest/index.ts'
import { pruneAuthState } from '../store/retention.ts'
import { retireStalePreferences } from '../store/preferences.ts'
import { applyMigrations } from '../store/migrate.ts'

/**
 * Cadences are a property of the SOURCE, not a tuning knob:
 *  - Calendars change through the day, and `upcoming` is the headline read.
 *
 * A source gets an entry here only once a connector implements it. Scheduling
 * iterates `connectors`, so an entry without one is config that reads as wired
 * and never fires.
 */
const SCHEDULES: Record<string, string> = {
  gcal_work: '*/15 * * * *', // every 15 minutes
  // Contacts change rarely and are the identity backbone, not a feed.
  google_contacts: '23 5 * * *', // daily, 05:23
}

/**
 * Left behind in pg-boss by removed features. pg-boss keeps firing a schedule
 * and keeps a queue's jobs until told otherwise, so a deploy that only deletes
 * the code would leave a daily Gmail job with no connector and a five-minute
 * scan with no worker. Safe to delete this block once one deploy has run it.
 */
const RETIRED_QUEUES = ['derive-work-shadow-v1', 'derive-scan']
const RETIRED_SYNC_KEYS = ['gmail']

async function main() {
  // Pending migrations first, so the schema matches the code that just
  // deployed. A failure is logged and the worker carries on against the schema
  // it has: every migration so far is additive, and ingestion stopping would be
  // the worse outcome.
  try {
    await applyMigrations()
    console.log('migrations: up to date')
  } catch (e) {
    console.error('migrations FAILED; continuing on the existing schema:', e)
  }

  await boss.start()

  await boss.createQueue(QUEUES.sync)

  for (const key of RETIRED_SYNC_KEYS) await boss.unschedule(QUEUES.sync, key)
  for (const name of RETIRED_QUEUES) {
    try {
      await boss.unschedule(name)
      await boss.deleteQueue(name)
    } catch (e) {
      console.warn(`retired queue ${name} not removed: ${e instanceof Error ? e.message : e}`)
    }
  }

  await boss.work<{ source: string }>(QUEUES.sync, async ([job]) => {
    if (!job) return
    const connector = connectors.find((c) => c.source === job.data.source)
    if (!connector) {
      console.warn(`no connector registered for ${job.data.source} — skipping`)
      return
    }
    const r = await runSync(connector)
    if (r.error) {
      console.error(`sync ${r.source} FAILED: ${r.error}`)
      throw new Error(r.error) // let pg-boss retry
    }
    console.log(
      `sync ${r.source}: fetched=${r.fetched} inserted=${r.inserted} updated=${r.updated}`,
    )
  })

  // pg-boss keys a schedule on (queue, key), and `key` defaults to ''. Every
  // connector scheduled onto QUEUES.sync therefore overwrote the previous one,
  // leaving a single row whose cron and source belonged to whichever connector
  // happened to be last in the array. Production proved it: one ('sync', '')
  // row, cron '23 5 * * *', data { source: 'google_contacts' } — the calendar's
  // 15-minute cadence had been silently discarded since the first deploy.
  //
  // Drop that legacy keyless row before writing the keyed ones, or it survives
  // as a duplicate firing whichever source was last written into it.
  await boss.unschedule(QUEUES.sync)

  for (const c of connectors) {
    const cron = SCHEDULES[c.source]
    if (!cron) continue
    await boss.schedule(QUEUES.sync, cron, { source: c.source }, { key: c.source })
    console.log(`scheduled ${c.source} — ${cron}`)
  }

  // Dead OAuth rows (replaced refresh tokens, expired codes) accumulate on
  // every token rotation and nothing else deletes them. 04:11 UTC keeps clear
  // of the calendar's quarter-hours and the other syncs' minutes.
  await boss.createQueue(QUEUES.prune)
  await boss.work(QUEUES.prune, async () => {
    const r = await pruneAuthState()
    console.log(`prune: ${r.refreshTokens} refresh tokens, ${r.codes} auth codes`)
    // Same daily sweep: preferences noted once and never seen again. Each id is
    // logged because `restore` needs it and no read tool lists retired rows.
    const stale = await retireStalePreferences()
    for (const p of stale) console.log(`retired stale preference ${p.id}: ${p.statement}`)
    console.log(`prune: ${stale.length} stale preferences retired`)
  })
  await boss.schedule(QUEUES.prune, '11 4 * * *')
  console.log('scheduled prune — 11 4 * * *')

  // Run every connector once at boot so a fresh deploy populates immediately
  // rather than waiting for the first cron tick.
  for (const c of connectors) {
    await boss.send(QUEUES.sync, { source: c.source })
  }

  console.log('worker running')
}

main().catch((e) => {
  console.error('worker failed to start:', e)
  process.exit(1)
})
