/**
 * Google Contacts connector.
 *
 * This is the entity-resolution backbone rather than a source of events. A
 * calendar tells you someone called "Anton" exists; contacts tell you Anton Xu
 * works at Sonora, uses these two addresses, and is filed under a group. That
 * ground truth is what lets the resolver merge the same person seen across
 * calendar, finance and email instead of spawning a new entity per surface form.
 *
 * Small and quiet by comparison with the calendars — hundreds of records that
 * change rarely, so it syncs daily.
 *
 * Like every connector it produces raw episodes and does not interpret. The
 * deriver used to turn these into entities; since its removal (2026-09-10)
 * they are stored and searchable, and new contacts no longer become entities
 * on their own.
 */
import type { Connector } from './types.ts'
import type { NewEpisode } from '../store/schema.ts'
import { contentHash } from '../store/repo.ts'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://people.googleapis.com/v1'

/** Only what helps identify a person. Deliberately not everything available. */
const PERSON_FIELDS = [
  'names',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'relations',
  'biographies',
  'memberships',
  'metadata',
].join(',')

interface GPerson {
  resourceName: string
  names?: { displayName?: string; givenName?: string; familyName?: string }[]
  emailAddresses?: { value?: string; type?: string }[]
  phoneNumbers?: { value?: string; type?: string }[]
  organizations?: { name?: string; title?: string; department?: string }[]
  relations?: { person?: string; type?: string }[]
  biographies?: { value?: string }[]
  metadata?: { sources?: { updateTime?: string }[] }
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
    throw new Error(`Google token refresh failed: ${body.error ?? res.status}`)
  }
  return body.access_token
}

function toEpisode(p: GPerson): NewEpisode | null {
  const name = p.names?.[0]?.displayName?.trim()
  const emails = (p.emailAddresses ?? []).map((e) => e.value).filter(Boolean)

  // A record with neither a name nor an address identifies nobody.
  if (!name && !emails.length) return null

  const body = {
    name,
    givenName: p.names?.[0]?.givenName,
    familyName: p.names?.[0]?.familyName,
    emails,
    phones: (p.phoneNumbers ?? []).map((n) => n.value).filter(Boolean),
    organizations: (p.organizations ?? []).map((o) => ({
      name: o.name,
      title: o.title,
      department: o.department,
    })),
    // Google's own relation labels ("spouse", "child") when the user set them —
    // ground truth the deriver would otherwise have to guess at.
    relations: (p.relations ?? []).map((r) => ({ person: r.person, type: r.type })),
    notes: p.biographies?.[0]?.value,
  }

  const updated = p.metadata?.sources?.[0]?.updateTime
  return {
    source: 'google_contacts',
    sourceRef: p.resourceName,
    kind: 'contact',
    body,
    // Contacts are not events; the update time is the only meaningful instant.
    occurredAt: updated ? new Date(updated) : new Date(),
    dedupHash: contentHash(body),
  }
}

export const googleContacts: Connector = {
  source: 'google_contacts',

  async sync(): Promise<NewEpisode[]> {
    const token = await accessToken()
    const out: NewEpisode[] = []
    let pageToken: string | undefined

    do {
      const u = new URL(`${API}/people/me/connections`)
      u.searchParams.set('personFields', PERSON_FIELDS)
      u.searchParams.set('pageSize', '500')
      // No incremental filter: the People API's syncToken machinery is more
      // fragile than simply re-reading a few hundred records once a day, and
      // upserts key on (source, source_ref) so a full pass is idempotent.
      if (pageToken) u.searchParams.set('pageToken', pageToken)

      const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        // A 403 has two very different causes and guessing wrong sends you
        // chasing the wrong fix — distinguish them from the message body.
        let hint = ''
        if (res.status === 403) {
          hint = /has not been used in project|is disabled/i.test(detail)
            ? ' — the People API is not enabled for this GCP project (separate from the OAuth scope); enable it in the API Library'
            : ' — the refresh token likely predates the contacts.readonly scope; re-mint it'
        }
        throw new Error(`contacts failed: ${res.status} ${detail.slice(0, 200)}${hint}`)
      }
      const body = (await res.json()) as {
        connections?: GPerson[]
        nextPageToken?: string
      }
      for (const p of body.connections ?? []) {
        const ep = toEpisode(p)
        if (ep) out.push(ep)
      }
      pageToken = body.nextPageToken
    } while (pageToken)

    return out
  },
}
