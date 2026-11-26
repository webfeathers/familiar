/**
 * One connector per source. Connectors talk to their vendor and nothing else:
 * they do not interpret, and they NEVER call an LLM. Adding a source later is
 * one new file satisfying this interface.
 *
 * Credential note: the worker runs headless on a schedule, so every
 * connector authenticates with a server-side credential the worker holds — a
 * stored refresh token or API token. An interactively-authenticated MCP
 * connection is absent in a cron run and cannot be the ingestion path.
 */
import type { NewEpisode, Source } from '../store/schema.ts'

export interface Connector {
  readonly source: Source
  /**
   * Return every episode from this source at or after `since`.
   * Must be idempotent: re-running with the same `since` produces rows that
   * upsert cleanly on (source, sourceRef) rather than duplicating.
   */
  sync(since: Date): Promise<NewEpisode[]>
}
