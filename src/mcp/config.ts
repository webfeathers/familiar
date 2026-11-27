/**
 * Canonical identifiers and client rules for the authorization server.
 *
 * Two things here are load-bearing and easy to get subtly wrong:
 *  - the issuer / resource strings must match EXACTLY what Claude discovers,
 *  - redirect-URI matching differs per Claude surface.
 */

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

/**
 * Normalise an origin: lowercase scheme+host, strip any trailing slash.
 * Anthropic advises accepting the canonical form rather than byte-comparing
 * whatever the user typed into the connector dialog.
 */
function canonicalOrigin(raw: string): string {
  const u = new URL(raw)
  u.hash = ''
  u.search = ''
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}`.replace(/\/$/, '')
}

/** `https://host` — the AS `issuer`, and the base for every metadata document. */
export const ISSUER = canonicalOrigin(required('PUBLIC_URL'))

/** `https://host/mcp` — the protected resource, and the token audience. */
export const RESOURCE = `${ISSUER}/mcp`

/**
 * The single identity permitted to authorise, as the sign-in provider names it
 * (see SIGN_IN below). The whole "user database".
 */
export const ALLOWED_SUBJECT = required('ALLOWED_SUBJECT')

export { SCOPES, DEFAULT_SCOPE } from './scopes.ts'

/** Claude's hosted surfaces (web, Desktop, mobile, Cowork) — exact match. */
const HOSTED_REDIRECTS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
])

/**
 * Is this redirect URI one we're willing to send a code to?
 *
 * Claude Code uses an RFC 8252 loopback redirect on an EPHEMERAL port, so the
 * port must be ignored for localhost — its published client metadata declares
 * `http://localhost/callback` with no port at all. Everything else must match
 * the hosted callback exactly. We never accept an arbitrary redirect: that is
 * an open redirector and, with a static sign-in client_id behind us, a
 * credential-leak primitive.
 */
export function isAllowedRedirect(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }

  if (HOSTED_REDIRECTS.has(raw)) return true

  const isLoopback =
    u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1')

  // Port deliberately unchecked for loopback; path must still match.
  return isLoopback && u.pathname === '/callback'
}

/**
 * Who signs the owner in. Exactly one provider per deployment, chosen by
 * AUTH_PROVIDER; ALLOWED_SUBJECT is the owner's identifier AT that provider.
 * The provider is used only to identify the human, never to store a token.
 *
 *   google  (default)  ALLOWED_SUBJECT is the Google `sub`
 *   github             ALLOWED_SUBJECT is the numeric GitHub user id
 *   oidc               ALLOWED_SUBJECT is the ID token `sub` at OIDC_ISSUER
 */
export type SignInConfig =
  | {
      kind: 'google'
      label: 'Google'
      clientId: string
      clientSecret: string
      authEndpoint: string
      tokenEndpoint: string
      redirectUri: string
    }
  | {
      kind: 'github'
      label: 'GitHub'
      clientId: string
      clientSecret: string
      authEndpoint: string
      tokenEndpoint: string
      userEndpoint: string
      redirectUri: string
    }
  | {
      kind: 'oidc'
      label: string
      issuer: string
      clientId: string
      clientSecret: string
      scope: string
      tokenAuthMethod: 'client_secret_basic' | 'client_secret_post'
      redirectUri: string
    }

export const AUTH_PROVIDERS = ['google', 'github', 'oidc'] as const

export function signInConfig(
  env: Record<string, string | undefined> = process.env,
  issuer: string = ISSUER,
): SignInConfig {
  const need = (name: string) => {
    const v = env[name]?.trim()
    if (!v) throw new Error(`${name} is not set`)
    return v
  }
  const kind = (env.AUTH_PROVIDER?.trim() || 'google').toLowerCase()
  switch (kind) {
    case 'google':
      return {
        kind,
        label: 'Google',
        clientId: need('GOOGLE_CLIENT_ID'),
        clientSecret: need('GOOGLE_CLIENT_SECRET'),
        authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        redirectUri: `${issuer}/oauth/google/callback`,
      }
    case 'github':
      return {
        kind,
        label: 'GitHub',
        clientId: need('GITHUB_CLIENT_ID'),
        clientSecret: need('GITHUB_CLIENT_SECRET'),
        authEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        userEndpoint: 'https://api.github.com/user',
        redirectUri: `${issuer}/oauth/github/callback`,
      }
    case 'oidc': {
      // Compared byte-for-byte with the discovered `issuer` and the ID token's
      // `iss`, so it is kept exactly as written (Authentik's ends in a slash).
      const oidcIssuer = need('OIDC_ISSUER')
      const u = new URL(oidcIssuer)
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
        throw new Error('OIDC_ISSUER must be an https URL')
      }
      const method = env.OIDC_TOKEN_AUTH_METHOD?.trim() || 'client_secret_basic'
      if (method !== 'client_secret_basic' && method !== 'client_secret_post') {
        throw new Error('OIDC_TOKEN_AUTH_METHOD must be client_secret_basic or client_secret_post')
      }
      const scope = env.OIDC_SCOPES?.trim() || 'openid'
      return {
        kind,
        label: env.OIDC_NAME?.trim() || 'your identity provider',
        issuer: oidcIssuer,
        clientId: need('OIDC_CLIENT_ID'),
        clientSecret: need('OIDC_CLIENT_SECRET'),
        scope: scope.split(/\s+/).includes('openid') ? scope : `openid ${scope}`,
        tokenAuthMethod: method,
        redirectUri: `${issuer}/oauth/oidc/callback`,
      }
    }
    default:
      throw new Error(`AUTH_PROVIDER "${kind}" is not one of: ${AUTH_PROVIDERS.join(', ')}`)
  }
}

export const SIGN_IN = signInConfig()

export const TTL = {
  /** Authorization codes are single-use and short-lived. */
  codeSeconds: 60,
  accessTokenSeconds: 60 * 60,
  refreshTokenSeconds: 60 * 60 * 24 * 30,
  /** Sign-in round-trip state (consent screen + provider). */
  loginStateSeconds: 10 * 60,
} as const

