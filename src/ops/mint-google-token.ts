/**
 * One-time helper: mint a long-lived Google refresh token for calendar ingest.
 *
 *   pnpm mint:google work
 *   pnpm mint:google personal
 *
 * Runs a loopback OAuth flow on localhost, then prints the refresh token and
 * your Google `sub` TO YOUR TERMINAL. You paste them into .env yourself — this
 * script never writes secrets to disk.
 *
 * `access_type=offline` + `prompt=consent` is what makes Google return a refresh
 * token at all; without both you get an access token only.
 *
 * NOTE: if the OAuth consent screen is External + Testing, the token this prints
 * is revoked after 7 days. See docs/CREDENTIALS.md — use an Internal (Workspace)
 * app, or share the personal calendar into the Workspace account.
 */
import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'

const PORT = 4711
const REDIRECT_URI = `http://localhost:${PORT}/callback`
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
]

const label = process.argv[2]
if (label !== 'work' && label !== 'personal') {
  console.error('usage: pnpm mint:google <work|personal>')
  process.exit(1)
}

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error(
    'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET must be set in .env first (step 3 of docs/CREDENTIALS.md).',
  )
  process.exit(1)
}

// PKCE — required by OAuth 2.1 and good practice even for a loopback client.
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const state = randomBytes(16).toString('base64url')

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', clientId)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES.join(' '))
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')
authUrl.searchParams.set('code_challenge', challenge)
authUrl.searchParams.set('code_challenge_method', 'S256')
authUrl.searchParams.set('state', state)

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1]
  if (!part) return {}
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname !== '/callback') {
    res.writeHead(404).end()
    return
  }

  const err = url.searchParams.get('error')
  if (err) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(`Denied: ${err}`)
    console.error(`\n✗ Authorization denied: ${err}`)
    server.close()
    process.exit(1)
  }

  if (url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('State mismatch.')
    console.error('\n✗ State mismatch — aborting.')
    server.close()
    process.exit(1)
  }

  const code = url.searchParams.get('code')
  if (!code) {
    res.writeHead(400).end()
    return
  }

  // Token endpoint is form-urlencoded (RFC 6749), not JSON.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })

  const body = (await tokenRes.json()) as {
    refresh_token?: string
    id_token?: string
    error?: string
    error_description?: string
  }

  if (!tokenRes.ok) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Token exchange failed.')
    console.error(`\n✗ Token exchange failed: ${body.error} — ${body.error_description}`)
    server.close()
    process.exit(1)
  }

  res
    .writeHead(200, { 'content-type': 'text/html' })
    .end('<h1>Done</h1><p>Refresh token printed in your terminal. You can close this tab.</p>')

  const envVar = `GOOGLE_REFRESH_TOKEN_${label.toUpperCase()}`

  if (!body.refresh_token) {
    console.error(
      '\n✗ No refresh_token returned. Google only re-issues one with prompt=consent, and will\n' +
        '  omit it if this app was already authorised. Revoke at\n' +
        '  https://myaccount.google.com/permissions and run this again.',
    )
    server.close()
    process.exit(1)
  }

  const claims = body.id_token ? decodeJwtPayload(body.id_token) : {}

  console.log('\n─────────────────────────────────────────────────────────────')
  console.log('Paste these into .env yourself. They are secrets — do not share.\n')
  console.log(`${envVar}=${body.refresh_token}`)
  // ALLOWED_SUBJECT is the Google `sub` only when Google is the sign-in
  // provider; with GitHub or OIDC it is that provider's identifier instead.
  const googleSignIn = (process.env.AUTH_PROVIDER?.trim() || 'google').toLowerCase() === 'google'
  if (claims.sub && googleSignIn) {
    console.log(`\n# Signed in as ${claims.email ?? '(unknown email)'}`)
    console.log(`ALLOWED_SUBJECT=${claims.sub}`)
  }
  console.log('─────────────────────────────────────────────────────────────')
  console.log('\nThen verify with: pnpm doctor')

  server.close()
  process.exit(0)
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n✗ Port ${PORT} is already in use — almost certainly an abandoned run of\n` +
        `  this script still listening (it only exits on a successful callback).\n\n` +
        `  Clear it with:  lsof -ti tcp:${PORT} | xargs kill\n`,
    )
  } else {
    console.error(`\n✗ Could not start the callback server: ${err.message}`)
  }
  process.exit(1)
})

// Don't leave a listener running forever if the flow is abandoned — that is
// what silently blocks the NEXT attempt with EADDRINUSE.
const abandonTimer = setTimeout(
  () => {
    console.error('\n✗ No callback within 5 minutes — giving up so the port is freed.')
    server.close()
    process.exit(1)
  },
  5 * 60_000,
)
abandonTimer.unref()

process.on('SIGINT', () => {
  server.close()
  process.exit(130)
})

server.listen(PORT, () => {
  console.log(`\nOpen this URL to authorise the ${label} account:\n\n${authUrl}\n`)
  console.log(`Waiting on ${REDIRECT_URI} … (Ctrl-C to cancel)`)
})
