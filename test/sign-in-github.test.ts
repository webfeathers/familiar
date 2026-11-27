import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { baseEnv, loadServer, serve, json, clientDoc, approve, returnFrom } from './sign-in-flow.ts'

baseEnv({ AUTH_PROVIDER: 'github', GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret',
  ALLOWED_SUBJECT: '1234567' })
const s = await loadServer()
after(() => s.pool.end())

async function start(t: Parameters<Parameters<typeof test>[1]>[0]) {
  serve(t, clientDoc)
  const { location, stateCookie } = await approve(s)
  const u = new URL(location!)
  return { u, state: u.searchParams.get('state')!, stateCookie: stateCookie! }
}

test('GitHub sign-in sends PKCE, asks for no scopes, and matches the numeric user id', async (t) => {
  const { u, state, stateCookie } = await start(t)
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize')
  assert.equal(u.searchParams.get('client_id'), 'gh-client')
  assert.equal(u.searchParams.get('redirect_uri'), 'https://familiar.example/oauth/github/callback')
  assert.equal(u.searchParams.get('scope'), null)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')

  const calls = serve(t, {
    'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_fixture', token_type: 'bearer' }),
    // `login` is deliberately the owner-looking value: only `id` may count.
    'https://api.github.com/user': () => json({ id: 1234567, login: 'someone' }),
  })
  const { res, codeRow } = await returnFrom(t, s, '/oauth/github/callback', stateCookie, { state, code: 'gh-code' })
  assert.equal(res.status, 302)
  assert.equal(codeRow.subject, '1234567')
  const body = new URLSearchParams(String(calls[0]!.init!.body))
  const verifier = body.get('code_verifier')!
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), u.searchParams.get('code_challenge'))
  assert.equal(body.get('client_secret'), 'gh-secret')
  assert.equal((calls[1]!.init!.headers as Record<string, string>).authorization, 'Bearer gho_fixture')
})

test('another GitHub account, a bad code, or a forged state get no code', async (t) => {
  let { state, stateCookie } = await start(t)
  serve(t, {
    'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_fixture' }),
    'https://api.github.com/user': () => json({ id: 7654321, login: '1234567' }),
  })
  let r = await returnFrom(t, s, '/oauth/github/callback', stateCookie, { state, code: 'gh-code' })
  assert.equal(r.res.status, 403)
  assert.match(await r.res.text(), /subject 7654321/)
  assert.equal(r.rows.length, 0)

  ;({ state, stateCookie } = await start(t))
  serve(t, { 'https://github.com/login/oauth/access_token': () => json({ error: 'bad_verification_code' }) })
  r = await returnFrom(t, s, '/oauth/github/callback', stateCookie, { state, code: 'stale' })
  assert.equal(r.res.status, 502)
  assert.equal(r.rows.length, 0)

  ;({ stateCookie } = await start(t))
  const network = serve(t, {})
  r = await returnFrom(t, s, '/oauth/github/callback', stateCookie, { state: 'forged', code: 'gh-code' })
  assert.equal(r.res.status, 400)
  assert.equal(network.length, 0)
  assert.equal((await s.oauth.request('/oauth/google/callback')).status, 404)
})
