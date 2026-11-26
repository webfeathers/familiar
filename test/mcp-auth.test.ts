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
