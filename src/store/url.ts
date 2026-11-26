/**
 * Railway exposes two connection strings and they are not interchangeable:
 *
 *   DATABASE_URL         → postgres.railway.internal — private network, free,
 *                          fast, and ONLY resolvable from inside Railway.
 *   DATABASE_PUBLIC_URL  → *.proxy.rlwy.net — TCP proxy, reachable anywhere,
 *                          slower and billed for egress.
 *
 * So the right choice depends on *where the process runs*, not on preference:
 *
 *   - Deployed services (mcp, worker) run inside Railway → private URL.
 *   - CLI tooling (migrations, doctor) runs on a laptop → public URL.
 *
 * Getting this wrong fails opaquely: drizzle-kit swallows the connection error
 * and just exits 1 under a spinner.
 */

/**
 * For long-lived services (mcp, worker).
 *
 * In production these run inside Railway, where the private URL is correct —
 * free, fast, and not exposed. Outside production the private hostname does not
 * resolve, and the failure is confusing: the app boots fine and then every
 * query dies with `ENOTFOUND postgres.railway.internal`, which reads like a
 * database outage rather than a config mismatch.
 *
 * So: production uses the private URL, everything else prefers the public one.
 */
export function runtimeDatabaseUrl(): string {
  const isProd = process.env.NODE_ENV === 'production'
  const url = isProd
    ? process.env.DATABASE_URL
    : (process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL)
  if (!url) {
    throw new Error(
      isProd
        ? 'DATABASE_URL is not set'
        : 'Neither DATABASE_PUBLIC_URL nor DATABASE_URL is set — run via `railway run`.',
    )
  }
  return url
}

/**
 * For CLI tooling run from a developer machine. Prefers the publicly routable
 * URL, because the private hostname does not resolve off-platform.
 *
 * In production we simply do not set DATABASE_PUBLIC_URL on the app services,
 * so this collapses to the private URL there.
 */
export function toolingDatabaseUrl(): string {
  const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'Neither DATABASE_PUBLIC_URL nor DATABASE_URL is set. Run via `railway run`, ' +
        'or copy DATABASE_PUBLIC_URL from the Postgres service into .env.',
    )
  }
  return url
}
