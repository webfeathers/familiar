/**
 * Sign-in providers: who tells us the human at the browser is the owner.
 *
 * Each provider does two things and nothing else: build the URL the browser is
 * sent to after consent, and turn the code it sends back into a subject string.
 * Everything around that (the consent screen, the state cookie, the
 * ALLOWED_SUBJECT comparison, issuing our own code) lives in oauth.ts and is
 * the same for all of them.
 *
 * No provider token is kept. Each is used once, to learn who signed in.
 *
 * The callback state is the only per-login value we carry (in the state
 * cookie, unchanged from the Google-only design). The PKCE verifier and the
 * OIDC nonce are derived from it with AUTH_SECRET, so they need no storage of
 * their own and cannot be computed by anyone who sees the state in a URL.
 */
import { createHash, createHmac } from 'node:crypto'
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { SignInConfig } from './config.ts'
import { SECRET } from './tokens.ts'

export type Identified =
  | { ok: true; subject: string }
  | { ok: false; status: 400 | 502; message: string }

export interface SignInProvider {
  readonly label: string
  /** Path of this provider's callback on our origin. */
  readonly callbackPath: string
  /** Where to send the browser once consent is given. */
  authorizeUrl(state: string): Promise<string>
  /** Exchange the callback's code for the signed-in subject. */
  identify(code: string, state: string): Promise<Identified>
}

const TIMEOUT_MS = 10_000

const derive = (purpose: string, state: string) =>
  createHmac('sha256', SECRET).update(`${purpose}:${state}`).digest('base64url')
const pkceVerifier = (state: string) => derive('pkce', state)
const pkceChallenge = (state: string) =>
  createHash('sha256').update(pkceVerifier(state)).digest('base64url')
const oidcNonce = (state: string) => derive('nonce', state)

const fail = (status: 400 | 502, message: string): Identified => ({ ok: false, status, message })

export function createProvider(cfg: SignInConfig): SignInProvider {
  switch (cfg.kind) {
    case 'google':
      return google(cfg)
    case 'github':
      return github(cfg)
    case 'oidc':
      return oidc(cfg)
  }
}

// ── Google ───────────────────────────────────────────────────────────────────
// Deliberately byte-for-byte the flow that shipped before there was a choice of
// provider: existing deployments see no difference at all.

function google(cfg: Extract<SignInConfig, { kind: 'google' }>): SignInProvider {
  return {
    label: cfg.label,
    callbackPath: '/oauth/google/callback',
    async authorizeUrl(state) {
      const u = new URL(cfg.authEndpoint)
      u.searchParams.set('client_id', cfg.clientId)
      u.searchParams.set('redirect_uri', cfg.redirectUri)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('scope', 'openid email profile')
      u.searchParams.set('state', state)
      return u.toString()
    },
    async identify(code) {
      const tokenRes = await fetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri,
          grant_type: 'authorization_code',
        }),
      })
      if (!tokenRes.ok) return fail(502, 'Google token exchange failed.')
      const { id_token } = (await tokenRes.json()) as { id_token?: string }
      if (!id_token) return fail(502, 'Google returned no id_token.')
      // Received straight from Google's token endpoint over TLS, which OIDC
      // Core 3.1.3.7 accepts in place of checking the signature.
      const { sub } = decodeJwt(id_token)
      return { ok: true, subject: typeof sub === 'string' ? sub : '' }
    },
  }
}

// ── GitHub ───────────────────────────────────────────────────────────────────
// GitHub is OAuth, not OIDC: there is no ID token. We ask for no scopes, which
// still lets the token read the public profile, and match on the numeric `id`.
// The login name is not used: it can be renamed, and then reclaimed by someone
// else.

function github(cfg: Extract<SignInConfig, { kind: 'github' }>): SignInProvider {
  return {
    label: cfg.label,
    callbackPath: '/oauth/github/callback',
    async authorizeUrl(state) {
      const u = new URL(cfg.authEndpoint)
      u.searchParams.set('client_id', cfg.clientId)
      u.searchParams.set('redirect_uri', cfg.redirectUri)
      u.searchParams.set('state', state)
      u.searchParams.set('allow_signup', 'false')
      u.searchParams.set('code_challenge', pkceChallenge(state))
      u.searchParams.set('code_challenge_method', 'S256')
      return u.toString()
    },
    async identify(code, state) {
      const tokenRes = await fetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri,
          code_verifier: pkceVerifier(state),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      // GitHub reports a bad code as 200 with an `error` field.
      const token = tokenRes.ok
        ? ((await tokenRes.json()) as { access_token?: string; error?: string })
        : {}
      if (!token.access_token) return fail(502, 'GitHub token exchange failed.')

      const userRes = await fetch(cfg.userEndpoint, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token.access_token}`,
          'user-agent': 'familiar',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!userRes.ok) return fail(502, 'GitHub did not say who signed in.')
      const { id } = (await userRes.json()) as { id?: unknown }
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
        return fail(502, 'GitHub did not say who signed in.')
      }
      return { ok: true, subject: String(id) }
    },
  }
}

// ── Generic OIDC ─────────────────────────────────────────────────────────────
// Okta, Microsoft Entra, Authentik, Keycloak, and anything else that publishes
// a discovery document. Unlike the Google path, the ID token's signature,
// issuer, audience and nonce are all checked: the endpoints come from a
// document we fetched, not from a constant in this file.

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

function oidc(cfg: Extract<SignInConfig, { kind: 'oidc' }>): SignInProvider {
  const secureUrl = (raw: unknown): raw is string => {
    if (typeof raw !== 'string') return false
    try {
      const u = new URL(raw)
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      return u.protocol === 'https:' || (u.protocol === 'http:' && loopback)
    } catch {
      return false
    }
  }

  let cached: Promise<{ doc: Discovery; jwks: JWTVerifyGetKey }> | null = null
  const discover = () => {
    cached ??= (async () => {
      const url = `${cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} from ${url}`)
      const doc = (await res.json()) as Partial<Discovery>
      // OIDC Discovery 4.3: the document must name exactly the issuer we asked.
      if (doc.issuer !== cfg.issuer) {
        throw new Error(`OIDC discovery issuer "${doc.issuer}" does not equal OIDC_ISSUER "${cfg.issuer}"`)
      }
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        if (!secureUrl(doc[key])) throw new Error(`OIDC discovery has no usable ${key}`)
      }
      return { doc: doc as Discovery, jwks: createRemoteJWKSet(new URL(doc.jwks_uri!)) }
    })().catch((e) => {
      cached = null // try again on the next sign-in rather than caching an outage
      throw e
    })
    return cached
  }

  return {
    label: cfg.label,
    callbackPath: '/oauth/oidc/callback',
    async authorizeUrl(state) {
      const { doc } = await discover()
      const u = new URL(doc.authorization_endpoint)
      u.searchParams.set('client_id', cfg.clientId)
      u.searchParams.set('redirect_uri', cfg.redirectUri)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('scope', cfg.scope)
      u.searchParams.set('state', state)
      u.searchParams.set('nonce', oidcNonce(state))
      u.searchParams.set('code_challenge', pkceChallenge(state))
      u.searchParams.set('code_challenge_method', 'S256')
      return u.toString()
    },
    async identify(code, state) {
      let found: Awaited<ReturnType<typeof discover>>
      try {
        found = await discover()
      } catch {
        return fail(502, `Could not reach ${cfg.label}.`)
      }
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: pkceVerifier(state),
      })
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      }
      if (cfg.tokenAuthMethod === 'client_secret_basic') {
        // RFC 6749 2.3.1: each half is form-encoded before base64.
        const pair = `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`
        headers.authorization = `Basic ${Buffer.from(pair).toString('base64')}`
      } else {
        body.set('client_id', cfg.clientId)
        body.set('client_secret', cfg.clientSecret)
      }
      const tokenRes = await fetch(found.doc.token_endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!tokenRes.ok) return fail(502, `${cfg.label} token exchange failed.`)
      const { id_token } = (await tokenRes.json()) as { id_token?: string }
      if (!id_token) return fail(502, `${cfg.label} returned no id_token.`)

      try {
        const { payload } = await jwtVerify(id_token, found.jwks, {
          issuer: cfg.issuer,
          audience: cfg.clientId,
          clockTolerance: 60,
        })
        if (payload.nonce !== oidcNonce(state)) return fail(400, 'Sign-in nonce mismatch.')
        if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== cfg.clientId) {
          return fail(400, 'ID token was issued to another client.')
        }
        if (typeof payload.sub !== 'string' || !payload.sub) {
          return fail(502, `${cfg.label} returned no subject.`)
        }
        return { ok: true, subject: payload.sub }
      } catch {
        return fail(400, `${cfg.label} returned an ID token that did not verify.`)
      }
    },
  }
}
