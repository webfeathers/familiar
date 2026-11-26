/**
 * Connector registry and the sync runner.
 *
 * The runner owns the watermark discipline: read the last position, ask the
 * connector for everything since, upsert idempotently, then advance. Because
 * upserts key on (source, source_ref), an overlapping window is harmless — so
 * we deliberately rewind slightly on every run rather than risk a gap.
 */
import type { Connector } from './types.ts'
import type { Source } from '../store/schema.ts'
import { getSyncState, setSyncState, upsertEpisodes } from '../store/repo.ts'
import { googleCalendar } from './google-calendar.ts'
import { googleContacts } from './google-contacts.ts'

export const connectors: Connector[] = [googleCalendar, googleContacts]

/** How far back to start when a source has never synced. */
const COLD_START_DAYS = 90

/**
 * Overlap re-fetched on every run. Cheap insurance against clock skew and
 * events updated moments before the previous run's cutoff.
 */
const OVERLAP_MINUTES = 10

export interface SyncResult {
  source: Source
  fetched: number
  inserted: number
  updated: number
  changedEpisodeIds: string[]
  error?: string
}

export async function runSync(connector: Connector): Promise<SyncResult> {
  const state = await getSyncState(connector.source)
  const since = state?.lastSyncedAt
    ? new Date(state.lastSyncedAt.getTime() - OVERLAP_MINUTES * 60_000)
    : new Date(Date.now() - COLD_START_DAYS * 86400_000)

  // Stamp the watermark from BEFORE the fetch. Anything modified while the
  // fetch is in flight is then picked up next run instead of being skipped.
  const startedAt = new Date()

  try {
    const rows = await connector.sync(since)
    const { inserted, updated, changedEpisodeIds } = await upsertEpisodes(rows)
    await setSyncState(connector.source, {
      lastSyncedAt: startedAt,
      lastError: null,
    })
    return {
      source: connector.source,
      fetched: rows.length,
      inserted,
      updated,
      changedEpisodeIds,
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    // Do NOT advance the watermark on failure — the next run must retry the
    // same window rather than skip past it.
    await setSyncState(connector.source, { lastError: error })
    return {
      source: connector.source,
      fetched: 0,
      inserted: 0,
      updated: 0,
      changedEpisodeIds: [],
      error,
    }
  }
}

export async function runAllSyncs(): Promise<SyncResult[]> {
  const results: SyncResult[] = []
  for (const c of connectors) results.push(await runSync(c))
  return results
}
