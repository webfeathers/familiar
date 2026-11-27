/**
 * Drives one full sign-in through the real routes: /authorize → /consent →
 * provider → callback. Not a test file itself (the runner only picks up
 * *.test.ts); each provider's test sets its env first, then imports this.
 *
 * Everything external is a fixture: fetch is mocked per test, and the database
 * calls the callback makes are captured instead of executed.
 */
import type { TestContext } from 'node:test'

export const ISSUER = 'https://grimalkin.example'
export const callback = 'https://chatgpt.com/connector_platform_oauth_redirect'
export const clientId = 'https://chatgpt.com/oauth/client.json'

export function baseEnv(extra: Record<string, string>) {
  for (const k of ['AUTH_PROVIDER', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_NAME',
    'OIDC_SCOPES', 'OIDC_TOKEN_AUTH_METHOD', 'DATABASE_PUBLIC_URL']) delete process.env[k]
  Object.assign(process.env, {
    PUBLIC_URL: ISSUER,
    ALLOWED_SUBJECT: 'owner-subject',
    AUTH_SECRET: 'test-only-secret-not-a-production-credential',
    DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/grimalkin_test',
    ...extra,
  })
}

export async function loadServer() {
  const { oauth } = await import('../src/mcp/oauth.ts')
  const clientMetadata = await import('../src/mcp/client-metadata.ts')
  clientMetadata.net.resolve = async () => ['93.184.216.34']
  const { db, pool } = await import('../src/store/index.ts')
  return { oauth, clientMetadata, db, pool }
}

type Server = Awaited<ReturnType<typeof loadServer>>
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

/** Route mocked fetches by URL prefix; anything unrouted fails the test loudly. */
export function serve(t: TestContext, routes: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    const hit = Object.keys(routes).sort((a, b) => b.length - a.length).find((p) => url.startsWith(p))
    if (!hit) throw new Error(`unexpected fetch: ${url}`)
    return routes[hit]!(url, init)
  })
  return calls
}

export const json = (doc: unknown, status = 200) =>
  new Response(JSON.stringify(doc), { status, headers: { 'content-type': 'application/json' } })

export const clientDoc = { [clientId]: () => json({ client_name: 'Fixture', redirect_uris: [callback] }) }

/** Up to the provider redirect: returns where the browser is sent, and its state cookie. */
export async function approve(s: Server) {
  s.clientMetadata.resetClientCache()
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code',
    code_challenge: 'client-pkce-challenge', code_challenge_method: 'S256', state: 'client-state' })
  const page = await s.oauth.request('/authorize?' + q)
  const consentCookie = page.headers.getSetCookie().find((c) => c.startsWith('__Host-pcl-consent='))!.split(';')[0]!
  const pending = (await page.text()).match(/name="pending" value="([^"]+)"/)![1]!
  const res = await s.oauth.request('/consent', { method: 'POST',
    headers: { cookie: consentCookie, origin: ISSUER }, body: new URLSearchParams({ pending }) })
  const stateCookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-pcl-state='))?.split(';')[0]
  return { res, location: res.headers.get('location'), stateCookie }
}

/** The provider's redirect back to us; captures any code row the callback writes. */
export async function returnFrom(t: TestContext, s: Server, path: string, stateCookie: string, query: Record<string, string>) {
  const rows: any[] = []
  t.mock.method(s.db, 'insert', () => ({ values: (row: unknown) => {
    rows.push(row)
    return Object.assign(Promise.resolve(), { onConflictDoNothing: async () => undefined })
  } }) as any)
  const res = await s.oauth.request(`${path}?${new URLSearchParams(query)}`, { headers: { cookie: stateCookie } })
  return { res, rows, codeRow: rows.find((r) => 'codeChallenge' in r) }
}
