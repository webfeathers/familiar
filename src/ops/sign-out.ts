/**
 * `pnpm auth:signout` — sign every client out.
 *
 * Deletes every refresh token and any unredeemed authorization code. Connected
 * clients keep working until their current access token expires (an hour at
 * most) and must then sign in again.
 *
 * To end access immediately as well, set a new AUTH_SECRET and restart the MCP
 * service: every outstanding access token stops verifying at once. Rotating
 * the secret on its own is NOT enough, because refresh tokens are database
 * rows rather than signed tokens and would simply mint new access tokens.
 *
 * Use this if a device is lost, a token may have leaked, or you just want a
 * clean slate. It touches nothing but sign-in state; memory is untouched.
 */
import pg from 'pg'
import { toolingDatabaseUrl } from '../store/url.ts'

const pool = new pg.Pool({ connectionString: toolingDatabaseUrl(), connectionTimeoutMillis: 8000 })
try {
  const tokens = await pool.query('delete from oauth_refresh_tokens')
  const codes = await pool.query('delete from oauth_codes')
  console.log(`Signed out: ${tokens.rowCount ?? 0} refresh token(s) and ${codes.rowCount ?? 0} code(s) deleted.`)
  console.log('Clients must sign in again within the hour. For immediate effect, also set a new')
  console.log('AUTH_SECRET (openssl rand -base64 32) and restart the MCP service.')
} catch (e) {
  console.error(`✗ Sign-out failed: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await pool.end().catch(() => {})
}
