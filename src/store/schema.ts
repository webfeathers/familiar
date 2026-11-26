/**
 * The only place the shape of the store is defined.
 *
 * Two disciplines carry the whole design:
 *   1. Append-only + bi-temporal. Nothing is ever destructively overwritten.
 *      A superseded fact gets `validTo`/`invalidatedAt` set; it is never UPDATEd
 *      in place and never hard-deleted (except the `forget` tool and PII purges).
 *      Two clocks: *valid time* (when it was true) vs *ingestion time* (when we
 *      learned it) — which is what makes "what did I believe on date X" answerable.
 *   2. Atomic observations, not prose. Consolidation deduplicates; it never
 *      summarizes. Summarizing destroys the atomicity that makes a single wrong
 *      belief surgically correctable.
 */
import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  real,
  integer,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core'

// ── Postgres types Drizzle has no first-class builder for ────────────────────

/** pgvector. 1536 dims = OpenAI-compatible small embedding; change with a migration. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector(1536)',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
})

/** Generated tsvector for BM25-ish full-text candidate generation. */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

// ── Enumerated vocabularies ──────────────────────────────────────────────────
// Kept as TS unions + text columns rather than PG enums: adding a source or an
// entity type shouldn't require an ALTER TYPE migration.

export const SOURCES = [
  'gcal_work',
  'gcal_personal',
  'google_contacts',
  'gmail',
  'era_finance',
  'work_seed',
  'conversation',
  'manual',
] as const
export type Source = (typeof SOURCES)[number]

export const ENTITY_TYPES = [
  'unknown',
  'person',
  'org',
  'project',
  'place',
  'commitment',
  'account',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

/**
 * Decay is per-category — never a single global TTL.
 *   state      — recency-wins ("the meeting moved to 3pm")
 *   attribute  — durable; MUST NOT decay ("spouse is Dave")
 *   event      — happened at a point in time; never invalidated, only aged out
 *   preference — durable but revisable
 */
export const OBSERVATION_CATEGORIES = [
  'state',
  'attribute',
  'event',
  'preference',
  /**
   * A forward-looking inference, not an established fact — "you usually meet
   * Anton weekly and nothing is scheduled". Kept in the same table so it
   * inherits provenance and `forget`, but categorised apart so it is never
   * presented with the authority of something observed, and so it can expire
   * on its own: an anticipation that has gone stale is worse than none.
   */
  'anticipation',
] as const
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number]

// ── episodes — latest ingested source version ────────────────────────────────
// Connectors update changed versions in place, so this table alone is not a
// complete historical log.

export const episodes = pgTable(
  'episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<Source>().notNull(),
    /** External id from the source. Unique per source ⇒ sync is idempotent. */
    sourceRef: text('source_ref').notNull(),
    kind: text('kind').notNull(),
    body: jsonb('body').notNull(),
    /** Valid time: when the thing happened. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Ingestion time: when we learned about it. */
    ingestedAt: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Set when the deriver consumed the episode. The deriver was removed on
     * 2026-09-10, so nothing writes this now; the column is kept to avoid a
     * migration and because existing values record what was derived.
     */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    dedupHash: text('dedup_hash').notNull(),
    tsv: tsvector('tsv'),
    embedding: vector('embedding'),
  },
  (t) => [
    uniqueIndex('episodes_source_ref_idx').on(t.source, t.sourceRef),
    index('episodes_occurred_at_idx').on(t.occurredAt),
    index('episodes_unprocessed_idx').on(t.processedAt),
    // Matches the expression `searchEpisodes` filters on, so full-text search
    // reads the index instead of tokenising every stored body per query.
    index('episodes_body_fts_idx').using('gin', sql`to_tsvector('english', ${t.body}::text)`),
  ],
)

// ── entities — the things in a life ──────────────────────────────────────────

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').$type<EntityType>().notNull(),
    canonicalName: text('canonical_name').notNull(),
    /**
     * Short prose. Load-bearing: the resolution judge compares candidates on
     * name AND summary, which is what keeps two different Daves apart.
     */
    summary: text('summary'),
    aliases: text('aliases').array().notNull().default([]),
    /** Entity merges are soft — the losing row survives, pointing at the winner. */
    mergedInto: uuid('merged_into'),
    /** Low-confidence provisional entity awaiting correction (judge said ambiguous). */
    provisional: text('provisional'),
    /**
     * When the reflection pass last consolidated this entity. Null means never.
     * Used to gate reflection on *new material* rather than on a timer — the
     * point is to reason when there is something new to reason about.
     */
    reflectedAt: timestamp('reflected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    tsv: tsvector('tsv'),
    embedding: vector('embedding'),
  },
  (t) => [
    index('entities_type_idx').on(t.type),
    index('entities_merged_into_idx').on(t.mergedInto),
  ],
)

// ── observations — atomic derived facts ──────────────────────────────────────
// What the original sketch called "beliefs". One atomic statement per row, so
// `forget` is a single-row delete and invalidation is surgical.

export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** Exactly one atomic fact. If it contains "and", it should be two rows. */
    statement: text('statement').notNull(),
    category: text('category').$type<ObservationCategory>().notNull(),
    confidence: real('confidence').notNull(),
    /** Provenance — every derived belief points back at what produced it. */
    sourceEpisodeIds: uuid('source_episode_ids').array().notNull().default([]),
    /**
     * How many times this was observed. Only preferences grow it: a restated
     * preference is reinforced rather than duplicated, and this is the "seen N×"
     * that `how_i_work` shows. It used to be derived from `sourceEpisodeIds`,
     * which the MCP path never fills, so every preference read "seen 1×" however
     * often it had been reinforced.
     */
    observationCount: integer('observation_count').notNull().default(1),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    /** The observation that superseded this one. */
    invalidatedBy: uuid('invalidated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    tsv: tsvector('tsv'),
    embedding: vector('embedding'),
  },
  (t) => [
    index('observations_entity_idx').on(t.entityId),
    index('observations_live_idx').on(t.entityId, t.invalidatedAt),
    index('observations_category_idx').on(t.category),
    // Matches the expression `searchFacts`, `get_context` topics and the
    // similar-fact check on `remember` filter on.
    index('observations_statement_fts_idx').using('gin', sql`to_tsvector('english', ${t.statement})`),
  ],
)

// ── links — typed entity↔entity relations ────────────────────────────────────
// Same bi-temporal, append-only discipline as observations.

export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromEntity: uuid('from_entity')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    toEntity: uuid('to_entity')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull(),
    confidence: real('confidence').notNull(),
    sourceEpisodeIds: uuid('source_episode_ids').array().notNull().default([]),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('links_from_idx').on(t.fromEntity),
    index('links_to_idx').on(t.toEntity),
    uniqueIndex('links_unique_live_idx').on(
      t.fromEntity,
      t.toEntity,
      t.relation,
      t.validFrom,
    ),
  ],
)

// ── Ingestion watermarks ─────────────────────────────────────────────────────

/**
 * Per-source sync position. Kept separate from `episodes` so a connector can be
 * re-run from an earlier point without deleting anything: episodes upsert by
 * (source, source_ref), so replaying an overlapping window is harmless.
 *
 * `cursor` holds an opaque provider token (Google's syncToken, say) when the
 * provider offers one; `lastSyncedAt` is the portable fallback.
 */
export const syncState = pgTable('sync_state', {
  source: text('source').$type<Source>().primaryKey(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  cursor: text('cursor'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastError: text('last_error'),
})

// ── Retired tables ───────────────────────────────────────────────────────────
// `derivation_runs`, `provider_spend_reservations` and `memory_proposals`
// belonged to the shadow deriver and the reviewed-memory path, both removed on
// 2026-11-21. NO CODE IN THIS REPO READS OR WRITES THEM. They stay defined so
// the tables are documented where the schema lives and so drizzle-kit does not
// generate a DROP: something outside the repo may still read them, and their
// rows are the only record of what the deriver saw. `memory_proposals` held no
// approved row at removal, so no live fact depends on it.

export const DERIVATION_STATES = [
  'pending',
  'succeeded',
  'held',
  'rejected',
  'failed',
] as const
export type DerivationState = (typeof DERIVATION_STATES)[number]

/**
 * One immutable audit envelope per episode version and pipeline version.
 * Candidate details stay JSON because they are evidence about a run, not a
 * second canonical memory model. The shadow milestone never writes an
 * observation; `createdObservationIds` exists for the later, explicit rollout.
 */
export const derivationRuns = pgTable(
  'derivation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    pipelineVersion: text('pipeline_version').notNull(),
    state: text('state').$type<DerivationState>().notNull().default('pending'),
    scopeDecision: jsonb('scope_decision'),
    extractorProvider: text('extractor_provider'),
    extractorModel: text('extractor_model'),
    candidates: jsonb('candidates').notNull().default([]),
    baselineDecisions: jsonb('baseline_decisions').notNull().default([]),
    jevProvider: text('jev_provider'),
    jevModel: text('jev_model'),
    jevResult: jsonb('jev_result'),
    jevSkipReason: text('jev_skip_reason'),
    usage: jsonb('usage'),
    totalCostUsd: real('total_cost_usd').notNull().default(0),
    errorClass: text('error_class'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    createdObservationIds: uuid('created_observation_ids').array().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('derivation_runs_key_idx').on(
      t.episodeId,
      t.contentHash,
      t.pipelineVersion,
    ),
    index('derivation_runs_state_idx').on(t.state),
    index('derivation_runs_created_at_idx').on(t.createdAt),
  ],
)

/** Durable, conservative reservations make the shared provider budget atomic. */
export const providerSpendReservations = pgTable(
  'provider_spend_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    amountUsd: real('amount_usd').notNull(),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  },
  (t) => [index('provider_spend_reservations_reserved_at_idx').on(t.reservedAt)],
)

// ── OAuth authorization-server state ─────────────────────────────────────────
// The MCP service is its own authorization server.
// There is deliberately no user table: the "user database" is ALLOWED_SUBJECT,
// one env var, compared against the Google `sub`. These three tables are the
// entire persistent auth surface.

/**
 * Per-client consent. The confused-deputy mitigation is a genuine MUST here:
 * we hold a static client_id at Google while accepting arbitrary MCP clients,
 * which is exactly the vulnerable configuration the MCP spec names. A row here
 * means the human approved *this* client_id — recorded only after approval.
 */
export const oauthConsents = pgTable(
  'oauth_consents',
  {
    clientId: text('client_id').primaryKey(),
    /** Snapshot of the CIMD document we resolved the client from, for audit. */
    clientMetadata: jsonb('client_metadata'),
    approvedAt: timestamp('approved_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
)

/** Authorization codes. Single-use, short-lived, PKCE-bound. */
export const oauthCodes = pgTable(
  'oauth_codes',
  {
    code: text('code').primaryKey(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    scope: text('scope').notNull(),
    subject: text('subject').notNull(),
    /** RFC 8707 resource, when the client bothers to send one. claude.ai does not. */
    resource: text('resource'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set once redeemed — replay of a used code must fail. */
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  },
  (t) => [index('oauth_codes_expiry_idx').on(t.expiresAt)],
)

/**
 * Refresh tokens. Stored as a SHA-256 hash — a database read must not yield a
 * usable credential. Rotation is a MUST for public clients, so redeeming one
 * issues a successor and marks this row replaced.
 */
export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    clientId: text('client_id').notNull(),
    subject: text('subject').notNull(),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('oauth_refresh_client_idx').on(t.clientId)],
)

export type Episode = typeof episodes.$inferSelect
export type NewEpisode = typeof episodes.$inferInsert
export type Entity = typeof entities.$inferSelect
export type NewEntity = typeof entities.$inferInsert
export type Observation = typeof observations.$inferSelect
export type NewObservation = typeof observations.$inferInsert
export type Link = typeof links.$inferSelect
export type NewLink = typeof links.$inferInsert
export type SyncState = typeof syncState.$inferSelect


/** Immutable review payload; only the review decision/receipt changes. No automatic promotion. */
export interface MemoryEvidence {
  connector?: Record<string, unknown>
  sourceUrl?: string
  observedAt?: string
  commitSha?: string | null
  provenance: 'client_asserted' | 'client_reported_external' | 'client_reported_connector' | 'ingested_source'
  reportedBy: string | null
  episodeId: string
  source: Source
  sourceRef: string
  contentHash: string
  quote: string
  attributedTo: string
  occurredAt: string
}
export const memoryProposals = pgTable('memory_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestKey: text('request_key').notNull(),
  payloadHash: text('payload_hash').notNull(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  statement: text('statement').notNull(),
  category: text('category').$type<'state' | 'attribute' | 'event'>().notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  evidence: jsonb('evidence').$type<MemoryEvidence[]>().notNull(),
  supersedes: uuid('supersedes').array().notNull().default([]),
  derivationRunId: uuid('derivation_run_id'),
  candidateIndex: integer('candidate_index'),
  state: text('state').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
  observationId: uuid('observation_id'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  reviewedBy: text('reviewed_by'),
  policyReceipt: jsonb('policy_receipt').$type<Record<string, unknown>>(),
  confirmationMethod: text('confirmation_method').$type<'client_attested_owner_confirmation' | 'delegated_connector_policy'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('memory_proposals_request_key_idx').on(t.requestKey),
  uniqueIndex('memory_proposals_candidate_idx').on(t.derivationRunId, t.candidateIndex),
  index('memory_proposals_state_idx').on(t.state, t.createdAt),
  index('memory_proposals_observation_idx').on(t.observationId),
])
