/**
 * Google Calendar connector.
 *
 * ONE credential reads BOTH calendars: the personal calendar is shared into the
 * Workspace account, so it simply appears in this account's calendar list. That
 * is why there is no second OAuth app and no second refresh token to expire.
 *
 * Attribution: the account's own primary calendar is work; anything else
 * visible to it is personal. Crude, but correct for this setup and it keeps the
 * `source` attribution honest without a config file.
 *
 * This module does not interpret and never calls an LLM — it returns raw
 * episodes and nothing more.
 */
import type { Connector } from './types.ts'
import type { NewEpisode, Source } from '../store/schema.ts'
import { contentHash } from '../store/repo.ts'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/calendar/v3'

interface GEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { email?: string; displayName?: string; responseStatus?: string; resource?: boolean; self?: boolean }[]
  organizer?: { email?: string; displayName?: string }
  hangoutLink?: string
  recurringEventId?: string
  updated?: string
}

async function accessToken(): Promise<string> {
  const refresh = process.env.GOOGLE_REFRESH_TOKEN_WORK
  if (!refresh) throw new Error('GOOGLE_REFRESH_TOKEN_WORK is not set')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  })
  const body = (await res.json()) as { access_token?: string; error?: string }
  if (!res.ok || !body.access_token) {
    // invalid_grant here is the signature of the External+Testing 7-day
    // revocation. It should not happen on an Internal app — if it does, the
    // Audience setting has been changed.
    throw new Error(`Google token refresh failed: ${body.error ?? res.status}`)
  }
  return body.access_token
}

async function listCalendars(token: string) {
  const out: { id: string; primary: boolean; summary: string }[] = []
  let pageToken: string | undefined
  do {
    const u = new URL(`${API}/users/me/calendarList`)
    u.searchParams.set('minAccessRole', 'reader')
    if (pageToken) u.searchParams.set('pageToken', pageToken)
    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`calendarList failed: ${res.status}`)
    const body = (await res.json()) as {
      items?: { id: string; primary?: boolean; summary?: string }[]
      nextPageToken?: string
    }
    for (const c of body.items ?? []) {
      out.push({ id: c.id, primary: c.primary === true, summary: c.summary ?? c.id })
    }
    pageToken = body.nextPageToken
  } while (pageToken)
  return out
}

/**
 * Google rejects an `updatedMin` older than roughly a month with
 * `410 updatedMinTooLongAgo` — it is not a filter that degrades gracefully.
 *
 * So there are two modes, and the distinction is real rather than an
 * optimisation:
 *  - INCREMENTAL (recent watermark): filter by `updatedMin`, and ask for
 *    deletion tombstones, which are retained over a similar window.
 *  - COLD START (no watermark, or an old one): omit `updatedMin` entirely and
 *    let `timeMin`/`timeMax` bound the fetch. Nothing has been ingested yet, so
 *    there are no deletions of ours to reconcile.
 */
const UPDATED_MIN_MAX_AGE_DAYS = 25

async function listEvents(token: string, calendarId: string, since: Date) {
  const out: GEvent[] = []
  const incremental =
    Date.now() - since.getTime() < UPDATED_MIN_MAX_AGE_DAYS * 86400_000
  let pageToken: string | undefined

  do {
    const u = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}/events`)
    // singleEvents expands recurrence into concrete instances — we want the
    // occurrences that actually sit on the calendar, not the rule.
    u.searchParams.set('singleEvents', 'true')
    u.searchParams.set('maxResults', '250')
    // A generous forward window: upcoming() is the headline use case.
    u.searchParams.set('timeMin', new Date(Date.now() - 90 * 86400_000).toISOString())
    u.searchParams.set('timeMax', new Date(Date.now() + 365 * 86400_000).toISOString())
    if (incremental) {
      u.searchParams.set('updatedMin', since.toISOString())
      u.searchParams.set('showDeleted', 'true')
    } else {
      // orderBy=startTime is incompatible with showDeleted (cancelled
      // instances have no start), so it only applies on the cold path.
      u.searchParams.set('orderBy', 'startTime')
    }
    if (pageToken) u.searchParams.set('pageToken', pageToken)

    const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(
        `events failed for ${calendarId}: ${res.status} ${detail.slice(0, 200)}`,
      )
    }
    const body = (await res.json()) as { items?: GEvent[]; nextPageToken?: string }
    out.push(...(body.items ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)
  return out
}

function toEpisode(e: GEvent, source: Source, calendarId: string): NewEpisode | null {
  const startsAt = e.start?.dateTime ?? e.start?.date
  if (!startsAt) return null

  const body = {
    summary: e.summary ?? '(no title)',
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    organizer: e.organizer,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.displayName,
      response: a.responseStatus,
      resource: a.resource,
      // Google marks the calendar owner's own attendee row; the brief skips it.
      self: a.self,
    })),
    conference: e.hangoutLink,
    status: e.status,
    recurringEventId: e.recurringEventId,
    calendarId,
  }

  return {
    source,
    // Calendar id is part of the ref: the same event can appear on two
    // calendars (organiser's and attendee's) and they are distinct rows.
    sourceRef: `${calendarId}:${e.id}`,
    kind: 'calendar_event',
    body,
    occurredAt: new Date(startsAt),
    dedupHash: contentHash(body),
  }
}

/**
 * Both calendars come through this one connector, but episodes are attributed
 * to `gcal_work` or `gcal_personal` individually. It is registered under
 * `gcal_work` because that is the credential it authenticates as.
 */
export const googleCalendar: Connector = {
  source: 'gcal_work',

  async sync(since: Date): Promise<NewEpisode[]> {
    const token = await accessToken()
    const calendars = await listCalendars(token)
    const episodes: NewEpisode[] = []

    for (const cal of calendars) {
      // Skip Google's noise calendars — holidays, birthdays, week numbers.
      if (cal.id.endsWith('group.v.calendar.google.com')) continue

      const source: Source = cal.primary ? 'gcal_work' : 'gcal_personal'
      const events = await listEvents(token, cal.id, since)
      for (const e of events) {
        const ep = toEpisode(e, source, cal.id)
        if (ep) episodes.push(ep)
      }
    }
    return episodes
  },
}

/** Exposed for the ops probe so we can list calendars without syncing. */
export async function describeCalendars() {
  const token = await accessToken()
  const cals = await listCalendars(token)
  return cals.map((c) => ({
    id: c.id,
    summary: c.summary,
    attributedTo: c.primary ? 'gcal_work' : 'gcal_personal',
    skipped: c.id.endsWith('group.v.calendar.google.com'),
  }))
}
