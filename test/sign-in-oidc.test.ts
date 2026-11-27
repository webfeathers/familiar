import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { baseEnv, loadServer, serve, json, clientDoc, approve, returnFrom } from './sign-in-flow.ts'

// Authentik-style issuer, trailing slash and all: it must be compared as written.
const issuer = 'https://idp.example/application/o/familiar/'
baseEnv({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'oidc-client',
  OIDC_CLIENT_SECRET: 'oidc secret/+', OIDC_NAME: 'Authentik', ALLOWED_SUBJECT: 'owner-sub' })
const s = await loadServer()
after(() => s.pool.end())

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
const discovery = {
  issuer,
  authorization_endpoint: 'https://idp.example/application/o/authorize/',
  token_endpoint: 'https://idp.example/application/o/token/',
  jwks_uri: 'https://idp.example/application/o/familiar/jwks/',
}
const sign = (claims: Record<string, unknown>, key = privateKey) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(key)

async function start(t: Parameters<Parameters<typeof test>[1]>[0]) {
  serve(t, { ...clientDoc, [`${issuer}.well-known/openid-configuration`]: () => json(discovery) })
  const { location, stateCookie } = await approve(s)
  const u = new URL(location!)
  return { u, state: u.searchParams.get('state')!, nonce: u.searchParams.get('nonce')!, stateCookie: stateCookie! }
}

/** Return from the IdP with an ID token built from `claims(nonce)`. */
async function finish(t: Parameters<Parameters<typeof test>[1]>[0], claims: (nonce: string) => Record<string, unknown>,
  key = privateKey) {
  const { u, state, nonce, stateCookie } = await start(t)
  const idToken = await sign(claims(nonce), key)
  const calls = serve(t, {
    [discovery.token_endpoint]: () => json({ id_token: idToken, access_token: 'unused' }),
    [discovery.jwks_uri]: () => json({ keys: [jwk] }),
  })
  return { u, calls, ...(await returnFrom(t, s, '/oauth/oidc/callback', stateCookie, { state, code: 'oidc-code' })) }
}

const good = (nonce: string) => ({ iss: issuer, aud: 'oidc-client', sub: 'owner-sub', nonce })

test('OIDC sign-in discovers endpoints, sends PKCE and a nonce, and verifies the ID token', async (t) => {
  const { u, calls, res, codeRow } = await finish(t, good)
  assert.equal(u.origin + u.pathname, discovery.authorization_endpoint)
  assert.equal(u.searchParams.get('redirect_uri'), 'https://familiar.example/oauth/oidc/callback')
  assert.equal(u.searchParams.get('scope'), 'openid')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(res.status, 302)
  assert.equal(codeRow.subject, 'owner-sub')

  const tokenCall = calls.find((c) => c.url === discovery.token_endpoint)!
  const headers = tokenCall.init!.headers as Record<string, string>
  // client_secret_basic by default, each half form-encoded first (RFC 6749 2.3.1).
  assert.equal(Buffer.from(headers.authorization!.slice(6), 'base64').toString(), 'oidc-client:oidc%20secret%2F%2B')
  const body = new URLSearchParams(String(tokenCall.init!.body))
  assert.equal(body.get('client_secret'), null)
  assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), u.searchParams.get('code_challenge'))
})

test('ID tokens that are forged, misdirected, replayed or for someone else get no code', async (t) => {
  const other = await generateKeyPair('RS256')
  const cases: [string, (n: string) => Record<string, unknown>, CryptoKey?, number?][] = [
    ['another user', (n) => ({ ...good(n), sub: 'stranger' }), undefined, 403],
    ['wrong signing key', good, other.privateKey as CryptoKey],
    ['wrong issuer', (n) => ({ ...good(n), iss: issuer.slice(0, -1) })],
    ['wrong audience', (n) => ({ ...good(n), aud: 'someone-elses-client' })],
    ['wrong nonce', (n) => ({ ...good(n), nonce: n + 'x' })],
    ['no nonce', (n) => { const { nonce: _, ...rest } = good(n); return rest }],
    ['shared audience, other azp', (n) => ({ ...good(n), aud: ['oidc-client', 'x'], azp: 'x' })],
  ]
  for (const [name, claims, key, status = 400] of cases) {
    const { res, rows } = await finish(t, claims, key as any)
    assert.equal(res.status, status, name)
    assert.equal(rows.length, 0, name)
  }
})

test('a discovery document for another issuer is refused before any redirect', async (t) => {
  const { createProvider } = await import('../src/mcp/providers.ts')
  const { signInConfig } = await import('../src/mcp/config.ts')
  const p = createProvider(signInConfig({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'https://idp2.example',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' }, 'https://familiar.example'))
  serve(t, { 'https://idp2.example/.well-known/openid-configuration': () => json({ ...discovery, issuer: 'https://evil.example' }) })
  await assert.rejects(p.authorizeUrl('state'), /does not equal OIDC_ISSUER/)
})

test('provider configuration is checked at startup', async () => {
  const { signInConfig } = await import('../src/mcp/config.ts')
  const cfg = (env: Record<string, string>) => () => signInConfig(env, 'https://familiar.example')
  assert.throws(cfg({ AUTH_PROVIDER: 'facebook' }), /not one of: google, github, oidc/)
  assert.throws(cfg({ AUTH_PROVIDER: 'github', GITHUB_CLIENT_ID: 'x' }), /GITHUB_CLIENT_SECRET is not set/)
  assert.throws(cfg({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'http://idp.example', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' }), /https/)
  assert.throws(cfg({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'https://i.example', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's',
    OIDC_TOKEN_AUTH_METHOD: 'none' }), /OIDC_TOKEN_AUTH_METHOD/)
  const ok = signInConfig({ AUTH_PROVIDER: 'OIDC', OIDC_ISSUER: 'https://i.example', OIDC_CLIENT_ID: 'c',
    OIDC_CLIENT_SECRET: 's', OIDC_SCOPES: 'email profile' }, 'https://familiar.example')
  assert.equal(ok.kind === 'oidc' && ok.scope, 'openid email profile')
  // Google needs nothing beyond the variables it always needed.
  assert.equal(signInConfig({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }, 'https://f.example').kind, 'google')
})
