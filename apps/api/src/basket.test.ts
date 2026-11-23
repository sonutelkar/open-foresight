import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources, validateFramework, type FrameworkDraft } from '@open-foresight/core';
import { baskets, basketMembers, createSnapshot, documentChunks, esefFilings, kpiFrameworkDrafts, kpiFrameworkVersions, kpiScores, llmCalls, runs, secFilings, secSourceDocuments, securities } from '@open-foresight/db';
import { createApp } from './app.js';

const golden = JSON.parse(readFileSync(new URL('../../../packages/core/fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const sources = enabledSources({ eodhd: true });
const checked = validateFramework(golden, { availableSources: sources });
if (!checked.ok) throw new Error('golden framework must be valid');
const framework = checked.framework;
const [textKpi, otherKpi] = [framework.kpis.find(k => k.method !== 'quant')!, framework.kpis.filter(k => k.method !== 'quant')[1]!];

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const passage = 'Fluence is positioned to be a leading participant in this growth, with 7.2 GW of energy storage assets deployed and a gross global pipeline of 41.8 GW.';
const zeroVector = `[${new Array(1536).fill(0).join(',')}]`;

integration('Basket evidence API on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 4 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const api = createApp({ db, token: 'unused-token-0123456789', availableSources: sources, today: () => '2026-11-22', enqueue: async () => {} }).app;
  const get = (path: string) => api.request(path);

  /** A run with `size` basket members. The worker's path to `done` needs a recorded gate approval, which these reads do not depend on, so the run stays at gate 1. Member 0 gets scores that cite an SEC passage, an ESEF passage, and a quote that is not in its passage. */
  async function seed(size: number, status: 'open' | 'failed' = 'open') {
    const [run] = await db.insert(runs).values({ settings: { brief: 'Smart energy' }, modelProfile: 'quality' }).returning({ id: runs.id });
    const runId = run!.id;
    for (const next of status === 'failed' ? ['failed' as const] : ['universe_built', 'designing', 'awaiting_kpi_approval'] as const) await db.update(runs).set({ status: next }).where(eq(runs.id, runId));
    const [call] = await db.insert(llmCalls).values({ runId, role: 'designer', promptVersion: 'x', model: 'stub', provider: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id });
    const [draft] = await db.insert(kpiFrameworkDrafts).values({ runId, attempt: 1, promptVersion: 'x', model: 'stub', llmCallId: call!.id, draft: golden, errors: [], valid: true, framework }).returning({ id: kpiFrameworkDrafts.id });
    const [version] = await db.insert(kpiFrameworkVersions).values({ runId, version: 1, sourceDraftId: draft!.id, framework, exclusions: [], edited: false, approvedBy: 'Ada' }).returning({ id: kpiFrameworkVersions.id });
    const [basket] = await db.insert(baskets).values({ runId, frameworkVersionId: version!.id, status: 'provisional', unknownMode: 'lenient', rules: {}, funnel: { universe: size, screened: size, candidates: size, gateFailed: 0, gateUnknown: 0, zeroScore: 0, eligible: size, selected: size, belowCutoff: 0 }, cap: { requestedPercent: 5, usedPercent: 5, relaxed: false }, excluded: [] }).returning({ id: baskets.id });
    const ids = size === 0 ? [] : (await db.insert(securities).values(Array.from({ length: size }, (_, i) => ({ shareClassFigi: `SC-${randomUUID()}-${i}`, name: `Name ${i}` }))).returning({ id: securities.id })).map(r => r.id);
    if (size > 0) await db.insert(basketMembers).values(ids.map((securityId, i) => ({ basketId: basket!.id, securityId, symbol: `S${i}.US`, name: `Name ${i}`, rank: i + 1, score: '0.5', confidence: '0.7', weightPercent: String(100 / size), atCap: false, unknownWeight: '0', capAdjustment: '0', contributions: [] })));
    return { runId, draftId: draft!.id, ids };
  }

  async function seedEvidence(world: Awaited<ReturnType<typeof seed>>) {
    const snapshot = await createSnapshot({ db });
    const [src] = await db.insert(secSourceDocuments).values({ url: `https://www.sec.gov/Archives/edgar/data/1/${randomUUID()}.htm`, transportUrl: 'https://www.sec.gov/x', sha256: randomUUID(), body: '', fetchedAt: new Date() }).returning({ id: secSourceDocuments.id, url: secSourceDocuments.url });
    const [sec] = await db.insert(secFilings).values({ cik: '0000000001', accession: randomUUID().slice(0, 20), form: '10-K', filedAt: '2026-03-02', primaryDocument: 'a.htm', submissionSourceId: src!.id, documentSourceId: src!.id, ingestedAt: new Date() }).returning({ id: secFilings.id });
    const [esef] = await db.insert(esefFilings).values({ fxoId: randomUUID(), lei: 'LEI123', entityName: 'ASML', country: 'NL', periodEnd: '2025-12-31', availableOn: '2026-03-01', availableSource: 'published', dateAddedAt: new Date(), reportUrl: '/LEI123/2025-12-31/ESEF/NL/0/a/reports/a.xhtml', packageSha256: randomUUID(), ingestedAt: new Date() }).returning({ id: esefFilings.id });
    const chunk = async (docKind: string, docId: string, text: string) => (await db.insert(documentChunks).values({ docKind, docId, issuerKey: 'cik:0000000001', availableOn: '2026-03-02', section: 'ITEM 1. BUSINESS', ordinal: 0, startOffset: 10, endOffset: 10 + text.length, text, embedding: JSON.parse(zeroVector) as number[], indexVersion: `v-${randomUUID()}` }).returning({ id: documentChunks.id }))[0]!.id;
    const secChunk = await chunk('sec_filing', sec!.id, passage), esefChunk = await chunk('esef_filing', esef!.id, 'ASML supplies lithography systems to chipmakers.');
    const cite = (evidenceId: string, quote: string, chunkId: string, docKind: string, docId: string) => ({ evidenceId, quote, chunkId, docKind, docId, section: 'ITEM 1. BUSINESS', availableOn: '2026-03-02', startOffset: 10, endOffset: 60 });
    const base = { runId: world.runId, frameworkDraftId: world.draftId, snapshotId: snapshot.id, securityId: world.ids[0]!, symbol: 'S0.US', asOf: '2026-11-20', method: 'judgement', confidence: '0.8', errors: [], conflicts: [], evidence: [] };
    await db.insert(kpiScores).values([
      { ...base, kpiId: textKpi.id, attempt: 1, level: '2', valid: true, rationale: 'First attempt.', citations: [] },
      { ...base, kpiId: textKpi.id, attempt: 2, level: '3', valid: true, rationale: 'The filing reports deployed storage.', citations: [cite('e1', '7.2 GW of  energy storage assets deployed', secChunk, 'sec_filing', sec!.id), cite('e2', 'ASML supplies lithography systems', esefChunk, 'esef_filing', esef!.id), cite('e3', 'a sentence the passage never contains', secChunk, 'sec_filing', sec!.id)] },
      { ...base, kpiId: otherKpi.id, attempt: 1, level: '2', valid: true, rationale: 'The quote names no defined offering.', citations: [], adjustments: [{ code: 'no_definition_term', from: '4', to: '2', message: 'No cited quote names an offering from the KPI definition, so level 4 was lowered to 2.' }] },
    ]);
    return { secUrl: src!.url };
  }

  it('shows the latest valid score per KPI with its quotes, source links and whether each quote is in the stored passage', async () => {
    const world = await seed(3); const { secUrl } = await seedEvidence(world);
    const res = await get(`/api/runs/${world.runId}/members/S0.US/evidence`);
    expect(res.status).toBe(200);
    const body = await res.json() as { symbol: string; kpis: Array<Record<string, any>> };
    expect(body.kpis.map(k => k.kpiId)).toEqual(framework.kpis.map(k => k.id));
    const text = body.kpis.find(k => k.kpiId === textKpi.id)!;
    expect(text).toMatchObject({ level: '3', scored: true, rationale: 'The filing reports deployed storage.' });
    expect(text.citations.map((c: any) => [c.evidenceId, c.quoteVerified])).toEqual([['e1', true], ['e2', true], ['e3', false]]);
    expect(text.citations[0].sourceUrl).toBe(secUrl);
    expect(text.citations[0].sourceLabel).toContain('10-K');
    expect(text.citations[1].sourceUrl).toBe('https://filings.xbrl.org/LEI123/2025-12-31/ESEF/NL/0/a/reports/a.xhtml');
    expect(body.kpis.find(k => k.kpiId === otherKpi.id)).toMatchObject({ level: '2', citations: [], adjustments: [{ code: 'no_definition_term', from: '4', to: '2' }] });
    expect(text.adjustments).toEqual([]);
    expect(body.kpis.filter(k => !k.scored).length).toBe(framework.kpis.length - 2);
  });

  it('returns 404 for a run with no basket, a name outside the basket, and 400 for a bad run id', async () => {
    const world = await seed(2);
    const [bare] = await db.insert(runs).values({ settings: {}, modelProfile: 'quality' }).returning({ id: runs.id });
    expect((await get(`/api/runs/${bare!.id}/members/S0.US/evidence`)).status).toBe(404);
    expect((await get(`/api/runs/${world.runId}/members/NOPE.US/evidence`)).status).toBe(404);
    expect((await get('/api/runs/not-a-uuid/members/S0.US/evidence')).status).toBe(400);
  });

  it('returns an empty basket and a failed run as they are', async () => {
    const empty = await seed(0);
    const emptyBody = await (await get(`/api/runs/${empty.runId}`)).json() as { basket: { members: unknown[] } };
    expect(emptyBody.basket.members).toEqual([]);
    const failed = await seed(0, 'failed');
    const failedBody = await (await get(`/api/runs/${failed.runId}`)).json() as { status: string };
    expect(failedBody.status).toBe('failed');
  });

  it('serves a 50 name basket and a name evidence panel 100 times each inside the ceiling', async () => {
    const world = await seed(50); await seedEvidence(world);
    const time = async (path: string) => { const t = performance.now(); const res = await get(path); expect(res.status).toBe(200); await res.json(); return performance.now() - t; };
    const t0 = performance.now(); const basket: number[] = [], evidence: number[] = [];
    for (let i = 0; i < 100; i++) basket.push(await time(`/api/runs/${world.runId}`));
    for (let i = 0; i < 100; i++) evidence.push(await time(`/api/runs/${world.runId}/members/S0.US/evidence`));
    const total = performance.now() - t0; basket.sort((a, b) => a - b); evidence.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: '100 basket and 100 evidence requests for a 50 name basket', totalMs: Math.round(total), basketMedianMs: Math.round(basket[50]!), basketP95Ms: Math.round(basket[95]!), evidenceMedianMs: Math.round(evidence[50]!), evidenceP95Ms: Math.round(evidence[95]!) })}\n`);
    expect(total).toBeLessThan(10_000);
  }, 60_000);
});
