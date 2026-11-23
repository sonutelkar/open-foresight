import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources, validateFramework, type FrameworkDraft, type Kpi } from '@open-foresight/core';
import { createSnapshot, documentChunks, kpiFrameworkDrafts, kpiFrameworkVersions, kpiScores, llmCalls, reviews, runs, securities } from '@open-foresight/db';
import type { StructuredGenerator } from './designer.js';
import { loadReviewerInput, reviewScore } from './reviewer.js';

const golden = JSON.parse(readFileSync(new URL('../../core/fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const checked = validateFramework(golden, { availableSources: enabledSources({ eodhd: true }) });
if (!checked.ok) throw new Error('golden framework must be valid');
const draftKpi = checked.framework.kpis.find(k => k.method === 'judgement') as Extract<Kpi, { method: 'judgement' }>;
// The approved version differs from the draft, so the test shows which one the Reviewer is given.
const approvedKpi = { ...draftKpi, rubric: { ...draftKpi.rubric, levels: { ...draftKpi.rubric.levels, 3: 'Approved wording for level 3.' } } };
const approved = { ...checked.framework, kpis: checked.framework.kpis.map(k => (k.id === draftKpi.id ? approvedKpi : k)) };

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Reviewer on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('reviews a stored score attempt from the approved KPI and its cited chunks, and saves the review with the served provider', async () => {
    const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning({ id: runs.id });
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-${randomUUID()}`, name: 'Alpha Energy Inc' }).returning({ id: securities.id });
    const [designerCall] = await db.insert(llmCalls).values({ runId: run!.id, role: 'designer', promptVersion: 'x', model: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id });
    const [draft] = await db.insert(kpiFrameworkDrafts).values({ runId: run!.id, attempt: 1, promptVersion: 'x', model: 'stub', llmCallId: designerCall!.id, draft: {}, errors: [], valid: true, framework: checked.framework }).returning({ id: kpiFrameworkDrafts.id });
    const [version] = await db.insert(kpiFrameworkVersions).values({ runId: run!.id, version: 1, sourceDraftId: draft!.id, framework: approved, exclusions: [], edited: true, approvedBy: 'pm' }).returning({ id: kpiFrameworkVersions.id });
    await db.update(runs).set({ frameworkVersion: version!.id }).where(eq(runs.id, run!.id));
    const snapshot = await createSnapshot({ db });
    const chunk = { id: randomUUID(), docId: randomUUID(), text: 'Grid products generated 26% of total revenue in fiscal 2025.' };
    await db.insert(documentChunks).values({ id: chunk.id, docKind: 'sec_filing', docId: chunk.docId, issuerKey: 'cik:0000000042', availableOn: '2026-05-01', section: 'Item 1. Business', ordinal: 0, startOffset: 0, endOffset: chunk.text.length, text: chunk.text, embedding: new Array(1536).fill(0) as number[], indexVersion: `v-${randomUUID()}` });
    const citation = { evidenceId: 'e2', quote: 'Grid products generated 26% of total revenue', chunkId: chunk.id, docKind: 'sec_filing', docId: chunk.docId, section: 'Item 1. Business', startOffset: 0, endOffset: 44, availableOn: '2026-05-01' };
    const [score] = await db.insert(kpiScores).values({
      runId: run!.id, frameworkDraftId: draft!.id, snapshotId: snapshot.id, securityId: security!.id, symbol: 'ALPH.US', kpiId: draftKpi.id, asOf: '2026-11-01', attempt: 2, method: 'judgement',
      level: '3', citations: [citation, citation], rationale: 'The Analyst reasoning that must stay hidden.', conflicts: ['A conflict the Analyst listed.'], evidence: [], errors: [], confidence: '0.8', valid: true,
    }).returning({ id: kpiScores.id });

    const loaded = await loadReviewerInput(db, score!.id);
    expect(loaded).toEqual({
      runId: run!.id,
      input: {
        score: { company: 'Alpha Energy Inc', symbol: 'ALPH.US', asOf: '2026-11-01', level: '3' },
        kpi: { name: approvedKpi.name, definition: approvedKpi.definition, lookbackDays: approvedKpi.lookbackDays, rubric: approvedKpi.rubric },
        passages: [{ id: 'e2', chunkId: chunk.id, issuer: 'cik:0000000042', availableOn: '2026-05-01', section: 'Item 1. Business', text: chunk.text }],
      },
    });

    const prompts: string[] = [];
    const gateway: StructuredGenerator = {
      async generate(request) {
        prompts.push(request.user);
        const raw = { verdict: 'retry', issue: 'unsupported_level', note: 'Passage e2 shows 26%, which the rubric puts at level 3 only with a growth plan.', suggestedLevel: '2' };
        const [call] = await db.insert(llmCalls).values({ runId: request.runId, role: request.role, promptVersion: request.promptVersion, model: 'deepseek/deepseek-v4.1-flash-1017', provider: 'Novita', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw }).returning({ id: llmCalls.id });
        request.onAudit?.(call!.id);
        return request.schema.parse(raw);
      },
    };
    const outcome = await reviewScore({ db, gateway, runId: loaded.runId }, score!.id, loaded.input);
    expect(prompts[0]).toContain('Approved wording for level 3.');
    expect(prompts[0]).not.toContain('must stay hidden');
    expect(prompts[0]).not.toContain('A conflict the Analyst listed');
    const [row] = await db.select().from(reviews).where(eq(reviews.id, outcome.reviewId));
    expect(row).toMatchObject({ runId: run!.id, scoreId: score!.id, llmCallId: outcome.llmCallId, model: 'deepseek/deepseek-v4.1-flash-1017', provider: 'Novita', verdict: 'retry', issue: 'unsupported_level', suggestedLevel: '2' });
    expect(row?.promptVersion).toMatch(/^reviewer@v1:[0-9a-f]{12}$/);
    await expect(db.update(reviews).set({ verdict: 'accept' }).where(eq(reviews.id, outcome.reviewId))).rejects.toMatchObject({ cause: { message: 'reviews is append-only' } });
    await expect(db.execute(sql`insert into reviews (run_id, score_id, llm_call_id, prompt_version, model, verdict, issue, note) values (${run!.id}, ${score!.id}, ${outcome.llmCallId}, 'x', 'm', 'maybe', 'none', '')`)).rejects.toMatchObject({ cause: { constraint_name: 'reviews_verdict' } });
  });
});
