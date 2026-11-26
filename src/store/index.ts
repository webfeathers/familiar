/**
 * The only place SQL lives. Everything else goes through repository functions
 * exported from this module. If the deriver is writing raw SQL, the design has
 * failed (see the module boundaries in the design spec).
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.ts'
import { runtimeDatabaseUrl } from './url.ts'

export const pool = new pg.Pool({ connectionString: runtimeDatabaseUrl() })
export const db = drizzle(pool, { schema })
export { schema }
export * from './schema.ts'
