/**
 * The authorization server: /authorize → consent → sign-in → code → /token.
 *
 * Shape of the flow, and why it is in this order:
 *
 *   1. /authorize validates the request and resolves the client via its Client
 *      ID Metadata Document (CIMD). No DCR, no client database.
 *   2. A FIRST-PARTY consent screen renders BEFORE we ever redirect to the
 *      sign-in provider (Google, GitHub or an OIDC provider; see providers.ts).
 *      This is the confused-deputy mitigation and it is a genuine MUST: we hold
 *      a static client_id at the provider while accepting arbitrary MCP
 *      clients, which is precisely the configuration the spec warns about.
 *      Without it, any client that can reach /authorize could ride our
 *      identity there.
 *      The approval only counts from the browser that was shown the screen:
 *      /authorize sets a cookie, the signed request carries its value, and
 *      /consent requires both. A page elsewhere cannot submit the form for you,
 *      and the screen refuses to be framed.
 *   3. Only after approval do we set the state cookie and bounce to the provider.
 *   4. The provider tells us who signed in; the code is issued ONLY if that
 *      subject matches ALLOWED_SUBJECT. That comparison is the entire
 *      access-control model, and it is the same for every provider.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { SignJWT, jwtVerify } from 'jose'
import { and, eq, isNull, gt } from 'drizzle-orm'
import { db } from '../store/index.ts'
import { oauthCodes, oauthConsents } from '../store/schema.ts'
import {
  ALLOWED_SUBJECT,
  ISSUER,
  SIGN_IN,
  TTL,
  isAllowedRedirect,
} from './config.ts'
import {
  SECRET,
  issueAccessToken,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  verifyPkce,
} from './tokens.ts'
import { resolveClient } from './client-metadata.ts'
import { createProvider } from './providers.ts'
import { normalizeScope, consentDescription } from './scopes.ts'
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.ts'

/**
 * `__Host-` cookies must be Secure, and Safari will not store a Secure cookie
 * from plain http, so a local `http://localhost` deployment gets unprefixed,
 * non-Secure names. Anything served over https gets the strict form.
 */
const HTTPS = ISSUER.startsWith('https://')
const cookieName = (name: string) => (HTTPS ? `__Host-${name}` : name)
const STATE_COOKIE = cookieName('pcl-state')
const CONSENT_COOKIE = cookieName('pcl-consent')

/** Keeps a signed authorize request from being mistaken for any other token. */
const STATE_AUDIENCE = `${ISSUER}/authorize`

/** The one sign-in provider this deployment is configured for. */
const provider = createProvider(SIGN_IN)

const sameValue = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The authorize request, carried across the consent + sign-in round trips. */
interface PendingAuth {
  client_id: string
  /** Display name from the client's metadata document, kept for the audit row. */
  client_name: string
  /** Must match the consent cookie set alongside the screen this was rendered into. */
  csrf: string
  redirect_uri: string
  code_challenge: string
  scope: string
  state?: string
  resource?: string
}

const sealState = (p: PendingAuth) =>
  new SignJWT({ ...p })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL.loginStateSeconds}s`)
    .sign(SECRET)

async function openState(token: string): Promise<PendingAuth | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET, { audience: STATE_AUDIENCE })
    if (typeof payload.csrf !== 'string' || !payload.csrf) return null
    return payload as unknown as PendingAuth
  } catch {
    return null
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )

function consentPage(clientName: string, clientId: string, pending: string, scope: string) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorise access</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#111}
 .c{border:1px solid #ddd;border-radius:12px;padding:1.5rem}
 code{background:#f4f4f5;padding:.1rem .35rem;border-radius:4px;font-size:.85em;word-break:break-all}
 button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#111;color:#fff;cursor:pointer}
 .m{color:#666;font-size:.9em}
 @media(prefers-color-scheme:dark){body{background:#0b0b0c;color:#eee}.c{border-color:#333}
 code{background:#1a1a1c}button{background:#eee;color:#111}.m{color:#999}}
</style>
<div class=c>
<h1>Authorise access</h1>
<p><strong>${escapeHtml(clientName)}</strong> is requesting access to your personal context.</p>
<p class=m>Client ID: <code>${escapeHtml(clientId)}</code></p>
<p class=m>${escapeHtml(consentDescription(scope))} Approve only if you started this.</p>
<form method="post" action="/consent">
  <input type="hidden" name="pending" value="${escapeHtml(pending)}">
  <button type="submit">Approve</button>
</form>
</div>`
}

/** Redirect back to the client with an OAuth error. */
function errorRedirect(
  redirectUri: string,
  error: string,
  state: string | undefined,
  description?: string,
) {
  const u = new URL(redirectUri)
  u.searchParams.set('error', error)
  if (description) u.searchParams.set('error_description', description)
  if (state) u.searchParams.set('state', state)
  u.searchParams.set('iss', ISSUER)
  return u.toString()
}

export const oauth = new Hono()

// Nothing these routes accept is large: a consent form or a token request.
// (The MCP endpoint is mounted separately and is not subject to this.)
oauth.use(bodyLimit({ maxSize: 64 * 1024 }))

// ── Discovery ────────────────────────────────────────────────────────────────
// Claude tries the path-suffixed PRM variant first; serve both, identical body.

oauth.get('/.well-known/oauth-protected-resource', (c) =>
  c.json(protectedResourceMetadata),
)
oauth.get('/.well-known/oauth-protected-resource/mcp', (c) =>
  c.json(protectedResourceMetadata),
)
oauth.get('/.well-known/oauth-authorization-server', (c) =>
  c.json(authorizationServerMetadata),
)

// ── /authorize ───────────────────────────────────────────────────────────────

oauth.get('/authorize', async (c) => {
  const q = c.req.query()
  const redirectUri = q.redirect_uri ?? ''

  // Never redirect to an unvetted URI — that would be an open redirector, and
  // with a static sign-in client behind us, a credential-leak primitive.
  if (!redirectUri || !isAllowedRedirect(redirectUri)) {
    return c.text('Invalid redirect_uri', 400)
  }
  if (q.response_type !== 'code') {
    return c.redirect(
      errorRedirect(redirectUri, 'unsupported_response_type', q.state),
    )
  }
  // PKCE S256 is mandatory. No plain, no omission.
  if (!q.code_challenge || q.code_challenge_method !== 'S256') {
    return c.redirect(
      errorRedirect(
        redirectUri,
        'invalid_request',
        q.state,
        'PKCE with S256 is required',
      ),
    )
  }
  if (!q.client_id) {
    return c.redirect(errorRedirect(redirectUri, 'invalid_request', q.state))
  }

  const client = await resolveClient(q.client_id)
  if (!client) {
    return c.redirect(
      errorRedirect(
        redirectUri,
        'invalid_client',
        q.state,
        'client_id must be an https URL serving a client metadata document',
      ),
    )
  }
  // If the client publishes redirect URIs, hold it to them.
  if (
    client.redirectUris.length > 0 &&
    !client.redirectUris.some((u) => u === redirectUri || isLoopbackMatch(u, redirectUri))
  ) {
    return c.redirect(
      errorRedirect(
        redirectUri,
        'invalid_request',
        q.state,
        'redirect_uri not declared by the client',
      ),
    )
  }

  const scope = normalizeScope(q.scope)
  if (!scope) {
    return c.redirect(errorRedirect(redirectUri, 'invalid_scope', q.state,
      'Request context:read, optionally with context:write'))
  }

  const csrf = randomBytes(16).toString('base64url')
  const pending: PendingAuth = {
    client_id: q.client_id,
    client_name: client.name,
    csrf,
    redirect_uri: redirectUri,
    code_challenge: q.code_challenge,
    scope,
    state: q.state,
    // claude.ai does not send RFC 8707 `resource`. Record it if present, but
    // never require it — requiring it breaks the connector outright.
    resource: q.resource,
  }
  const sealed = await sealState(pending)

  // Legacy consent rows do not record scopes. Never reuse them to silently
  // expand access; show the exact grant on every authorization/reconnect.
  // Refresh tokens continue to work without a new consent round trip.
  //
  // SameSite=Strict: the browser sends this only with requests that start on
  // this origin, which is exactly the consent form and nothing else.
  setCookie(c, CONSENT_COOKIE, csrf, {
    path: '/',
    httpOnly: true,
    secure: HTTPS,
    sameSite: 'Strict',
    maxAge: TTL.loginStateSeconds,
  })
  // Clickjacking: an invisible frame over a decoy button is the other way to
  // get an approval nobody meant to give.
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
  c.header('X-Frame-Options', 'DENY')
  // `same-origin`, not `no-referrer`: under no-referrer the browser sends
  // `Origin: null` with the form, and /consent would refuse its own screen.
  c.header('Referrer-Policy', 'same-origin')
  c.header('Cache-Control', 'no-store')
  return c.html(consentPage(client.name, q.client_id, sealed, scope))
})

/** Loopback URIs compare without their port (RFC 8252). */
function isLoopbackMatch(declared: string, actual: string): boolean {
  try {
    const a = new URL(declared)
    const b = new URL(actual)
    return (
      a.protocol === 'http:' &&
      b.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(a.hostname) &&
      ['localhost', '127.0.0.1'].includes(b.hostname) &&
      a.pathname === b.pathname
    )
  } catch {
    return false
  }
}

// ── /consent ─────────────────────────────────────────────────────────────────

oauth.post('/consent', async (c) => {
  const form = await c.req.formData()
  const sealed = String(form.get('pending') ?? '')
  const pending = await openState(sealed)
  if (!pending) return c.text('Consent request expired — start again.', 400)

  // The approval must come from this origin, in the browser that was shown the
  // screen. The signed request alone proves neither: /authorize hands one to
  // anyone who asks.
  const origin = c.req.header('origin')
  if (origin && origin !== ISSUER) return c.text('Cross-site consent refused.', 403)
  const cookie = getCookie(c, CONSENT_COOKIE)
  deleteCookie(c, CONSENT_COOKIE, { path: '/', secure: HTTPS })
  if (!cookie || !sameValue(cookie, pending.csrf)) {
    return c.text('This approval did not come from the consent screen — start again from your client.', 403)
  }

  // The state cookie is set only now — after approval, never before.
  let target: string
  try {
    target = await beginLogin(c, sealed)
  } catch (e) {
    console.error('sign-in provider unavailable:', (e as Error).message)
    deleteCookie(c, STATE_COOKIE, { path: '/', secure: HTTPS })
    return c.text(`Could not reach ${provider.label} — try again shortly.`, 502)
  }
  return c.redirect(target)
})

async function beginLogin(c: Context, sealed: string): Promise<string> {
  const nonce = randomBytes(16).toString('base64url')
  setCookie(c, STATE_COOKIE, `${nonce}.${sealed}`, {
    path: '/',
    httpOnly: true,
    secure: HTTPS,
    sameSite: 'Lax',
    maxAge: TTL.loginStateSeconds,
  })
  return provider.authorizeUrl(nonce)
}

// ── Sign-in callback ─────────────────────────────────────────────────────────
// Only the configured provider's path exists: /oauth/google/callback,
// /oauth/github/callback or /oauth/oidc/callback.

oauth.get(provider.callbackPath, async (c) => {
  const cookie = getCookie(c, STATE_COOKIE)
  // `secure` is REQUIRED on delete too, not just on set: Hono rejects any
  // __Host-prefixed cookie without it, and this throwing here takes out the
  // whole callback before it can read a single parameter.
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: HTTPS })
  if (!cookie) return c.text('Login state missing or expired.', 400)

  const idx = cookie.indexOf('.')
  const nonce = cookie.slice(0, idx)
  const pending = await openState(cookie.slice(idx + 1))
  if (!pending) return c.text('Login state invalid.', 400)
  if (c.req.query('state') !== nonce) return c.text('State mismatch.', 400)

  const code = c.req.query('code')
  if (!code) return c.text(`No authorization code from ${provider.label}.`, 400)

  const who = await provider.identify(code, nonce)
  if (!who.ok) return c.text(who.message, who.status)

  // THE access-control decision. One string comparison, and the reason there is
  // no user table anywhere in this system.
  if (!who.subject || !sameValue(who.subject, ALLOWED_SUBJECT)) {
    // Naming the visitor's OWN identifier back to them reveals nothing about
    // the owner, and it is how a self-hoster finds the value to configure.
    return c.text(
      'This account is not authorised for this server.\n\n' +
        `You signed in to ${provider.label} as subject ${who.subject || '(none)'}. ` +
        'If this is the owner, set ALLOWED_SUBJECT to that value.',
      403,
    )
  }

  // Record the approval only now, with the owner signed in. Written any
  // earlier, it would be a database row any anonymous visitor could create.
  await db
    .insert(oauthConsents)
    .values({ clientId: pending.client_id, clientMetadata: { client_name: pending.client_name } })
    .onConflictDoNothing()

  const authCode = randomBytes(32).toString('base64url')
  await db.insert(oauthCodes).values({
    code: authCode,
    clientId: pending.client_id,
    redirectUri: pending.redirect_uri,
    codeChallenge: pending.code_challenge,
    scope: pending.scope,
    subject: who.subject,
    resource: pending.resource ?? null,
    expiresAt: new Date(Date.now() + TTL.codeSeconds * 1000),
  })

  const back = new URL(pending.redirect_uri)
  back.searchParams.set('code', authCode)
  if (pending.state) back.searchParams.set('state', pending.state)
  back.searchParams.set('iss', ISSUER) // RFC 9207
  return c.redirect(back.toString())
})

// ── /token ───────────────────────────────────────────────────────────────────
// Body is application/x-www-form-urlencoded (RFC 6749). A JSON-only parser here
// returns 415 and the connection fails at the last step.

oauth.post('/token', async (c) => {
  const form = await c.req.formData()
  const grantType = String(form.get('grant_type') ?? '')
  const clientId = String(form.get('client_id') ?? '')
  const bad = (error: string, description?: string) =>
    c.json({ error, ...(description && { error_description: description }) }, 400)

  if (!clientId) return bad('invalid_client')

  if (grantType === 'refresh_token') {
    const presented = String(form.get('refresh_token') ?? '')
    const requestedScope = form.has('scope') ? String(form.get('scope')) : undefined
    if (requestedScope !== undefined && !normalizeScope(requestedScope)) return bad('invalid_scope')
    const rotated = await rotateRefreshToken(presented, clientId, requestedScope)
    // Must be invalid_grant, not invalid_request — Claude only re-authenticates
    // on the former.
    if (!rotated) return bad('invalid_grant', 'refresh token is invalid or expired')

    const access = await issueAccessToken({
      subject: rotated.subject,
      clientId,
      scope: rotated.scope,
    })
    return c.json({
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: access.expiresIn,
      refresh_token: rotated.refreshToken,
      scope: rotated.scope,
    })
  }

  if (grantType !== 'authorization_code') {
    return bad('unsupported_grant_type')
  }

  const code = String(form.get('code') ?? '')
  const verifier = String(form.get('code_verifier') ?? '')
  const redirectUri = String(form.get('redirect_uri') ?? '')
  if (!code || !verifier) return bad('invalid_request', 'code and code_verifier are required')

  const rows = await db
    .select()
    .from(oauthCodes)
    .where(
      and(
        eq(oauthCodes.code, code),
        eq(oauthCodes.clientId, clientId),
        isNull(oauthCodes.redeemedAt),
        gt(oauthCodes.expiresAt, new Date()),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row || !normalizeScope(row.scope)) return bad('invalid_grant', 'authorization code is invalid or expired')

  // Burn the code before any other check — a code must be single-use even if
  // what follows fails.
  await db
    .update(oauthCodes)
    .set({ redeemedAt: new Date() })
    .where(eq(oauthCodes.code, code))

  if (redirectUri && redirectUri !== row.redirectUri) {
    return bad('invalid_grant', 'redirect_uri mismatch')
  }
  if (!verifyPkce(verifier, row.codeChallenge)) {
    return bad('invalid_grant', 'PKCE verification failed')
  }

  const access = await issueAccessToken({
    subject: row.subject,
    clientId,
    scope: row.scope,
  })
  const refreshToken = await issueRefreshToken({
    subject: row.subject,
    clientId,
    scope: row.scope,
  })

  return c.json({
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    refresh_token: refreshToken,
    scope: row.scope,
  })
})

oauth.post('/revoke', async (c) => {
  const form = await c.req.formData().catch(() => null)
  const token = String(form?.get('token') ?? '')
  // Only refresh tokens can be revoked. Access tokens are stateless and expire
  // within the hour; revoking the refresh token is what ends the session.
  if (token) await revokeRefreshToken(token)
  // RFC 7009: always 200, regardless of whether the token existed.
  return c.body(null, 200)
})

