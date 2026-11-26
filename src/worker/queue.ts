/**
 * pg-boss on the same Postgres — no Redis. One fewer service to secure and pay
 * for, and for one person's volume this is nowhere near a bottleneck.
 */
import { PgBoss } from 'pg-boss'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

export const boss = new PgBoss({ connectionString })

// pg-boss re-emits every pool error (an idle connection reset by the network,
// a supervisor query timing out) as an 'error' event on `boss`. With no
// listener, Node treats that as unhandled and exits the process — which is how
// the worker died on 2026-08-31 and stayed dead for ten days. The pool replaces
// the broken client on its own; the only thing to do here is say so.
boss.on('error', (e) => console.error('pg-boss error:', e))

export const QUEUES = {
  /** Scheduled connector pull. */
  sync: 'sync',
  /** Daily retention sweep over dead OAuth rows. */
  prune: 'prune',
} as const

export interface SyncJob {
  source: string
}
