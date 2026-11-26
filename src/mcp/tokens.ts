/**
 * Token issuance and verification.
 *
 * Access tokens are short-lived JWTs bound to this resource by `aud`. Refresh
 * tokens are opaque random strings, stored only as a SHA-256 hash and rotated
 * on every use (a MUST for public clients).
 */
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { and, eq, isNull, gt } from 'drizzle-orm'
import { db } from '../store/index.ts'
import { oauthRefreshTokens } from '../store/schema.ts'
import { normalizeScope } from './scopes.ts'
import { ISSUER, RESOURCE, TTL } from './config.ts'

// `BETTER_AUTH_SECRET` is the historical name from when this was going to be
// built on better-auth. Accept either so an existing .env keeps working.
const secretRaw =
  process.env.AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET ?? ''
if (!secretRaw) throw new Error('AUTH_SECRET (or BETTER_AUTH_SECRET) is not set')
const SECRET = new TextEncoder().encode(secretRaw)

export interface AccessClaims extends JWTPayload {
  sub: string
  scope: string
  client_id: string
}

export async function issueAccessToken(args: {
  subject: string
  clientId: string
  scope: string
}): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({
    scope: args.scope,
    client_id: args.clientId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setSubject(args.subject)
    // Audience-bound to this resource. We bind it ourselves rather than relying
    // on the client sending RFC 8707 `resource` — claude.ai does not send it.
    .setAudience(RESOURCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL.accessTokenSeconds}s`)
    .sign(SECRET)

  return { token, expiresIn: TTL.accessTokenSeconds }
}

/**
 * Verify a bearer token for THIS resource. Rejects tokens issued for any other
 * audience — the spec is explicit that a server must not accept or transit
 * tokens that were not issued for it.
 */
export async function verifyAccessToken(
  token: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET, {
      issuer: ISSUER,
      audience: RESOURCE,
    })
    if (typeof payload.sub !== 'string' ||
        typeof payload.client_id !== 'string' ||
        typeof payload.scope !== 'string' || !normalizeScope(payload.scope)) return null
    return payload as AccessClaims
  } catch {
    return null
  }
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

export async function issueRefreshToken(args: {
  subject: string
  clientId: string
  scope: string
}): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(oauthRefreshTokens).values({
    tokenHash: hash(token),
    clientId: args.clientId,
    subject: args.subject,
    scope: args.scope,
    expiresAt: new Date(Date.now() + TTL.refreshTokenSeconds * 1000),
  })
  return token
}

/**
 * Redeem and rotate. Returns null when the token is unknown, expired, already
 * used, or presented by a different client — all of which the caller must
 * surface as `invalid_grant` (Claude treats `invalid_request` differently and
 * will not re-authenticate).
 */
export async function rotateRefreshToken(
  token: string,
  clientId: string,
  requestedScope?: string,
): Promise<{ subject: string; scope: string; refreshToken: string } | null> {
  const existing = await db
    .select()
    .from(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.tokenHash, hash(token)),
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.replacedAt),
        gt(oauthRefreshTokens.expiresAt, new Date()),
      ),
    )
    .limit(1)

  const row = existing[0]
  if (!row || !normalizeScope(row.scope)) return null
  const scope = requestedScope === undefined ? row.scope : normalizeScope(requestedScope)
  if (!scope || scope.split(' ').some((s) => !row.scope.split(/\s+/).includes(s))) return null

  await db
    .update(oauthRefreshTokens)
    .set({ replacedAt: new Date() })
    .where(eq(oauthRefreshTokens.tokenHash, row.tokenHash))

  const refreshToken = await issueRefreshToken({
    subject: row.subject,
    clientId: row.clientId,
    scope,
  })

  return { subject: row.subject, scope, refreshToken }
}

/** PKCE S256 check. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url')
  return computed === challenge
}

