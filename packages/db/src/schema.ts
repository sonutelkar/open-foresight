import { bigserial, boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uuid, uniqueIndex, vector } from 'drizzle-orm/pg-core';

export const runStatus = pgEnum('run_status', [
  'draft', 'universe_built', 'designing', 'awaiting_kpi_approval', 'prescreening',
  'analysing', 'reviewing', 'awaiting_flag_review', 'packaging', 'done', 'failed', 'cancelled',
]);

export const runs = pgTable('runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  settings: jsonb('settings').notNull(),
  snapshotId: text('snapshot_id'),
  frameworkVersion: text('framework_version'),
  modelProfile: text('model_profile').notNull(),
  status: runStatus('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runStatusHistory = pgTable('run_status_history', {
  sequence: bigserial('sequence', { mode: 'number' }).notNull().unique(),
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  status: runStatus('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const llmCalls = pgTable('llm_calls', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  role: text('role').notNull(), promptVersion: text('prompt_version').notNull(),
  model: text('model').notNull(), provider: text('provider'),
  params: jsonb('params').notNull(), requestHash: text('request_hash').notNull(),
  inputEvidenceIds: jsonb('input_evidence_ids').notNull(), response: jsonb('response'), error: jsonb('error'),
  tokens: jsonb('tokens'), cachedTokens: integer('cached_tokens'), cost: numeric('cost'), latencyMs: integer('latency_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const toolCalls = pgTable('tool_calls', {
  id: uuid('id').defaultRandom().primaryKey(),
  llmCallId: uuid('llm_call_id').notNull().references(() => llmCalls.id),
  tool: text('tool').notNull(), args: jsonb('args').notNull(), resultIds: jsonb('result_ids').notNull(), error: jsonb('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const humanDecisions = pgTable('human_decisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  userId: text('user_id').notNull(), stage: runStatus('stage').notNull(), target: text('target').notNull(),
  action: text('action').notNull(), reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const llmCache = pgTable('llm_cache', {
  requestHash: text('request_hash').primaryKey(), response: jsonb('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const securities = pgTable('securities', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Listing-level FIGI of the first listing seen. Null when the security was first created from a share class. */
  figi: text('figi').unique(),
  /** Company-level identity shared by every venue listing of one share class. */
  shareClassFigi: text('share_class_figi').unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const secListings = pgTable('sec_listings', {
  id: uuid('id').defaultRandom().primaryKey(),
  cik: text('cik').notNull(), ticker: text('ticker').notNull(), exchange: text('exchange').notNull(),
  name: text('name').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, table => [uniqueIndex('sec_listings_identity').on(table.cik, table.ticker, table.exchange)]);

export const figiMappings = pgTable('figi_mappings', {
  id: uuid('id').defaultRandom().primaryKey(),
  listingId: uuid('listing_id').notNull().unique().references(() => secListings.id),
  securityId: uuid('security_id').references(() => securities.id),
  candidates: jsonb('candidates').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
});

export const secSourceDocuments = pgTable('sec_source_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  url: text('url').notNull(), transportUrl: text('transport_url').notNull(), sha256: text('sha256').notNull(), body: text('body').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
}, table => [uniqueIndex('sec_source_documents_version').on(table.url, table.transportUrl, table.sha256)]);

export const secFilings = pgTable('sec_filings', {
  id: uuid('id').defaultRandom().primaryKey(),
  cik: text('cik').notNull(), accession: text('accession').notNull(), form: text('form').notNull(),
  filedAt: date('filed_at').notNull(), primaryDocument: text('primary_document').notNull(),
  submissionSourceId: uuid('submission_source_id').notNull().references(() => secSourceDocuments.id),
  documentSourceId: uuid('document_source_id').notNull().references(() => secSourceDocuments.id),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
}, table => [uniqueIndex('sec_filing_version').on(table.cik, table.accession, table.submissionSourceId, table.documentSourceId)]);

export const secFacts = pgTable('sec_facts', {
  id: uuid('id').defaultRandom().primaryKey(), key: text('key').notNull().unique(),
  cik: text('cik').notNull(), accession: text('accession').notNull(),
  taxonomy: text('taxonomy').notNull(), concept: text('concept').notNull(), unit: text('unit').notNull(),
  value: numeric('value').notNull(), periodStart: date('period_start'), periodEnd: date('period_end').notNull(),
  filedAt: date('filed_at').notNull(), form: text('form').notNull(),
  raw: jsonb('raw').notNull(), sourceId: uuid('source_id').notNull().references(() => secSourceDocuments.id),
  sourcePointer: text('source_pointer').notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
});

export const dataSnapshots = pgTable('data_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  ingestedCutoff: timestamp('ingested_cutoff', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const snapshotFilings = pgTable('snapshot_filings', {
  snapshotId: uuid('snapshot_id').notNull().references(() => dataSnapshots.id),
  filingId: uuid('filing_id').notNull().references(() => secFilings.id),
}, table => [primaryKey({ columns: [table.snapshotId, table.filingId] })]);

export const snapshotFacts = pgTable('snapshot_facts', {
  snapshotId: uuid('snapshot_id').notNull().references(() => dataSnapshots.id),
  factId: uuid('fact_id').notNull().references(() => secFacts.id),
}, table => [primaryKey({ columns: [table.snapshotId, table.factId] })]);

export const priceBars = pgTable('price_bars', {
  id: uuid('id').defaultRandom().primaryKey(),
  source: text('source').notNull(), symbol: text('symbol').notNull(), date: date('date').notNull(),
  open: numeric('open'), high: numeric('high'), low: numeric('low'), close: numeric('close').notNull(),
  adjustedClose: numeric('adjusted_close'), volume: numeric('volume'),
  contentHash: text('content_hash').notNull(), raw: jsonb('raw').notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
}, table => [
  uniqueIndex('price_bars_version').on(table.source, table.symbol, table.date, table.contentHash),
  index('price_bars_lookup').on(table.symbol, table.date),
]);

export const fxRates = pgTable('fx_rates', {
  id: uuid('id').defaultRandom().primaryKey(),
  source: text('source').notNull(), currency: text('currency').notNull(), date: date('date').notNull(),
  /** Units of `currency` per one euro. */
  perEur: numeric('per_eur').notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
}, table => [uniqueIndex('fx_rates_version').on(table.source, table.currency, table.date, table.perEur)]);

export const mappingStatus = pgEnum('mapping_status', ['resolved', 'ambiguous', 'unmatched', 'no_isin']);

export const exchangeListings = pgTable('exchange_listings', {
  id: uuid('id').defaultRandom().primaryKey(),
  source: text('source').notNull(), symbol: text('symbol').notNull(),
  exchange: text('exchange').notNull(), name: text('name').notNull(), type: text('type').notNull(),
  isin: text('isin'), currency: text('currency'),
  status: mappingStatus('status').notNull(),
  securityId: uuid('security_id').references(() => securities.id),
  /** Distinct share classes OpenFIGI returned for the ISIN. */
  shareClasses: jsonb('share_classes').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, table => [uniqueIndex('exchange_listings_identity').on(table.source, table.symbol)]);

/** A market cap seen on one date. It is a snapshot of that day, not a historical series. */
export const marketCapObservations = pgTable('market_cap_observations', {
  id: uuid('id').defaultRandom().primaryKey(),
  source: text('source').notNull(),
  /** EODHD style symbol, such as SAP.XETRA. */
  symbol: text('symbol').notNull(), sourceSymbol: text('source_symbol').notNull(),
  /** In the listing currency. London caps are in pounds even though prices are in pence. Null when the source gave only shares. */
  marketCap: numeric('market_cap'), sharesOutstanding: numeric('shares_outstanding'), price: numeric('price'), currency: text('currency'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, table => [index('market_cap_observations_lookup').on(table.symbol, table.observedAt)]);

/** ISINs GLEIF lists for a legal entity. One LEI can list equity and debt ISINs. */
export const leiIsins = pgTable('lei_isins', {
  id: uuid('id').defaultRandom().primaryKey(),
  lei: text('lei').notNull(), isin: text('isin').notNull(), source: text('source').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, table => [uniqueIndex('lei_isins_identity').on(table.lei, table.isin, table.source), index('lei_isins_isin').on(table.isin)]);

/** An ESEF annual report from the filings.xbrl.org index. A filing belongs to an issuer, so it carries a LEI and no security. */
export const esefFilings = pgTable('esef_filings', {
  id: uuid('id').defaultRandom().primaryKey(),
  fxoId: text('fxo_id').notNull(), lei: text('lei').notNull(), entityName: text('entity_name').notNull(),
  country: text('country').notNull(), periodEnd: date('period_end').notNull(),
  /** The index `published` date when present, else the date the index added it. The later date is the safe one. */
  availableOn: date('available_on').notNull(), availableSource: text('available_source').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }), dateAddedAt: timestamp('date_added_at', { withTimezone: true }).notNull(),
  reportUrl: text('report_url').notNull(), packageSha256: text('package_sha256').notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
}, table => [uniqueIndex('esef_filings_version').on(table.fxoId, table.packageSha256), index('esef_filings_lei').on(table.lei)]);

/** The raw XHTML report. Text is extracted from it when it is chunked, so offsets stay tied to a known extractor. */
export const esefDocuments = pgTable('esef_documents', {
  filingId: uuid('filing_id').primaryKey().references(() => esefFilings.id),
  sha256: text('sha256').notNull(), body: text('body').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
});

export const snapshotEsefFilings = pgTable('snapshot_esef_filings', {
  snapshotId: uuid('snapshot_id').notNull().references(() => dataSnapshots.id),
  filingId: uuid('filing_id').notNull().references(() => esefFilings.id),
}, table => [primaryKey({ columns: [table.snapshotId, table.filingId] })]);

/** Dimensions of the pinned embedding model, openai/text-embedding-3-small. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * A passage of a filing with its exact source offsets and embedding.
 * Chunks never change. A new extractor, chunker or embedding model writes rows under a new `indexVersion`.
 * Full-text search uses a generated `tsv` column added in the migration, which drizzle does not model.
 * There is no vector index. Every search is scoped to one security, so Postgres scans that issuer's chunks exactly.
 * That keeps results deterministic. Add an HNSW index only if a search across securities is introduced.
 */
export const documentChunks = pgTable('document_chunks', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** `sec_filing` or `esef_filing`. */
  docKind: text('doc_kind').notNull(), docId: uuid('doc_id').notNull(),
  /** `cik:0000320193` or `lei:549300...`. A filing belongs to an issuer. */
  issuerKey: text('issuer_key').notNull(),
  availableOn: date('available_on').notNull(),
  section: text('section').notNull(), ordinal: integer('ordinal').notNull(),
  startOffset: integer('start_offset').notNull(), endOffset: integer('end_offset').notNull(),
  text: text('text').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  indexVersion: text('index_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('document_chunks_identity').on(table.docKind, table.docId, table.indexVersion, table.ordinal),
  index('document_chunks_issuer').on(table.indexVersion, table.issuerKey, table.availableOn),
]);

/** Every embedding request, including failures. Index time embeddings have no run, so they are not in llm_calls. */
export const embeddingBatches = pgTable('embedding_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  model: text('model').notNull(), provider: text('provider'), purpose: text('purpose').notNull(),
  inputCount: integer('input_count').notNull(), inputHash: text('input_hash').notNull(),
  tokens: integer('tokens'), cost: numeric('cost'), latencyMs: integer('latency_ms'), error: jsonb('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One Designer attempt for a run. Attempts are never edited. A PM edit at gate 1 becomes a new version later.
 * `draft` is the model's raw output, `errors` lists what validation found, and `framework` is set only when it passed.
 */
export const kpiFrameworkDrafts = pgTable('kpi_framework_drafts', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  attempt: integer('attempt').notNull(),
  promptVersion: text('prompt_version').notNull(), model: text('model').notNull(),
  llmCallId: uuid('llm_call_id').notNull().references(() => llmCalls.id),
  draft: jsonb('draft').notNull(), errors: jsonb('errors').notNull(), valid: boolean('valid').notNull(),
  framework: jsonb('framework'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('kpi_framework_drafts_attempt').on(table.runId, table.attempt)]);

/**
 * One scoring attempt for a security on a KPI. Attempts are never edited.
 * `valid` is false when validation failed, and then `level` is `unknown` and `errors` says why.
 * Quant scores have no model call. A score with no retrieved evidence also has none.
 */
export const kpiScores = pgTable('kpi_scores', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  frameworkDraftId: uuid('framework_draft_id').notNull().references(() => kpiFrameworkDrafts.id),
  snapshotId: uuid('snapshot_id').notNull().references(() => dataSnapshots.id),
  securityId: uuid('security_id').notNull().references(() => securities.id),
  symbol: text('symbol').notNull(), kpiId: text('kpi_id').notNull(), asOf: date('as_of').notNull(),
  attempt: integer('attempt').notNull(), method: text('method').notNull(),
  promptVersion: text('prompt_version'), llmCallId: uuid('llm_call_id').references(() => llmCalls.id),
  level: text('level').notNull(), extractedValue: numeric('extracted_value'), unit: text('unit'),
  quantValue: numeric('quant_value'), quantInputs: jsonb('quant_inputs'),
  citations: jsonb('citations').notNull(), rationale: text('rationale').notNull(), conflicts: jsonb('conflicts').notNull(),
  /** The passages offered to the model, with their labels, so every citation can be traced back. */
  evidence: jsonb('evidence').notNull(), raw: jsonb('raw'),
  /** Changes code made to the model's level after validation, each with the original level. `level` holds the changed one. */
  adjustments: jsonb('adjustments').notNull().default([]),
  confidence: numeric('confidence').notNull(), valid: boolean('valid').notNull(), errors: jsonb('errors').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('kpi_scores_attempt').on(table.runId, table.securityId, table.kpiId, table.attempt)]);

/**
 * The framework a PM approved at gate 1, frozen. Scores reference it. It never changes.
 * `framework` is what was approved, after any edits, and `sourceDraftId` is the model draft it started from.
 */
export const kpiFrameworkVersions = pgTable('kpi_framework_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  version: integer('version').notNull(),
  sourceDraftId: uuid('source_draft_id').notNull().references(() => kpiFrameworkDrafts.id),
  framework: jsonb('framework').notNull(), exclusions: jsonb('exclusions').notNull(),
  /** True when the approved framework differs from the draft. */
  edited: boolean('edited').notNull(),
  approvedBy: text('approved_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('kpi_framework_versions_run_version').on(table.runId, table.version)]);

/**
 * The names a run considers: every listing with prices in the local store, with the universe decision and, after prescreening,
 * the security and issuers that carry its evidence. A stage that runs twice rewrites the same rows.
 */
export const runUniverse = pgTable('run_universe', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  symbol: text('symbol').notNull(), name: text('name'),
  included: boolean('included').notNull(), reasons: jsonb('reasons').notNull(),
  region: text('region'), marketCapUsd: numeric('market_cap_usd'), advUsd: numeric('adv_usd'),
  securityId: uuid('security_id').references(() => securities.id),
  /** Set by prescreening. `sec` and `esef` mean filings are available, `none` means no filing evidence, so text KPIs score unknown. */
  coverage: text('coverage'), ciks: jsonb('ciks'), issuerKeys: jsonb('issuer_keys'),
}, table => [uniqueIndex('run_universe_symbol').on(table.runId, table.symbol)]);

/** The packaged output of a run. It is provisional until a gate 2 exists, and it never changes once written. */
export const baskets = pgTable('baskets', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().unique().references(() => runs.id),
  frameworkVersionId: uuid('framework_version_id').notNull().references(() => kpiFrameworkVersions.id),
  status: text('status').notNull(), unknownMode: text('unknown_mode').notNull(),
  rules: jsonb('rules').notNull(), funnel: jsonb('funnel').notNull(), cap: jsonb('cap').notNull(), excluded: jsonb('excluded').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const basketMembers = pgTable('basket_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  basketId: uuid('basket_id').notNull().references(() => baskets.id),
  securityId: uuid('security_id').notNull().references(() => securities.id),
  symbol: text('symbol').notNull(), name: text('name').notNull(), rank: integer('rank').notNull(),
  score: numeric('score').notNull(), confidence: numeric('confidence').notNull(), weightPercent: numeric('weight_percent').notNull(),
  atCap: boolean('at_cap').notNull(), unknownWeight: numeric('unknown_weight').notNull(), capAdjustment: numeric('cap_adjustment').notNull(),
  contributions: jsonb('contributions').notNull(),
}, table => [uniqueIndex('basket_members_security').on(table.basketId, table.securityId), uniqueIndex('basket_members_rank').on(table.basketId, table.rank)]);

/** A hand made link from a security to the issuer whose filings are its evidence, for issuers that no ticker, FIGI or ISIN link reaches. */
export const securityIssuers = pgTable('security_issuers', {
  securityId: uuid('security_id').notNull().references(() => securities.id),
  /** `cik:0000034088` or `lei:549300...`. */
  issuerKey: text('issuer_key').notNull(),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.securityId, table.issuerKey] })]);

/**
 * A report found on the web, such as an annual report on a company's investor site, with its text already extracted.
 * Chunk offsets point into `text`. `headings` holds the section starts, which for a PDF are its pages.
 * `fetchedAt` is the first fetch of this content, and `availableOn` is that day, so the report is evidence only for as-of dates on or after it.
 */
export const webDocuments = pgTable('web_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  url: text('url').notNull(), finalUrl: text('final_url').notNull(),
  contentType: text('content_type').notNull(), byteSize: integer('byte_size').notNull(),
  /** Hash of the fetched bytes. The same URL with new bytes is a new row. */
  rawSha256: text('raw_sha256').notNull(), etag: text('etag'), lastModified: text('last_modified'),
  text: text('text').notNull(), headings: jsonb('headings').notNull(), extractor: text('extractor').notNull(),
  /** `lei:...` or `cik:...` of the company the report belongs to. */
  issuerKey: text('issuer_key').notNull(), entityName: text('entity_name').notNull(), periodEnd: date('period_end'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(), availableOn: date('available_on').notNull(),
  /** The discovery attempt that proposed this URL, when one did. */
  attemptId: uuid('attempt_id'),
}, table => [
  uniqueIndex('web_documents_version').on(table.url, table.rawSha256),
  /** The same bytes under a second URL, such as a mirror, are the same report. */
  uniqueIndex('web_documents_content').on(table.issuerKey, table.rawSha256),
  index('web_documents_issuer').on(table.issuerKey),
]);

export const snapshotWebDocuments = pgTable('snapshot_web_documents', {
  snapshotId: uuid('snapshot_id').notNull().references(() => dataSnapshots.id),
  documentId: uuid('document_id').notNull().references(() => webDocuments.id),
}, table => [primaryKey({ columns: [table.snapshotId, table.documentId] })]);

/**
 * Every try to find a report for a company, including failures, so a company is retried only after a set number of days.
 * Discovery has no run, so its model call is audited here and not in `llm_calls`, the way index time embeddings are in `embedding_batches`.
 */
export const reportDiscoveryAttempts = pgTable('report_discovery_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  issuerKey: text('issuer_key').notNull(), entityName: text('entity_name').notNull(),
  /** `stored`, `no_candidates`, `all_rejected` or `error`. */
  outcome: text('outcome').notNull(),
  candidates: jsonb('candidates').notNull(), rejected: jsonb('rejected').notNull(),
  promptVersion: text('prompt_version').notNull(), model: text('model'), provider: text('provider'),
  /** False when the provider could not honor zero data retention and the call went ahead without it. */
  zdr: boolean('zdr'), params: jsonb('params'), response: jsonb('response'), error: text('error'),
  tokens: jsonb('tokens'), cost: numeric('cost'), latencyMs: integer('latency_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('report_discovery_issuer').on(table.issuerKey, table.createdAt)]);
