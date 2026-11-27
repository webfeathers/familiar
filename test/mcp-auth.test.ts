import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SCOPE, normalizeScope, writeDenied } from '../src/mcp/scopes.ts'

// All auth/store dependencies use inert fixtures; no real login or database.
process.env.PUBLIC_URL = 'https://familiar.example'
process.env.ALLOWED_SUBJECT = 'test-owner'
process.env.GOOGLE_CLIENT_ID = 'test-client'
process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
process.env.AUTH_SECRET = 'test-only-secret-not-a-production-credential'
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:1/familiar_test'
delete process.env.DATABASE_PUBLIC_URL
const { isAllowedRedirect } = await import('../src/mcp/config.ts')
const { oauth } = await import('../src/mcp/oauth.ts')
const clientMetadata = await import('../src/mcp/client-metadata.ts')
// Name resolution is stubbed for the whole file: no test here touches the network.
clientMetadata.net.resolve = async () => ['93.184.216.34']
const { issueAccessToken, verifyAccessToken } = await import('../src/mcp/tokens.ts')
const { db, pool } = await import('../src/store/index.ts')
const { protectedResourceMetadata, authorizationServerMetadata, wwwAuthenticate } = await import('../src/mcp/metadata.ts')
after(() => pool.end())

const callback = 'https://chatgpt.com/connector_platform_oauth_redirect'
const clientId = 'https://chatgpt.com/oauth/client.json'
const authQuery = (scope?: string) => new URLSearchParams({
  client_id: clientId, redirect_uri: callback, response_type: 'code',
  code_challenge: 'test-pkce-challenge', code_challenge_method: 'S256', state: 'test-state',
  ...(scope === undefined ? {} : { scope }),
})

test('exact hosted callbacks and existing ephemeral loopback callbacks', () => {
  for (const uri of [callback, 'https://claude.ai/api/mcp/auth_callback',
    'http://localhost:49152/callback', 'http://127.0.0.1:49152/callback']) assert.ok(isAllowedRedirect(uri), uri)
  for (const uri of [callback + '/', callback + '?x=1', callback + '#fragment',
    'https://chatgpt.com.evil.example/connector_platform_oauth_redirect',
    'http://chatgpt.com/connector_platform_oauth_redirect', 'https://evil.example/callback']) {
    assert.equal(isAllowedRedirect(uri), false, uri)
  }
})

test('discovery, scope parsing and mutation checks agree', () => {
  assert.equal(DEFAULT_SCOPE, 'context:read context:write')
  assert.deepEqual(protectedResourceMetadata.scopes_supported, ['context:read', 'context:write'])
  assert.deepEqual(authorizationServerMetadata.scopes_supported, protectedResourceMetadata.scopes_supported)
  assert.equal(normalizeScope(), DEFAULT_SCOPE)
  assert.equal(normalizeScope('context:write context:read context:read'), DEFAULT_SCOPE)
  for (const scope of ['', 'context:write', 'context:read admin', null]) assert.equal(normalizeScope(scope), null)
  for (const scope of [undefined, '', 'context:read', 'context:write', 'context:read context:writer']) assert.ok(writeDenied(scope)?.isError)
  assert.equal(writeDenied(DEFAULT_SCOPE), null)
})

test('authorization displays the exact requested grant and validates client redirect metadata', async (t) => {
  clientMetadata.resetClientCache()
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    client_name: '<ChatGPT>', redirect_uris: [callback],
  }), { headers: { 'content-type': 'application/json' } }))
  // Legacy consent is deliberately not queried; every authorization shows its grant.
  t.mock.method(db, 'select', () => { throw new Error('must not reuse unscoped consent') })
  const rw = await oauth.request('/authorize?' + authQuery())
  assert.equal(rw.status, 200)
  const html = await rw.text()
  assert.match(html, /&lt;ChatGPT&gt;/)
  assert.match(html, /add and correct remembered facts, forget facts/)
  const read = await oauth.request('/authorize?' + authQuery('context:read'))
  assert.match(await read.text(), /will not be able to change remembered facts/)
  for (const scope of ['', 'context:write', 'context:read unknown']) {
    const res = await oauth.request('/authorize?' + authQuery(scope))
    assert.equal(new URL(res.headers.get('location')!).searchParams.get('error'), 'invalid_scope')
  }
  const missingPkce = authQuery(); missingPkce.delete('code_challenge')
  const bad = await oauth.request('/authorize?' + missingPkce)
  assert.equal(new URL(bad.headers.get('location')!).searchParams.get('error'), 'invalid_request')
  clientMetadata.resetClientCache()
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })))
  const mismatch = await oauth.request('/authorize?' + authQuery())
  assert.equal(new URL(mismatch.headers.get('location')!).searchParams.get('error'), 'invalid_request')
})

test('signed access tokens preserve scope and reject malformed grants/audiences', async () => {
  for (const scope of ['context:read', DEFAULT_SCOPE]) {
    const { token } = await issueAccessToken({ subject: 'test-owner', clientId, scope })
    assert.equal((await verifyAccessToken(token))?.scope, scope)
  }
  for (const scope of ['', 'context:read unknown', 'context:write']) {
    const { token } = await issueAccessToken({ subject: 'test-owner', clientId, scope })
    assert.equal(await verifyAccessToken(token), null)
  }
  assert.equal(await verifyAccessToken('not-a-token'), null)
  const { SignJWT } = await import('jose')
  const wrongAudience = await new SignJWT({ scope: DEFAULT_SCOPE, client_id: clientId })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('test-owner')
    .setIssuer('https://familiar.example').setAudience('https://other.example/mcp')
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_SECRET))
  assert.equal(await verifyAccessToken(wrongAudience), null)
})

test('refresh cannot upgrade read-only tokens; supported narrowing is retained', async (t) => {
  let storedScope = 'context:read'
  const inserted: any[] = []
  t.mock.method(db, 'select', () => ({ from: () => ({ where: () => ({ limit: async () => [{
    tokenHash: 'fixture', subject: 'test-owner', clientId, scope: storedScope,
  }] }) }) }) as any)
  t.mock.method(db, 'update', () => ({ set: () => ({ where: async () => undefined }) }) as any)
  t.mock.method(db, 'insert', () => ({ values: async (row: unknown) => { inserted.push(row) } }) as any)
  const refresh = (scope?: string) => oauth.request('/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
      refresh_token: 'fixture', ...(scope === undefined ? {} : { scope }) }),
  })
  const original = await refresh()
  assert.equal(original.status, 200)
  assert.equal((await original.json()).scope, 'context:read')
  assert.equal(inserted[0].scope, 'context:read')
  const count = inserted.length
  const upgrade = await refresh(DEFAULT_SCOPE)
  assert.equal(upgrade.status, 400)
  assert.equal(inserted.length, count)
  const invalid = await refresh('context:read unknown')
  assert.equal((await invalid.json()).error, 'invalid_scope')
  storedScope = DEFAULT_SCOPE
  const narrowed = await refresh('context:read')
  assert.equal((await narrowed.json()).scope, 'context:read')
  assert.equal(inserted.at(-1).scope, 'context:read')
  storedScope = 'context:read unknown'
  assert.equal((await refresh()).status, 400)
})

test('real MCP mutation handlers reject read-only access before any database write', async (t) => {
  t.mock.method(db, 'select', () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) as any)
  const mutations = ['insert', 'update', 'delete', 'transaction', 'execute'].map(method =>
    t.mock.method(db, method as 'insert', () => { throw new Error('read-only access must not mutate') }))
  const insert = mutations[0]!
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')
  const server = new McpServer({ name: 'scope-test', version: '0' })
  const client = new Client({ name: 'scope-test', version: '0' })
  const challenge = wwwAuthenticate('insufficient_scope', 'context:write is required')
  registerTools(server, 'context:read', 'fixture-owner', challenge)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide); await client.connect(clientSide)
  try {
    const tools = await client.listTools()
    assert.equal(tools.tools.length, 15)
    const writeTools = new Set(['remember', 'forget', 'note_preference', 'request_memory_write_access',
      'merge_entities', 'update_entity', 'restore', 'retire_link', 'move_facts'])
    for (const tool of tools.tools) {
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: 'oauth2',
        scopes: writeTools.has(tool.name) ? ['context:read', 'context:write'] : ['context:read'] }], tool.name)
    }
    const style = await client.callTool({ name: 'how_i_work', arguments: {} })
    assert.notEqual(style.isError, true)
    assert.equal(insert.mock.callCount(), 0)
    for (const [name, args] of [
      ['remember', { statement: 'fixture', about: 'fixture' }],
      ['forget', { observation_id: '00000000-0000-4000-8000-000000000000' }],
      ['note_preference', { statement: 'fixture' }],
      ['merge_entities', { loser_id: '00000000-0000-4000-8000-000000000000', winner_id: '00000000-0000-4000-8000-000000000001' }],
      ['update_entity', { entity_id: '00000000-0000-4000-8000-000000000000', type: 'org' }],
      ['restore', { observation_id: '00000000-0000-4000-8000-000000000000' }],
      ['move_facts', { observation_ids: ['00000000-0000-4000-8000-000000000000'], to: 'fixture' }],
      ['retire_link', { from_entity_id: '00000000-0000-4000-8000-000000000000', to_entity_id: '00000000-0000-4000-8000-000000000001', relation: 'reports_to' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args })
      assert.equal(result.isError, true, name)
      assert.match(JSON.stringify(result.content), /context:write is required/)
      assert.deepEqual(result._meta?.['mcp/www_authenticate'], [challenge], name)
    }
    for (const method of mutations) assert.equal(method.mock.callCount(), 0)
  } finally { await client.close(); await server.close() }
})

test('code exchange uses the approved scope, preserves PKCE, and rejects invalid stored grants', async (t) => {
  const { createHash } = await import('node:crypto')
  const verifier = 'test-verifier-that-is-not-a-production-secret'
  let storedScope = 'context:read'
  t.mock.method(db, 'select', () => ({ from: () => ({ where: () => ({ limit: async () => [{
    code: 'test-code', subject: 'test-owner', clientId, scope: storedScope, redirectUri: callback,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  }] }) }) }) as any)
  t.mock.method(db, 'update', () => ({ set: () => ({ where: async () => undefined }) }) as any)
  t.mock.method(db, 'insert', () => ({ values: async () => undefined }) as any)
  const exchange = (codeVerifier = verifier) => oauth.request('/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
      code: 'test-code', code_verifier: codeVerifier, redirect_uri: callback, scope: DEFAULT_SCOPE }),
  })
  const response = await exchange()
  assert.equal(response.status, 200)
  const tokens = await response.json()
  assert.equal(tokens.scope, 'context:read')
  assert.equal((await verifyAccessToken(tokens.access_token))?.scope, 'context:read')
  assert.equal((await exchange('wrong-verifier')).status, 400)
  storedScope = 'context:read unknown'
  assert.equal((await exchange()).status, 400)
})


test('deliberate write-access request challenges or verifies without database or network access', async (t) => {
  const calls = ['select', 'insert', 'update', 'delete', 'transaction', 'execute'].map(method =>
    t.mock.method(db, method as 'insert', () => { throw new Error('permission request must not access database') }))
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('permission request must not send network requests') })
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { registerTools } = await import('../src/mcp/tools.ts')
  const challenge = wwwAuthenticate('insufficient_scope', 'context:write is required')
  assert.match(challenge, /resource_metadata="https:\/\/familiar\.example\/\.well-known\/oauth-protected-resource\/mcp"/)
  assert.match(challenge, /scope="context:read context:write"/)
  for (const scope of ['context:read', DEFAULT_SCOPE]) {
    const server = new McpServer({ name: 'grant-test', version: '0' })
    const client = new Client({ name: 'grant-test', version: '0' })
    registerTools(server, scope, 'fixture-owner via fixture-client', challenge)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b); await client.connect(a)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.callTool({ name: 'request_memory_write_access', arguments: {} })
        if (scope === 'context:read') {
          assert.equal(result.isError, true)
          assert.deepEqual(result._meta?.['mcp/www_authenticate'], [challenge])
          assert.equal(result.structuredContent, undefined)
        } else {
          assert.notEqual(result.isError, true)
          assert.equal(result._meta?.['mcp/www_authenticate'], undefined)
          assert.deepEqual(result.structuredContent, { reporter: 'fixture-owner via fixture-client',
            grantedScopes: ['context:read', 'context:write'], writeScopeGranted: true })
        }
      }
    } finally { await client.close(); await server.close() }
  }
  for (const call of calls) assert.equal(call.mock.callCount(), 0)
  assert.equal(network.mock.callCount(), 0)
})

const consentCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('__Host-pcl-consent='))
const sealedFrom = (html: string) => html.match(/name="pending" value="([^"]+)"/)![1]!

test('consent only counts from the browser that was shown the screen', async (t) => {
  clientMetadata.resetClientCache()
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ client_name: 'Fixture', redirect_uris: [callback] })))
  // Nothing is written until the owner has signed in with Google.
  const writes = ['insert', 'update', 'delete'].map((m) =>
    t.mock.method(db, m as 'insert', () => { throw new Error('consent must not write before sign-in') }))

  const page = await oauth.request('/authorize?' + authQuery())
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  // no-referrer would make the browser send `Origin: null` with the form and fail the check below.
  assert.equal(page.headers.get('referrer-policy'), 'same-origin')
  const setCookie = consentCookie(page)!
  assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /Secure/i); assert.match(setCookie, /SameSite=Strict/i)
  const cookie = setCookie.split(';')[0]!
  const sealed = sealedFrom(await page.text())
  const consent = (headers: Record<string, string>, pending = sealed) =>
    oauth.request('/consent', { method: 'POST', headers, body: new URLSearchParams({ pending }) })

  // A forged cross-site submission: the attacker has a valid signed request (anyone
  // can fetch one) but the victim's browser sends no consent cookie with it.
  assert.equal((await consent({})).status, 403)
  assert.equal((await consent({ cookie: '__Host-pcl-consent=guessed' })).status, 403)
  assert.equal((await consent({ cookie, origin: 'https://evil.example' })).status, 403)
  // A request sealed for another browser does not match this browser's cookie.
  const other = await oauth.request('/authorize?' + authQuery())
  assert.equal((await consent({ cookie }, sealedFrom(await other.text()))).status, 403)
  assert.equal((await consent({ cookie }, 'not-a-signed-request')).status, 400)

  const ok = await consent({ cookie, origin: 'https://familiar.example' })
  assert.equal(ok.status, 302)
  assert.equal(new URL(ok.headers.get('location')!).origin, 'https://accounts.google.com')
  for (const w of writes) assert.equal(w.mock.callCount(), 0)
})

test('revoke kills the presented refresh token and always answers 200', async (t) => {
  const updates: unknown[] = []
  t.mock.method(db, 'update', () => ({ set: (v: unknown) => ({ where: async () => { updates.push(v) } }) }) as any)
  const revoke = (body: Record<string, string>) => oauth.request('/revoke', { method: 'POST', body: new URLSearchParams(body) })
  assert.equal((await revoke({ token: 'fixture-refresh-token' })).status, 200)
  assert.equal(updates.length, 1)
  assert.ok((updates[0] as { replacedAt: Date }).replacedAt instanceof Date)
  assert.equal((await revoke({})).status, 200)
  assert.equal(updates.length, 1)
})

test('tokens for anyone but the owner are refused, and a weak signing secret stops startup', async () => {
  const { token } = await issueAccessToken({ subject: 'someone-else', clientId, scope: DEFAULT_SCOPE })
  assert.equal(await verifyAccessToken(token), null)
  const { spawnSync } = await import('node:child_process')
  const start = (secret: string) => spawnSync(process.execPath,
    ['--experimental-strip-types', '-e', "await import('./src/mcp/tokens.ts'); process.exit(0)"],
    { env: { ...process.env, AUTH_SECRET: secret, BETTER_AUTH_SECRET: '' }, encoding: 'utf8' })
  const weak = start('changeme')
  assert.notEqual(weak.status, 0)
  assert.match(weak.stderr, /AUTH_SECRET is too short/)
  assert.equal(start('x'.repeat(32)).status, 0)
})

test('client metadata is only fetched from public https addresses, with redirects and size held in check', async (t) => {
  const { resolveClient, isPublicAddress, resetClientCache, net } = clientMetadata
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'not-an-ip']) assert.equal(isPublicAddress(ip), false, ip)
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.ok(isPublicAddress(ip), ip)

  const fetched: string[] = []
  const serve = (handler: (url: string) => Response) =>
    t.mock.method(globalThis, 'fetch', async (u: URL | string) => { fetched.push(String(u)); return handler(String(u)) })
  const json = (doc: unknown) => new Response(JSON.stringify(doc))

  resetClientCache()
  serve(() => json({ client_name: 'x' }))
  for (const id of ['http://client.example/c.json', 'https://127.0.0.1/c.json', 'https://[::1]/c.json',
    'https://client.example:8443/c.json', 'https://user:pw@client.example/c.json', 'not a url']) {
    assert.equal(await resolveClient(id), null, id)
  }
  assert.equal(fetched.length, 0)

  // A public-looking name that resolves to a private address is refused unfetched.
  const realResolve = net.resolve
  net.resolve = async (host) => (host === 'internal.example' ? ['10.0.0.7'] : ['93.184.216.34'])
  try {
    assert.equal(await resolveClient('https://internal.example/c.json'), null)
    assert.equal(fetched.length, 0)

    // A redirect is followed by hand and held to the same rules.
    serve((u) => u.includes('start') ? new Response(null, { status: 302, headers: { location: 'https://internal.example/secret' } }) : json({}))
    assert.equal(await resolveClient('https://client.example/start.json'), null)
    assert.deepEqual(fetched, ['https://client.example/start.json'])

    serve((u) => u.includes('hop') ? new Response(null, { status: 302, headers: { location: '/final.json' } }) : json({ client_name: 'Moved', redirect_uris: [callback, 7] }))
    assert.deepEqual(await resolveClient('https://client.example/hop.json'), { name: 'Moved', redirectUris: [callback] })

    serve(() => new Response('x'.repeat(70_000)))
    assert.equal(await resolveClient('https://client.example/big.json'), null)
    serve(() => new Response('not json'))
    assert.equal(await resolveClient('https://client.example/bad.json'), null)

    // Real clients are cached; a flood of new client_ids runs out of fetch budget.
    resetClientCache(); fetched.length = 0
    serve(() => json({ client_name: 'Cached' }))
    await resolveClient('https://client.example/a.json'); await resolveClient('https://client.example/a.json')
    assert.equal(fetched.length, 1)
    for (let i = 0; i < 40; i++) await resolveClient(`https://client.example/flood-${i}.json`)
    assert.equal(fetched.length, 30)
    assert.equal((await resolveClient('https://client.example/a.json'))?.name, 'Cached')
  } finally { net.resolve = realResolve; resetClientCache() }
})
