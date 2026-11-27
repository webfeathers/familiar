import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { baseEnv, loadServer, serve, json, clientDoc, approve, returnFrom, callback } from './sign-in-flow.ts'

// No AUTH_PROVIDER at all: an existing deployment's .env, which must keep
// signing in exactly as it did before providers were configurable.
baseEnv({ GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret' })
const s = await loadServer()
after(() => s.pool.end())

const idToken = (sub: string) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`

test('Google stays the default, with the same redirect and token exchange as before', async (t) => {
  serve(t, clientDoc)
  const { location, stateCookie } = await approve(s)
  const u = new URL(location!)
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  const state = u.searchParams.get('state')!
  // Exactly the parameters that shipped before; nothing added.
  assert.deepEqual([...u.searchParams.keys()].sort(), ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'])
  assert.equal(u.searchParams.get('redirect_uri'), 'https://familiar.example/oauth/google/callback')
  assert.equal(u.searchParams.get('scope'), 'openid email profile')
  assert.match(stateCookie!, new RegExp(`^__Host-pcl-state=${state}\\.`))

  const calls = serve(t, { 'https://oauth2.googleapis.com/token': () => json({ id_token: idToken('owner-subject') }) })
  const { res, codeRow } = await returnFrom(t, s, '/oauth/google/callback', stateCookie!, { state, code: 'g-code' })
  assert.equal(res.status, 302)
  const back = new URL(res.headers.get('location')!)
  assert.equal(back.origin + back.pathname, callback)
  assert.equal(back.searchParams.get('state'), 'client-state')
  assert.equal(codeRow.subject, 'owner-subject')
  assert.equal(codeRow.codeChallenge, 'client-pkce-challenge')
  const body = new URLSearchParams(String(calls[0]!.init!.body))
  assert.deepEqual(Object.fromEntries(body), { code: 'g-code', client_id: 'google-client', client_secret: 'google-secret',
    redirect_uri: 'https://familiar.example/oauth/google/callback', grant_type: 'authorization_code' })
})

test('a different Google account is refused and told its own subject', async (t) => {
  serve(t, clientDoc)
  const { location, stateCookie } = await approve(s)
  const state = new URL(location!).searchParams.get('state')!
  serve(t, { 'https://oauth2.googleapis.com/token': () => json({ id_token: idToken('stranger') }) })
  const { res, rows } = await returnFrom(t, s, '/oauth/google/callback', stateCookie!, { state, code: 'g-code' })
  assert.equal(res.status, 403)
  const text = await res.text()
  assert.match(text, /not authorised[\s\S]*subject stranger/)
  assert.doesNotMatch(text, /owner-subject/) // never the owner's identifier
  assert.equal(rows.length, 0)
})

test('other providers have no callback on a Google deployment', async () => {
  for (const path of ['/oauth/github/callback', '/oauth/oidc/callback']) {
    assert.equal((await s.oauth.request(path)).status, 404, path)
  }
})
