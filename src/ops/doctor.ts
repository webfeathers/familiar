/**
 * `pnpm doctor` — verify every credential is present AND actually works.
 *
 * Presence checks are worthless on their own: a typo'd token is present. So each
 * check does the cheapest real call that proves the credential.
 *
 * Secret values are NEVER printed — only present/absent and pass/fail.
 */
import pg from 'pg'
import { toolingDatabaseUrl } from '../store/url.ts'

type Status = 'ok' | 'fail' | 'skip'
interface Result {
  name: string
  status: Status
  detail: string
}

const results: Result[] = []
const record = (name: string, status: Status, detail: string) =>
  results.push({ name, status, detail })

const present = (k: string) => {
  const v = process.env[k]
  return typeof v === 'string' && v.length > 0
}

// ── 1. Required env presence ─────────────────────────────────────────────────

const MCP_VARS = ['PUBLIC_URL', 'ALLOWED_SUBJECT'] as const
const GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const

for (const key of [...MCP_VARS, ...GOOGLE_VARS]) {
  record(
    `env ${key}`,
    present(key) ? 'ok' : 'fail',
    present(key) ? 'set' : 'missing',
  )
}

// The signing secret goes by two names, and src/mcp/tokens.ts accepts either:
// AUTH_SECRET is the documented one, BETTER_AUTH_SECRET the legacy alias. Check
// what the code reads, or a setup that follows .env.example fails here while
// working fine.
record(
  'env AUTH_SECRET',
  present('AUTH_SECRET') || present('BETTER_AUTH_SECRET') ? 'ok' : 'fail',
  present('AUTH_SECRET')
    ? 'set'
    : present('BETTER_AUTH_SECRET')
      ? 'set (as legacy BETTER_AUTH_SECRET)'
      : 'missing (AUTH_SECRET or BETTER_AUTH_SECRET)',
)

// ── 2. Postgres: reachable, pgvector installed, migrations applied ───────────

const hasDb = present('DATABASE_URL') || present('DATABASE_PUBLIC_URL')

// No URL at all is the documented laptop setup, not a fault: Postgres lives on
// Railway and `railway run --service Postgres` injects it on demand, so no
// database credential has to sit in .env. Skip rather than fail, or the health
// check fails on a machine that is set up correctly. Still flag the mistake
// that silently breaks local migrations: only the private URL is available,
// and it does not resolve off-platform.
record(
  'env DATABASE_URL',
  hasDb ? 'ok' : 'skip',
  present('DATABASE_PUBLIC_URL')
    ? 'DATABASE_PUBLIC_URL set (correct for local tooling)'
    : present('DATABASE_URL')
      ? 'only the private DATABASE_URL is set — fine inside Railway, unreachable from a laptop'
      : 'not set locally — expected; run `railway run --service Postgres pnpm doctor` to check the database',
)

if (hasDb) {
  const pool = new pg.Pool({
    connectionString: toolingDatabaseUrl(),
    connectionTimeoutMillis: 8000,
  })
  try {
    const ext = await pool.query(
      `select 1 from pg_extension where extname = 'vector'`,
    )
    record(
      'postgres connect',
      'ok',
      'reachable',
    )
    record(
      'postgres pgvector',
      ext.rowCount ? 'ok' : 'fail',
      ext.rowCount
        ? 'extension installed'
        : "extension missing — run pnpm db:migrate (needs the pgvector/pgvector image, not plain postgres)",
    )
    const tables = await pool.query(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('episodes','entities','observations','links')`,
    )
    const n = tables.rows[0]?.n ?? 0
    record(
      'postgres schema',
      n === 4 ? 'ok' : 'fail',
      n === 4 ? 'all 4 tables present' : `${n}/4 tables — run pnpm db:migrate`,
    )
  } catch (e) {
    record('postgres connect', 'fail', (e as Error).message)
  } finally {
    await pool.end().catch(() => {})
  }
} else {
  record('postgres connect', 'skip', 'no database URL in this environment')
}

// ── 3. Google refresh tokens: still exchangeable ─────────────────────────────
// This is the check that catches the 7-day External+Testing revocation — a token
// revoked by Google returns invalid_grant here, long before ingestion breaks.

for (const label of ['WORK', 'PERSONAL'] as const) {
  const key = `GOOGLE_REFRESH_TOKEN_${label}`
  if (!present(key)) {
    record(
      `google token ${label.toLowerCase()}`,
      'skip',
      label === 'PERSONAL'
        ? 'not set — expected; the shared calendar is read via the work credential'
        : 'not set',
    )
    continue
  }
  if (!present('GOOGLE_CLIENT_ID') || !present('GOOGLE_CLIENT_SECRET')) {
    record(`google token ${label.toLowerCase()}`, 'skip', 'client id/secret missing')
    continue
  }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: process.env[key]!,
        grant_type: 'refresh_token',
      }),
    })
    const body = (await res.json()) as { error?: string }
    record(
      `google token ${label.toLowerCase()}`,
      res.ok ? 'ok' : 'fail',
      res.ok
        ? 'exchangeable'
        : body.error === 'invalid_grant'
          ? 'invalid_grant — revoked or expired. If the consent screen is External+Testing, Google revokes after 7 days; see docs/CREDENTIALS.md'
          : `${body.error ?? res.status}`,
    )
  } catch (e) {
    record(`google token ${label.toLowerCase()}`, 'fail', (e as Error).message)
  }
}

// ── 4. PUBLIC_URL shape ───────────────────────────────────────────────────────
// Must be the exact https origin used as the AS `issuer`. A hardcoded IP or a
// trailing slash silently breaks discovery.

if (present('PUBLIC_URL')) {
  const raw = process.env.PUBLIC_URL!
  const problems: string[] = []
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.hostname !== 'localhost')
      problems.push('must be https')
    if (raw.endsWith('/')) problems.push('no trailing slash')
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname))
      problems.push('hostname must not be a bare IP')
    record(
      'public url',
      problems.length ? 'fail' : 'ok',
      problems.length ? problems.join('; ') : 'well-formed',
    )
  } catch {
    record('public url', 'fail', 'not a valid URL')
  }
} else {
  record('public url', 'skip', 'not set')
}

// ── Report ───────────────────────────────────────────────────────────────────

const icon = { ok: '✓', fail: '✗', skip: '–' } as const
const width = Math.max(...results.map((r) => r.name.length))
console.log()
for (const r of results) {
  console.log(`${icon[r.status]} ${r.name.padEnd(width)}  ${r.detail}`)
}

const failed = results.filter((r) => r.status === 'fail').length
const skipped = results.filter((r) => r.status === 'skip').length
console.log(
  `\n${results.length - failed - skipped} ok, ${failed} failed, ${skipped} skipped\n`,
)
process.exit(failed > 0 ? 1 : 0)
