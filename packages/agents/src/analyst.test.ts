import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ZodTypeAny } from 'zod';
import { enabledSources, validateFramework, type FrameworkDraft, type Kpi } from '@open-foresight/core';
import { createSnapshot, kpiFrameworkDrafts, kpiScores, llmCalls, runs, secFacts, secSourceDocuments, securities } from '@open-foresight/db';
import { scoreFramework, scoreKpi, type AnalystContext, type EvidenceSearcher } from './analyst.js';
import type { StructuredGenerator } from './designer.js';

const golden = JSON.parse(readFileSync(new URL('../../core/fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const checked = validateFramework(golden, { availableSources: enabledSources({ eodhd: true }) });
if (!checked.ok) throw new Error('golden framework must be valid');
const framework = checked.framework;
const kpiOf = <M extends Kpi['method']>(method: M) => framework.kpis.find(k => k.method === method) as Extract<Kpi, { method: M }>;
const extractKpi = kpiOf('extract_then_quant'), judgeKpi = kpiOf('judgement'), quantKpi = kpiOf('quant');

const PASSAGE = 'Our grid products segment generated $3.1 billion of revenue, or 26% of total revenue, in fiscal 2025. We also sell storage systems.';
const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Analyst on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const tag = Math.random().toString(36).slice(2, 8);
  const issuer = `cik:9${Math.floor(Math.random() * 1e9)}`.padEnd(14, '0').slice(0, 14);
  const stamp = new Date('2026-01-01T00:00:00Z');

  async function setup() {
    const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning({ id: runs.id });
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-${tag}-${randomUUID()}`, name: 'Alpha Energy Inc' }).returning({ id: securities.id });
    const [call] = await db.insert(llmCalls).values({ runId: run!.id, role: 'designer', promptVersion: 'x', model: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id });
    const [draft] = await db.insert(kpiFrameworkDrafts).values({ runId: run!.id, attempt: 1, promptVersion: 'x', model: 'stub', llmCallId: call!.id, draft: {}, errors: [], valid: true, framework }).returning({ id: kpiFrameworkDrafts.id });
    const snapshot = await createSnapshot({ db });
    return { runId: run!.id, securityId: security!.id, draftId: draft!.id, snapshotId: snapshot.id };
  }

  const evidenceHit = (over: Record<string, unknown> = {}) => ({ chunkId: randomUUID(), docKind: 'sec_filing' as const, docId: randomUUID(), issuerKey: issuer, section: 'Item 1. Business', startOffset: 10, endOffset: 10 + PASSAGE.length, text: PASSAGE, availableOn: '2026-05-01', ...over });

  /** Stands in for the gateway. Like the real one it parses against the schema and writes and reports an llm_calls row. */
  function stubGateway(runId: string, outputs: unknown[]) {
    const calls: Array<{ user: string; system: string; promptVersion: string; schemaName: string; schema: ZodTypeAny; inputEvidenceIds: string[] }> = [];
    const generator: StructuredGenerator = {
      async generate(request) {
        const raw = outputs[calls.length];
        calls.push({ user: request.user, system: request.system, promptVersion: request.promptVersion, schemaName: request.schemaName, schema: request.schema, inputEvidenceIds: request.inputEvidenceIds });
        const value = request.schema.parse(raw);
        const [row] = await db.insert(llmCalls).values({ runId, role: request.role, promptVersion: request.promptVersion, model: 'stub/analyst', provider: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw as object }).returning({ id: llmCalls.id });
        request.onAudit?.(row?.id ?? '');
        return value;
      },
    };
    return { calls, generator };
  }
  function stubSearcher(hits: Array<ReturnType<typeof evidenceHit>>) {
    const calls: Array<Parameters<EvidenceSearcher['search']>[0]> = [];
    const retriever: EvidenceSearcher = { async search(input) { calls.push(input); return hits; } };
    return { calls, retriever };
  }
  const ctxFor = (s: Awaited<ReturnType<typeof setup>>, gateway: StructuredGenerator, retriever: EvidenceSearcher, over: Partial<AnalystContext> = {}): AnalystContext => ({
    db, gateway, retriever, runId: s.runId, frameworkDraftId: s.draftId, snapshotId: s.snapshotId, asOf: '2026-11-01',
    security: { id: s.securityId, name: 'Alpha Energy Inc', symbol: 'ALPH.US', ciks: ['0000000001'], issuerKeys: [issuer] }, ...over,
  });
  const goodCitations = [{ evidenceId: 'e1', quote: 'grid products segment generated $3.1 billion of revenue, or 26% of total revenue' }];

  it('scores a judgement KPI from cited passages and saves a traceable attempt', async () => {
    const s = await setup();
    const hit = evidenceHit();
    const g = stubGateway(s.runId, [{ level: '3', citations: goodCitations, rationale: 'The filing states that grid products were 26 percent of revenue.', conflicts: [] }]);
    const r = stubSearcher([hit]);
    const outcome = await scoreKpi(ctxFor(s, g.generator, r.retriever), judgeKpi);
    expect(outcome).toMatchObject({ level: '3', valid: true, attempts: 1, reused: false, extractedValue: null, quantValue: null });
    expect(outcome.citations[0]).toMatchObject({ evidenceId: 'e1', chunkId: hit.chunkId, docId: hit.docId, section: 'Item 1. Business', startOffset: 10 });
    const [row] = await db.select().from(kpiScores).where(eq(kpiScores.id, outcome.scoreId));
    expect(row).toMatchObject({ kpiId: judgeKpi.id, method: 'judgement', symbol: 'ALPH.US', asOf: '2026-11-01', level: '3', valid: true, errors: [] });
    expect(row?.promptVersion).toMatch(/^analyst-judgement@v1:[0-9a-f]{12}$/);
    expect(row?.evidence).toEqual([{ id: 'e1', chunkId: hit.chunkId, docKind: 'sec_filing', docId: hit.docId, section: 'Item 1. Business', startOffset: 10, endOffset: 10 + PASSAGE.length, availableOn: '2026-05-01' }]);
    const [call] = await db.select().from(llmCalls).where(eq(llmCalls.id, row?.llmCallId ?? ''));
    expect(call).toMatchObject({ role: 'analyst', promptVersion: row?.promptVersion });
    expect(call?.inputEvidenceIds).toEqual([hit.chunkId]);
    expect(Number(row?.confidence)).toBeCloseTo(0.6, 5);
    // The prompt carries the rubric and the labelled passage, and never the thresholds or another security.
    expect(g.calls[0]?.user).toContain('[e1] SEC filing available 2026-05-01 | Item 1. Business');
    expect(g.calls[0]?.user).toContain(judgeKpi.rubric.levels['3']);
    expect(g.calls[0]?.user).toContain('Alpha Energy Inc (ALPH.US)');
    expect(g.calls[0]?.system).toContain('silent about the KPI is not evidence');
  });

  it('asks retrieval for the KPI window and sources, and sets the extracted level by code', async () => {
    const s = await setup();
    const g = stubGateway(s.runId, [{ extractedValue: 0.26, citations: goodCitations, rationale: 'Grid products were 26 percent of revenue.', conflicts: [] }]);
    const r = stubSearcher([evidenceHit()]);
    const outcome = await scoreKpi(ctxFor(s, g.generator, r.retriever), extractKpi);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ asOf: '2026-11-01', securityId: s.securityId, docKinds: ['sec_filing', 'esef_filing'], limit: 10 });
    const lookback = extractKpi.lookbackDays;
    expect(r.calls[0]?.since).toBe(new Date(Date.parse('2026-11-01T00:00:00Z') - lookback * 86_400_000).toISOString().slice(0, 10));
    expect(r.calls[0]?.query).toContain(extractKpi.extraction.target);
    expect(g.calls[0]?.schemaName).toBe('kpi_score_extraction');
    expect(g.calls[0]?.user).toContain(`Unit: ${extractKpi.extraction.unit}`);
    expect(g.calls[0]?.user).not.toContain(String(extractKpi.thresholds[1]));
    expect(outcome).toMatchObject({ level: '3', extractedValue: 0.26, valid: true });
    const [row] = await db.select().from(kpiScores).where(eq(kpiScores.id, outcome.scoreId));
    expect(row).toMatchObject({ unit: 'fraction', method: 'extract_then_quant' });
    expect(Number(row?.extractedValue)).toBe(0.26);
  });

  it('is unknown with no model call when no passage is found', async () => {
    const s = await setup();
    const g = stubGateway(s.runId, []);
    const outcome = await scoreKpi(ctxFor(s, g.generator, stubSearcher([]).retriever), judgeKpi);
    expect(outcome).toMatchObject({ level: 'unknown', valid: true });
    expect(g.calls).toHaveLength(0);
    const [row] = await db.select().from(kpiScores).where(eq(kpiScores.id, outcome.scoreId));
    expect(row).toMatchObject({ llmCallId: null, promptVersion: null, rationale: 'No passages were available within the lookback window.' });
    expect(Number(row?.confidence)).toBe(0.2);
  });

  it('lowers a level 4 whose quote names no offering from the KPI definition and keeps the original in the audit row', async () => {
    const s = await setup();
    const unrelated = [{ evidenceId: 'e1', quote: 'in fiscal 2025' }];
    const g = stubGateway(s.runId, [{ level: '4', citations: unrelated, rationale: 'Most revenue.', conflicts: [] }]);
    const outcome = await scoreKpi(ctxFor(s, g.generator, stubSearcher([evidenceHit()]).retriever), judgeKpi);
    expect(outcome).toMatchObject({ level: '2', valid: true });
    const [row] = await db.select().from(kpiScores).where(eq(kpiScores.id, outcome.scoreId));
    expect(row).toMatchObject({ level: '2', adjustments: [{ code: 'no_definition_term', from: '4', to: '2' }] });
    expect((row?.raw as { level: string }).level).toBe('4');
  });

  it('repairs a non verbatim quote once and saves both attempts', async () => {
    const s = await setup();
    const bad = { level: '3', citations: [{ evidenceId: 'e1', quote: 'generated $3.5 billion of revenue, or 26% of total revenue' }], rationale: 'Grid is 26 percent.', conflicts: [] };
    const good = { level: '3', citations: goodCitations, rationale: 'Grid is 26 percent.', conflicts: [] };
    const g = stubGateway(s.runId, [bad, good]);
    const outcome = await scoreKpi(ctxFor(s, g.generator, stubSearcher([evidenceHit()]).retriever), judgeKpi);
    expect(outcome).toMatchObject({ valid: true, attempts: 2, level: '3' });
    expect(g.calls[1]?.user).toContain('Your previous answer was rejected');
    expect(g.calls[1]?.user).toContain('does not appear verbatim');
    const rows = (await db.select().from(kpiScores).where(eq(kpiScores.runId, s.runId))).sort((a, b) => a.attempt - b.attempt);
    expect(rows.map(r => [r.attempt, r.valid, r.level])).toEqual([[1, false, 'unknown'], [2, true, '3']]);
    expect((rows[0]?.errors as Array<{ code: string }>).map(e => e.code)).toEqual(['quote_not_verbatim']);
    expect(Number(rows[0]?.confidence)).toBe(0);
    expect(rows[0]?.llmCallId).not.toBe(rows[1]?.llmCallId);
  });

  it('saves an unknown, invalid score when every attempt fails', async () => {
    const s = await setup();
    const bad = { level: '3', citations: [{ evidenceId: 'e7', quote: 'a quote with a missing evidence id' }], rationale: 'Made up.', conflicts: [] };
    const outcome = await scoreKpi(ctxFor(s, stubGateway(s.runId, [bad, bad]).generator, stubSearcher([evidenceHit()]).retriever), judgeKpi);
    expect(outcome).toMatchObject({ valid: false, level: 'unknown', attempts: 2, confidence: 0 });
    expect(outcome.errors.map(e => e.code)).toEqual(['unknown_evidence_id']);
    expect(await db.select().from(kpiScores).where(eq(kpiScores.runId, s.runId))).toHaveLength(2);
  });

  it('rejects evidence that belongs to another security even if retrieval returns it', async () => {
    const s = await setup();
    const foreign = evidenceHit({ issuerKey: 'cik:0000999999' });
    const out = { level: '3', citations: goodCitations, rationale: 'Grid is 26 percent.', conflicts: [] };
    const outcome = await scoreKpi(ctxFor(s, stubGateway(s.runId, [out, out]).generator, stubSearcher([foreign]).retriever), judgeKpi);
    expect(outcome.valid).toBe(false);
    expect(outcome.errors.map(e => e.code)).toEqual(['wrong_security']);
  });

  it('rejects evidence outside the lookback window', async () => {
    const s = await setup();
    const old = evidenceHit({ availableOn: '2019-01-01' });
    const out = { level: '3', citations: goodCitations, rationale: 'Grid is 26 percent.', conflicts: [] };
    const outcome = await scoreKpi(ctxFor(s, stubGateway(s.runId, [out, out]).generator, stubSearcher([old]).retriever), judgeKpi);
    expect(outcome.errors.map(e => e.code)).toEqual(['outside_window']);
  });

  it('returns a valid score again without a model call, and numbers later attempts after the existing ones', async () => {
    const s = await setup();
    const out = { level: '2', citations: goodCitations, rationale: 'Grid is 26 percent.', conflicts: [] };
    const g1 = stubGateway(s.runId, [out]);
    const ctx = ctxFor(s, g1.generator, stubSearcher([evidenceHit()]).retriever);
    const first = await scoreKpi(ctx, judgeKpi);
    const g2 = stubGateway(s.runId, []);
    const second = await scoreKpi({ ...ctx, gateway: g2.generator }, judgeKpi);
    expect(second).toMatchObject({ reused: true, scoreId: first.scoreId, level: '2' });
    expect(g2.calls).toHaveLength(0);
  });

  it('computes a quant KPI in code from stored facts with no model call, and keeps its inputs', async () => {
    const s = await setup();
    const cik = `97${Math.floor(Math.random() * 1e8)}`.padStart(10, '0');
    const [src] = await db.insert(secSourceDocuments).values({ url: `a/${tag}/${cik}`, transportUrl: `a/${tag}/${cik}`, sha256: `${tag}${cik}`, body: '', fetchedAt: stamp }).returning({ id: secSourceDocuments.id });
    const f = (concept: string, value: number) => ({ key: `${tag}/${cik}/${concept}`, cik, accession: '0000000000-25-000001', taxonomy: 'us-gaap', concept, unit: 'USD', value: String(value), periodStart: '2024-10-01', periodEnd: '2025-09-30', filedAt: '2025-10-31', form: '10-K', raw: {}, sourceId: src!.id, sourcePointer: `/facts/us-gaap/${concept}`, ingestedAt: stamp });
    await db.insert(secFacts).values([f('Revenues', 1000), f('ResearchAndDevelopmentExpense', 80)]);
    const snapshot = await createSnapshot({ db });
    const g = stubGateway(s.runId, []);
    const ctx = ctxFor({ ...s, snapshotId: snapshot.id }, g.generator, stubSearcher([]).retriever, { security: { id: s.securityId, name: 'Alpha Energy Inc', symbol: 'ALPH.US', ciks: [cik], issuerKeys: [issuer] } });
    const rd = { ...quantKpi, quantQuery: 'rd_intensity' as const, thresholds: [0.02, 0.05, 0.08, 0.12] as [number, number, number, number] };
    const outcome = await scoreKpi(ctx, rd);
    expect(outcome).toMatchObject({ level: '3', valid: true, quantValue: 0.08, confidence: 1 });
    expect(g.calls).toHaveLength(0);
    const [row] = await db.select().from(kpiScores).where(eq(kpiScores.id, outcome.scoreId));
    expect(row).toMatchObject({ method: 'quant', llmCallId: null, promptVersion: null });
    expect((row?.quantInputs as Array<{ concept: string; sourcePointer: string }>).map(i => i.concept).sort()).toEqual(['ResearchAndDevelopmentExpense', 'Revenues']);
    const missing = await scoreKpi(ctx, { ...rd, id: 'capex_missing', quantQuery: 'capex_intensity' as const });
    expect(missing).toMatchObject({ level: 'unknown', quantValue: null, confidence: 0, valid: true });
  });

  it('keeps scores append-only and refuses a level the schema does not allow', async () => {
    const s = await setup();
    const outcome = await scoreKpi(ctxFor(s, stubGateway(s.runId, []).generator, stubSearcher([]).retriever), judgeKpi);
    await expect(client.unsafe('DELETE FROM kpi_scores')).rejects.toThrow('append-only');
    await expect(db.update(kpiScores).set({ level: '4' }).where(eq(kpiScores.id, outcome.scoreId))).rejects.toThrow();
    const base = { runId: s.runId, frameworkDraftId: s.draftId, snapshotId: s.snapshotId, securityId: s.securityId, symbol: 'X', kpiId: 'k', asOf: '2026-11-01', method: 'judgement', citations: [], rationale: '', conflicts: [], evidence: [], errors: [], confidence: '0.5' };
    await expect(db.insert(kpiScores).values({ ...base, attempt: 90, level: '7', valid: true })).rejects.toThrow();
    await expect(db.insert(kpiScores).values({ ...base, attempt: 91, level: '3', valid: false })).rejects.toThrow();
    await expect(db.insert(kpiScores).values({ ...base, attempt: 92, level: 'unknown', valid: true, confidence: '1.5' })).rejects.toThrow();
  });

  it('scores every KPI of a framework', async () => {
    const s = await setup();
    const judgeOut = { level: '2', citations: goodCitations, rationale: 'Grid is 26 percent.', conflicts: [] };
    const extractOut = { extractedValue: 0.26, citations: goodCitations, rationale: 'Grid is 26 percent.', conflicts: [] };
    const g = stubGateway(s.runId, framework.kpis.filter(k => k.method !== 'quant').map(k => k.method === 'judgement' ? judgeOut : extractOut));
    const outcomes = await scoreFramework(ctxFor(s, g.generator, stubSearcher([evidenceHit()]).retriever), framework, { concurrency: 1 });
    expect(outcomes).toHaveLength(framework.kpis.length);
    expect(outcomes.map(o => o.kpiId)).toEqual(framework.kpis.map(k => k.id));
    expect(outcomes.every(o => o.valid)).toBe(true);
    expect(g.calls).toHaveLength(framework.kpis.filter(k => k.method !== 'quant').length);
  });
});
