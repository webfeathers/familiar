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

/** The single Google `sub` permitted to authorise. The whole "user database". */
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
 * an open redirector and, with a static Google client_id behind us, a
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

/** Google OIDC — used only to authenticate the human, never to store a token. */
export const GOOGLE = {
  clientId: required('GOOGLE_CLIENT_ID'),
  clientSecret: required('GOOGLE_CLIENT_SECRET'),
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  redirectUri: `${ISSUER}/oauth/google/callback`,
} as const

export const TTL = {
  /** Authorization codes are single-use and short-lived. */
  codeSeconds: 60,
  accessTokenSeconds: 60 * 60,
  refreshTokenSeconds: 60 * 60 * 24 * 30,
  /** Google round-trip state. */
  loginStateSeconds: 10 * 60,
} as const

