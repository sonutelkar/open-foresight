import { bigserial, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  tool: text('tool').notNull(), args: jsonb('args').notNull(), resultIds: jsonb('result_ids').notNull(),
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
