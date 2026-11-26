/**
 * Retention for the OAuth authorization-server tables.
 *
 * Refresh tokens rotate on every use (hourly, in practice), and each rotation
 * marks the old row replaced and inserts a successor. Nothing ever deleted
 * either kind of dead row, so for one user the table measured 322 rows with 2
 * live after 36 days, and grows without bound.
 *
 * Deleting them is invisible to clients. Every lookup — `rotateRefreshToken`
 * in src/mcp/tokens.ts, code redemption in src/mcp/oauth.ts — already filters
 * to unreplaced/unredeemed and unexpired rows, and there is no reuse detection
 * that reads replaced rows. A pruned token and a replaced one both fail as
 * `invalid_grant`.
 *
 * The retention windows keep recent dead rows around for debugging an auth
 * problem after the fact; they are not load-bearing.
 */
import { and, isNotNull, lt, or } from 'drizzle-orm'
import { db } from './index.ts'
import { oauthCodes, oauthRefreshTokens } from './schema.ts'

const REFRESH_TOKEN_RETENTION_MS = 7 * 24 * 3600_000
/** Codes live 60 seconds; a day is ample to see a failed exchange. */
const CODE_RETENTION_MS = 24 * 3600_000

export async function pruneAuthState(now = new Date()): Promise<{
  refreshTokens: number
  codes: number
}> {
  const tokenCutoff = new Date(now.getTime() - REFRESH_TOKEN_RETENTION_MS)
  const tokens = await db
    .delete(oauthRefreshTokens)
    .where(
      or(
        and(
          isNotNull(oauthRefreshTokens.replacedAt),
          lt(oauthRefreshTokens.replacedAt, tokenCutoff),
        ),
        lt(oauthRefreshTokens.expiresAt, tokenCutoff),
      ),
    )
    .returning({ tokenHash: oauthRefreshTokens.tokenHash })

  // Every code expires 60 seconds after issue whether or not it was redeemed,
  // so `expires_at` alone covers both.
  const codeCutoff = new Date(now.getTime() - CODE_RETENTION_MS)
  const codes = await db
    .delete(oauthCodes)
    .where(lt(oauthCodes.expiresAt, codeCutoff))
    .returning({ code: oauthCodes.code })

  return { refreshTokens: tokens.length, codes: codes.length }
}
