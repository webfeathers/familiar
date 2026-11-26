/**
 * The MCP service. Thin by design: auth, validation, delegation — no logic of
 * its own.
 *
 * Transport is Streamable HTTP on a single path. POST carries every tool call;
 * GET is refused with 405 because nothing here is ever pushed (see below).
 * Session state is deliberately avoided: MCP revision 2026-07-28 goes stateless
 * (dropping `initialize` and `Mcp-Session-Id`), so leaning on it now would just
 * buy a migration later.
 */
import { serve } from '@hono/node-server'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { hasScope } from './scopes.ts'
import { ISSUER } from './config.ts'
import { wwwAuthenticate } from './metadata.ts'
import { oauth } from './oauth.ts'
import { verifyAccessToken } from './tokens.ts'
import { migrationState } from '../store/migrate.ts'

const app = new Hono<{ Variables: { scope: string; subject: string; clientId: string } }>()

app.route('/', oauth)

/**
 * Health, plus the two facts every "is it live" question needs and that used to
 * take a Railway login to answer: which commit this process was built from, and
 * whether the database schema matches it. Neither is sensitive. The migration
 * state is cached briefly because a platform health check may poll this.
 */
const COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown').slice(0, 7)
let schema = { value: 'unknown', at: 0 }
app.get('/healthz', async (c) => {
  if (Date.now() - schema.at > 30_000) schema = { value: await migrationState(), at: Date.now() }
  return c.json({ ok: true, issuer: ISSUER, commit: COMMIT, migrations: schema.value })
})

/**
 * Bearer enforcement.
 *
 * Two things that look like details and are not:
 *  - The challenge MUST be a 401. Claude does not honour `WWW-Authenticate` on a
 *    200 response, so returning 200 with an error body yields no sign-in prompt
 *    at all — the connector just silently does nothing.
 *  - It applies to EVERY method on /mcp, including GET and DELETE. Sessions must
 *    not be a way to authenticate.
 */
app.use('/mcp', async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : null

  if (!token) {
    return c.json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate': wwwAuthenticate('invalid_request', 'missing bearer token'),
    })
  }

  const claims = await verifyAccessToken(token)
  if (!claims) {
    return c.json({ error: 'invalid_token' }, 401, {
      'WWW-Authenticate': wwwAuthenticate('invalid_token', 'token is expired or not for this resource'),
    })
  }

  if (!hasScope(claims.scope, 'context:read')) {
    return c.json({ error: 'insufficient_scope' }, 403, {
      'WWW-Authenticate': wwwAuthenticate('insufficient_scope', 'context:read is required'),
    })
  }

  c.set('subject', claims.sub)
  c.set('clientId', claims.client_id)
  c.set('scope', claims.scope)
  await next()
})

/**
 * No server-initiated stream on offer.
 *
 * Every tool here is request/response; nothing is ever pushed. Serving the GET
 * stream therefore buys a socket that carries nothing but the transport's own
 * 30s keep-alive pings, and it is torn down on a 900s clock regardless, which
 * reaches the client as a "Server disconnected" toast. 405 is how the spec says
 * "this endpoint has no SSE stream"; the SDK client treats it as expected and
 * stops asking, rather than reconnecting on a loop.
 *
 * If a tool ever needs to push (progress, logging, subscriptions), delete this
 * and give the stream a reason to exist.
 */
app.get('/mcp', (c) =>
  c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed: no server-initiated stream' },
      id: null,
    },
    405,
    // RFC 9110 requires a 405 to list what IS allowed. The transport's own 405
    // says "GET, POST, DELETE"; with GET refused here, that is POST and DELETE.
    { Allow: 'POST, DELETE' },
  ),
)

app.all('/mcp', async (c) => {
  const server = new McpServer({ name: 'familiar', version: '0.1.0' })
  const { registerTools } = await import('./tools.ts')
  registerTools(server, c.get('scope'), `${c.get('subject')} via ${c.get('clientId')}`,
    wwwAuthenticate('insufficient_scope', 'context:write is required'))

  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  return transport.handleRequest(c)
})

const port = Number(process.env.PORT ?? 8080)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mcp listening on :${info.port}`)
  console.log(`issuer   ${ISSUER}`)
  console.log(`resource ${ISSUER}/mcp`)
})

export { app }

