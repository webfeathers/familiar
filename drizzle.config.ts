import type { Config } from 'drizzle-kit'
import { toolingDatabaseUrl } from './src/store/url.ts'

// Migrations run from a laptop, so this must be the publicly routable URL —
// the private .railway.internal host does not resolve off-platform.
export default {
  schema: './src/store/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: toolingDatabaseUrl() },
} satisfies Config
