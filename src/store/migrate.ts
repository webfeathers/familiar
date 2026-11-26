/**
 * Apply pending migrations from `drizzle/`, at worker start, and report
 * whether any are pending.
 *
 * Migrations used to be a hand step (`railway run pnpm db:migrate`), which made
 * every schema change depend on someone remembering it after the deploy, with
 * the code already live against the old schema. The worker is the one process
 * that starts exactly once per deploy, so it applies them. The same journal
 * table drizzle-kit writes (`drizzle.__drizzle_migrations`) decides what is
 * pending, so a hand-run `pnpm db:migrate` and this agree.
 *
 * A migration that fails here is only logged, and the logs are not somewhere
 * most sessions can read. `migrationState` is the visible half: `/healthz`
 * publishes it, so "did the schema change land" is one unauthenticated GET.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db } from './index.ts'

/** `drizzle/` sits two levels above this file in both `src/` and `dist/`. */
const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))

export async function applyMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS })
}

/**
 * `current`, or how many migrations in this build have not been applied.
 * `unknown` when the journal or the database cannot be read: never a guess.
 *
 * drizzle records each applied migration with the `when` stamp from the
 * journal, so "pending" is every journal entry stamped after the newest row.
 */
export async function migrationState(): Promise<string> {
  try {
    const journal = JSON.parse(await readFile(`${MIGRATIONS}/meta/_journal.json`, 'utf8')) as {
      entries: { when: number; tag: string }[]
    }
    const result = await db.execute(sql`select max(created_at) as latest from drizzle.__drizzle_migrations`)
    const latest = Number((result.rows[0] as { latest: string | null } | undefined)?.latest ?? 0)
    const pending = journal.entries.filter((e) => e.when > latest)
    return pending.length ? `${pending.length} pending (next: ${pending[0]!.tag})` : 'current'
  } catch {
    return 'unknown'
  }
}
