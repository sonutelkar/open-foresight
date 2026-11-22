import { bigserial, date, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';

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
  figi: text('figi').notNull().unique(),
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
