/**
 * Resolving a client from its Client ID Metadata Document (CIMD).
 *
 * The client_id IS the URL of a JSON document describing the client, so there
 * is nothing to register and no client table to keep. The cost is that
 * /authorize, which anyone on the internet can call, makes this server fetch a
 * URL of the caller's choosing. Everything here exists to keep that fetch
 * boring:
 *
 *   - https only, on the default port, to a public address. No loopback, no
 *     private ranges, no link-local (cloud metadata lives there).
 *   - Redirects are followed by hand, a few at most, each hop held to the same
 *     rules. `fetch` following them on its own would walk straight past the
 *     address check.
 *   - The body is read up to a small cap and no further.
 *   - Results are cached briefly and new fetches draw on a global budget, so a
 *     flood of made-up client_ids cannot turn this server into a request cannon.
 *
 * The address check resolves the name once and `fetch` resolves it again, so a
 * DNS answer that changes between the two can still slip through. Closing that
 * needs a pinned-address agent; for a document whose only use is a display name
 * and a redirect list, the remaining exposure is a blind GET.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface ResolvedClient {
  name: string
  redirectUris: string[]
}

const MAX_BYTES = 64 * 1024
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 8000
const MAX_NAME_LENGTH = 120
const MAX_REDIRECT_URIS = 50

const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 100
/** New (uncached) documents fetched per minute, across all callers. */
const FETCH_BUDGET_PER_MINUTE = 30

/** Indirection so tests can stub name resolution without touching the network. */
export const net = {
  resolve: async (hostname: string): Promise<string[]> =>
    (await lookup(hostname, { all: true })).map((a) => a.address),
}

function ipv4IsPublic(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || b === 0)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return ipv4IsPublic(ip)
  if (kind !== 6) return false
  const v6 = ip.toLowerCase()
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4IsPublic(mapped[1]!)
  if (v6 === '::' || v6 === '::1') return false
  if (v6.startsWith('::ffff:')) return false // hex-form mapped IPv4
  if (/^f[cd]/.test(v6)) return false // unique local fc00::/7
  if (/^fe[89ab]/.test(v6)) return false // link-local fe80::/10
  if (v6.startsWith('ff')) return false // multicast
  if (v6.startsWith('64:ff9b:')) return false // NAT64 can reach IPv4 space
  return true
}

/** https, default port, no credentials, and every address the name has is public. */
async function isFetchable(url: URL): Promise<boolean> {
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return isPublicAddress(host)
  try {
    const addresses = await net.resolve(host)
    return addresses.length > 0 && addresses.every(isPublicAddress)
  } catch {
    return false
  }
}

async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) return null
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchDocument(clientId: string): Promise<ResolvedClient | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let url = new URL(clientId)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isFetchable(url))) return null
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal,
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => undefined)
      if (!location) return null
      url = new URL(location, url)
      continue
    }
    if (!res.ok) return null

    const text = await readCapped(res)
    if (text === null) return null
    const doc = JSON.parse(text) as { client_name?: unknown; redirect_uris?: unknown }
    if (typeof doc !== 'object' || doc === null) return null

    const name =
      typeof doc.client_name === 'string' && doc.client_name.trim()
        ? doc.client_name.trim().slice(0, MAX_NAME_LENGTH)
        : new URL(clientId).hostname
    const redirectUris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter((u): u is string => typeof u === 'string').slice(0, MAX_REDIRECT_URIS)
      : []
    return { name, redirectUris }
  }
  return null
}

const cache = new Map<string, { at: number; client: ResolvedClient }>()
let budget = { windowStart: 0, used: 0 }

function takeFetchBudget(now: number): boolean {
  if (now - budget.windowStart >= 60_000) budget = { windowStart: now, used: 0 }
  if (budget.used >= FETCH_BUDGET_PER_MINUTE) return false
  budget.used++
  return true
}

/** For tests: forget cached clients and the spent budget. */
export function resetClientCache(): void {
  cache.clear()
  budget = { windowStart: 0, used: 0 }
}

/**
 * Resolve a client by its CIMD URL. Null means "not a client we can identify":
 * a bad URL, an address we will not fetch, an oversized or malformed document,
 * or the fetch budget for this minute being spent.
 */
export async function resolveClient(clientId: string): Promise<ResolvedClient | null> {
  if (clientId.length > 2048) return null
  try {
    if (new URL(clientId).protocol !== 'https:') return null
  } catch {
    return null
  }

  const now = Date.now()
  const hit = cache.get(clientId)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.client

  if (!takeFetchBudget(now)) return null

  let client: ResolvedClient | null
  try {
    client = await fetchDocument(clientId)
  } catch {
    client = null
  }
  if (!client) return null

  // Only real clients are cached, so made-up client_ids cannot evict them.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(clientId, { at: now, client })
  return client
}
