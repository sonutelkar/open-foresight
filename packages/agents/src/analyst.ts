import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  capUnsupportedLevel, computeConfidence, extractionOutputSchema, judgementOutputSchema, quantLevel, validateScore,
  type DocKind, type EvidenceItem, type Framework, type Kpi, type ResolvedCitation, type ScoreError, type ScoreLevel,
} from '@open-foresight/core';
import { computeQuant } from '@open-foresight/data';
import { kpiScores, llmCalls } from '@open-foresight/db';
import { loadPrompt, render } from '@open-foresight/prompts';
import type { StructuredGenerator } from './designer.js';
import { verifyClaim, type SpanJudge } from './verifier.js';

/** The part of retrieval the Analyst uses. `createRetriever` from `@open-foresight/retrieval` satisfies it. */
export type EvidenceSearcher = {
  search(input: { snapshotId: string; asOf: string; securityId: string; query: string; limit?: number; since?: string; docKinds?: DocKind[] }): Promise<Array<{
    chunkId: string; docKind: DocKind; docId: string; issuerKey: string; section: string; startOffset: number; endOffset: number; text: string; availableOn: string;
  }>>;
};

export type AnalystContext = {
  db: PostgresJsDatabase; gateway: StructuredGenerator; retriever: EvidenceSearcher;
  runId: string; frameworkDraftId: string; snapshotId: string; asOf: string;
  security: { id: string; name: string; symbol: string; /** SEC filers for quant functions. */ ciks: string[]; /** Issuers whose filings are evidence for this security. */ issuerKeys: string[] };
  /** Passages offered to the model per KPI. Default 10. */
  evidenceLimit?: number;
  /** Optional. When set, a level 3 or 4 is checked against its stored spans and lowered if they do not support it. */
  judge?: SpanJudge;
};
export type ScoreOutcome = {
  scoreId: string; kpiId: string; level: ScoreLevel; extractedValue: number | null; quantValue: number | null; confidence: number;
  valid: boolean; attempts: number; reused: boolean; citations: ResolvedCitation[]; errors: ScoreError[];
};

type StoredRow = typeof kpiScores.$inferSelect;
const sourceKinds: Record<string, DocKind> = { sec_filings: 'sec_filing', esef_filings: 'esef_filing' };
const kindLabel: Record<DocKind, string> = { sec_filing: 'SEC filing', esef_filing: 'ESEF report' };
const shiftDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const asOutcome = (row: StoredRow, reused: boolean): ScoreOutcome => ({
  scoreId: row.id, kpiId: row.kpiId, level: row.level as ScoreLevel, extractedValue: row.extractedValue === null ? null : Number(row.extractedValue),
  quantValue: row.quantValue === null ? null : Number(row.quantValue), confidence: Number(row.confidence), valid: row.valid, attempts: row.attempt, reused,
  citations: row.citations as ResolvedCitation[], errors: row.errors as ScoreError[],
});

async function nextAttempt(ctx: AnalystContext, kpiId: string): Promise<number> {
  const rows = await ctx.db.select({ attempt: kpiScores.attempt }).from(kpiScores).where(and(eq(kpiScores.runId, ctx.runId), eq(kpiScores.securityId, ctx.security.id), eq(kpiScores.kpiId, kpiId)));
  return rows.reduce((max, r) => Math.max(max, r.attempt), 0) + 1;
}

async function save(ctx: AnalystContext, kpi: Kpi, attempt: number, v: Partial<typeof kpiScores.$inferInsert> & Pick<typeof kpiScores.$inferInsert, 'level' | 'confidence' | 'valid'>): Promise<StoredRow> {
  const [row] = await ctx.db.insert(kpiScores).values({
    runId: ctx.runId, frameworkDraftId: ctx.frameworkDraftId, snapshotId: ctx.snapshotId, securityId: ctx.security.id, symbol: ctx.security.symbol,
    kpiId: kpi.id, asOf: ctx.asOf, attempt, method: kpi.method, citations: [], rationale: '', conflicts: [], evidence: [], errors: [], ...v,
  }).returning();
  if (!row) throw new Error('The score was not saved');
  return row;
}

/** The passages a KPI is scored from: the best matches within its lookback window and its source kinds, labelled e1, e2 and so on. */
export async function retrieveEvidence(ctx: AnalystContext, kpi: Exclude<Kpi, { method: 'quant' }>): Promise<EvidenceItem[]> {
  const docKinds = [...new Set(kpi.sources.flatMap(s => sourceKinds[s] ? [sourceKinds[s]] : []))];
  if (docKinds.length === 0) return [];
  const query = `${kpi.name}. ${kpi.definition}${kpi.method === 'extract_then_quant' ? ` ${kpi.extraction.target}` : ''}`;
  const hits = await ctx.retriever.search({ snapshotId: ctx.snapshotId, asOf: ctx.asOf, securityId: ctx.security.id, query, limit: ctx.evidenceLimit ?? 10, since: shiftDays(ctx.asOf, -kpi.lookbackDays), docKinds });
  return hits.map((h, i) => ({ id: `e${i + 1}`, chunkId: h.chunkId, docKind: h.docKind, docId: h.docId, issuerKey: h.issuerKey, section: h.section, startOffset: h.startOffset, endOffset: h.endOffset, availableOn: h.availableOn, text: h.text }));
}

const rubricText = (kpi: Exclude<Kpi, { method: 'quant' }>) => (['0', '1', '2', '3', '4'] as const).map(l => `${l}: ${kpi.rubric.levels[l]}`).join('\n');
const passagesText = (evidence: EvidenceItem[]) => evidence.map(e => `[${e.id}] ${kindLabel[e.docKind]} available ${e.availableOn} | ${e.section}\n${e.text}`).join('\n\n---\n\n');
const evidenceRefs = (evidence: EvidenceItem[]) => evidence.map(e => ({ id: e.id, chunkId: e.chunkId, docKind: e.docKind, docId: e.docId, section: e.section, startOffset: e.startOffset, endOffset: e.endOffset, availableOn: e.availableOn }));

/**
 * Scores a non-quant KPI from the given passages. An invalid answer is repaired once by listing every error.
 * Every attempt is saved. A score that never validates is saved as unknown with its errors.
 */
export async function scoreWithEvidence(ctx: AnalystContext, kpi: Exclude<Kpi, { method: 'quant' }>, evidence: EvidenceItem[], options: { maxAttempts?: number } = {}): Promise<ScoreOutcome> {
  const maxAttempts = options.maxAttempts ?? 2;
  let attempt = await nextAttempt(ctx, kpi.id);
  if (evidence.length === 0) {
    const row = await save(ctx, kpi, attempt, { level: 'unknown', confidence: computeConfidence({ method: kpi.method, valid: true, level: 'unknown', citations: [], conflicts: [], asOf: ctx.asOf }).toString(), valid: true, rationale: 'No passages were available within the lookback window.' });
    return asOutcome(row, false);
  }
  const prompt = loadPrompt(kpi.method === 'judgement' ? 'analyst-judgement' : 'analyst-extraction', 'v1');
  const common = { company: ctx.security.name, symbol: ctx.security.symbol, as_of: ctx.asOf, kpi_name: kpi.name, definition: kpi.definition, rubric: rubricText(kpi), passages: passagesText(evidence) };
  const user = kpi.method === 'judgement'
    ? render(prompt.user, { ...common, unknown_rule: kpi.rubric.unknown })
    : render(prompt.user, { ...common, target: kpi.extraction.target, unit: kpi.extraction.unit });
  const schema = kpi.method === 'judgement' ? judgementOutputSchema : extractionOutputSchema;
  const schemaName = kpi.method === 'judgement' ? 'kpi_score_judgement' : 'kpi_score_extraction';
  let feedback = '';
  let row: StoredRow | undefined;
  for (let n = 0; n < maxAttempts; n++) {
    let auditId = '';
    const output = await ctx.gateway.generate({ runId: ctx.runId, role: 'analyst', promptVersion: prompt.promptVersion, system: prompt.system, user: user + feedback, schemaName, schema, inputEvidenceIds: evidence.map(e => e.chunkId), maxOutputTokens: 1500, onAudit: id => { auditId = id; } });
    const [call] = await ctx.db.select({ id: llmCalls.id }).from(llmCalls).where(eq(llmCalls.id, auditId));
    if (!call) throw new Error('The gateway did not report an audit record for the Analyst call');
    const check = validateScore({ kpi, output, evidence, asOf: ctx.asOf, allowedIssuerKeys: ctx.security.issuerKeys });
    const base = { promptVersion: prompt.promptVersion, llmCallId: auditId, evidence: evidenceRefs(evidence), raw: output as object, rationale: (output as { rationale: string }).rationale, conflicts: (output as { conflicts: string[] }).conflicts, unit: kpi.method === 'extract_then_quant' ? kpi.extraction.unit : null };
    if (check.ok) {
      const capped = capUnsupportedLevel({ kpi, level: check.level, citations: check.citations });
      const checked = ctx.judge ? await verifyClaim({ db: ctx.db, judge: ctx.judge, runId: ctx.runId, asOf: ctx.asOf, security: ctx.security }, kpi, capped.level, check.citations) : { level: capped.level, adjustment: null };
      const adjustments = [capped.adjustment, checked.adjustment].filter((a): a is NonNullable<typeof a> => a !== null);
      const confidence = computeConfidence({ method: kpi.method, valid: true, level: checked.level, citations: check.citations, conflicts: base.conflicts, asOf: ctx.asOf });
      row = await save(ctx, kpi, attempt, { ...base, level: checked.level, adjustments, extractedValue: check.extractedValue === null ? null : String(check.extractedValue), citations: check.citations, confidence: String(confidence), valid: true });
      return asOutcome(row, false);
    }
    row = await save(ctx, kpi, attempt, { ...base, level: 'unknown', confidence: '0', valid: false, errors: check.errors });
    attempt++;
    feedback = `\n\nYour previous answer was rejected. Fix every problem below and answer again, using only the passages above.\n${check.errors.map(e => `- ${e.message}`).join('\n')}`;
  }
  if (!row) throw new Error('The Analyst made no attempt');
  return asOutcome(row, false);
}

/**
 * Scores one KPI for the context's security. Quant KPIs run a registered function in code with no model call.
 * A KPI that already has a valid score for this run and security returns it without work.
 */
export async function scoreKpi(ctx: AnalystContext, kpi: Kpi): Promise<ScoreOutcome> {
  const existing = await ctx.db.select().from(kpiScores).where(and(eq(kpiScores.runId, ctx.runId), eq(kpiScores.securityId, ctx.security.id), eq(kpiScores.kpiId, kpi.id)));
  const reusable = existing.find(r => r.valid);
  if (reusable) return asOutcome(reusable, true);
  if (kpi.method !== 'quant') return scoreWithEvidence(ctx, kpi, await retrieveEvidence(ctx, kpi));
  const result = await computeQuant({ db: ctx.db, snapshotId: ctx.snapshotId, asOf: ctx.asOf, quantId: kpi.quantQuery, symbol: ctx.security.symbol, ciks: ctx.security.ciks });
  const level = quantLevel(kpi, result.value);
  const confidence = computeConfidence({ method: 'quant', valid: true, level, quantValue: result.value, citations: [], conflicts: [], asOf: ctx.asOf });
  const row = await save(ctx, kpi, await nextAttempt(ctx, kpi.id), { level, quantValue: result.value === null ? null : String(result.value), quantInputs: result.inputs, confidence: String(confidence), valid: true, rationale: result.note ?? `${kpi.quantQuery} computed from stored data.` });
  return asOutcome(row, false);
}

/**
 * Scores every KPI of a framework for one security, a few at a time.
 * After one KPI fails no new KPI starts, and the call waits for the ones in flight before it throws, so nothing keeps running or saving after it rejects.
 */
export async function scoreFramework(ctx: AnalystContext, framework: Framework, options: { concurrency?: number } = {}): Promise<ScoreOutcome[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8));
  const out: ScoreOutcome[] = new Array(framework.kpis.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(concurrency, framework.kpis.length) }, async () => {
    while (next < framework.kpis.length && !failure) {
      const i = next++;
      try { out[i] = await scoreKpi(ctx, framework.kpis[i]!); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
  return out;
}
