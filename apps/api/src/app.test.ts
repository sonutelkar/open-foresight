import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources, validateFramework, type FrameworkDraft } from '@open-foresight/core';
import { humanDecisions, kpiFrameworkDrafts, kpiFrameworkVersions, llmCalls, runs } from '@open-foresight/db';
import { createApp, type AppDeps } from './app.js';

const golden = JSON.parse(readFileSync(new URL('../../../packages/core/fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const sources = enabledSources({ eodhd: true });
const checked = validateFramework(golden, { availableSources: sources });
if (!checked.ok) throw new Error('golden framework must be valid');
const framework = checked.framework;

const TOKEN = 'test-approver-token-0123456789';
const headers = { 'content-type': 'application/json', 'x-approval-token': TOKEN, 'x-analyst': 'Ada Analyst' };
const brief = {
  brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon, including grid equipment, efficiency products and storage, with second order suppliers.',
  keywords: ['smart grid'], seedNames: ['SU.PA'], exclusions: ['pure EV makers'], regions: ['US', 'EU'], minMarketCapUsd: 1e9, minAdvUsd: 5e6,
  asOf: '2026-11-20', exposureStyle: 'broad', basketSize: 40, weightCapPercent: 5, weighting: 'score', reviewLevel: 'kpis_and_flags', modelProfile: 'quality',
};

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('API on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 4 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  const queued: string[] = [];
  let queueDown = false;
  const enqueue: AppDeps['enqueue'] = async runId => { if (queueDown) throw new Error('The queue is down'); queued.push(runId); };
  /** Stands in for the worker's first stages: the universe, then the Designer, which saves a valid draft with its audit row. */
  async function workerReachesGate1(runId: string) {
    await db.update(runs).set({ status: 'universe_built' }).where(eq(runs.id, runId));
    await db.update(runs).set({ status: 'designing' }).where(eq(runs.id, runId));
    const [call] = await db.insert(llmCalls).values({ runId, role: 'designer', promptVersion: 'designer@v2:test', model: 'stub/designer', provider: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id });
    await db.insert(kpiFrameworkDrafts).values({ runId, attempt: 1, promptVersion: 'designer@v2:test', model: 'stub/designer', llmCallId: call!.id, draft: golden, errors: [], valid: true, framework });
    await db.update(runs).set({ status: 'awaiting_kpi_approval' }).where(eq(runs.id, runId));
  }
  const make = () => createApp({ db, token: TOKEN, availableSources: sources, today: () => '2026-11-22', enqueue });
  const post = (app: ReturnType<typeof make>['app'], path: string, body: unknown, over: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { ...headers, ...over }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const runCount = async () => Number((await db.select({ n: count() }).from(runs))[0]?.n);

  async function readyRun(api = make()) {
    const res = await post(api.app, '/api/runs', brief);
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };
    await workerReachesGate1(runId);
    return { api, runId };
  }
  const approve = (api: ReturnType<typeof make>, runId: string, body: unknown, over: Record<string, string> = {}) => post(api.app, `/api/runs/${runId}/approve`, body, over);
  const clone = () => structuredClone(framework);

  it('serves the form configuration without a token', async () => {
    const res = await make().app.request('/api/config');
    const body = await res.json() as { today: string; regions: string[]; availableSources: string[]; briefLimits: { minWords: number }; frameworkLimits: { kpis: number[] } };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ today: '2026-11-22', regions: ['US', 'EU', 'UK', 'CH'], briefLimits: { minWords: 20 }, frameworkLimits: { kpis: [3, 8] } });
    expect(body.availableSources).toContain('sec_filings');
  });

  it('requires the approver token and an analyst name for every change', async () => {
    const { app } = make();
    const before = await runCount();
    expect((await post(app, '/api/runs', brief, { 'x-approval-token': 'wrong' })).status).toBe(401);
    expect((await app.request('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(brief) })).status).toBe(401);
    expect((await post(app, '/api/runs', brief, { 'x-analyst': '   ' })).status).toBe(401);
    expect((await post(app, '/api/runs', brief, { 'x-analyst': 'x'.repeat(81) })).status).toBe(401);
    expect(await runCount()).toBe(before);
    expect((await app.request('/api/runs')).status).toBe(200);
  });

  it('blocks invalid briefs with field errors and creates no run', async () => {
    const { app } = make();
    const before = await runCount();
    const queuedBefore = queued.length;
    const bad = async (over: Record<string, unknown>) => { const r = await post(app, '/api/runs', { ...brief, ...over }); return { status: r.status, body: await r.json() as { errors?: Array<{ field: string; code: string }> } }; };
    const short = await bad({ brief: 'Too short.' });
    expect(short.status).toBe(422);
    expect(short.body.errors?.map(e => e.code)).toEqual(['brief_too_short']);
    expect((await bad({ asOf: '2026-11-23' })).body.errors?.map(e => e.code)).toEqual(['future_date']);
    expect((await bad({ basketSize: 10, weightCapPercent: 5 })).body.errors?.map(e => e.code)).toEqual(['infeasible_cap']);
    expect((await bad({ regions: ['JP'] })).status).toBe(422);
    expect((await post(app, '/api/runs', 'not json')).status).toBe(400);
    const big = JSON.stringify({ ...brief, brief: 'x'.repeat(1_100_000) });
    expect((await post(app, '/api/runs', big, { 'content-length': String(big.length) })).status).toBe(413);
    expect(await runCount()).toBe(before);
    expect(queued).toHaveLength(queuedBefore);
  });

  it('creates a run in draft and queues it for the worker, which takes it to gate 1', async () => {
    const api = make();
    const res = await post(api.app, '/api/runs', brief);
    expect(res.status).toBe(202);
    const { runId, status } = await res.json() as { runId: string; status: string };
    expect(status).toBe('draft');
    expect(queued.at(-1)).toBe(runId);
    const fresh = await (await api.app.request(`/api/runs/${runId}`)).json() as { status: string; settings: { createdBy: string; brief: string; exclusions: string[] }; draft: unknown; basket: unknown };
    expect(fresh).toMatchObject({ status: 'draft', draft: null, basket: null, settings: { createdBy: 'Ada Analyst', brief: brief.brief, exclusions: ['pure EV makers'] } });
    await workerReachesGate1(runId);
    const body = await (await api.app.request(`/api/runs/${runId}`)).json() as { status: string; history: Array<{ status: string }>; draft: { framework: { kpis: unknown[] }; promptVersion: string } };
    expect(body.status).toBe('awaiting_kpi_approval');
    expect(body.history.map(h => h.status)).toEqual(['draft', 'universe_built', 'designing', 'awaiting_kpi_approval']);
    expect(body.draft.framework.kpis).toHaveLength(5);
    expect(body.draft.promptVersion).toBe('designer@v2:test');
  });

  it('still creates the run when the queue is down, leaving it for the worker sweep', async () => {
    queueDown = true;
    try {
      const api = make();
      const before = queued.length;
      const res = await post(api.app, '/api/runs', brief);
      expect(res.status).toBe(202);
      const { runId } = await res.json() as { runId: string };
      expect(queued).toHaveLength(before);
      expect((await db.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)))[0]?.s).toBe('draft');
    } finally { queueDown = false; }
  });

  it('rejects every kind of invalid approval and leaves no version, decision or status change', async () => {
    const { api, runId } = await readyRun();
    const check = async (edit: (f: ReturnType<typeof clone>) => void, code: string) => {
      const f = clone(); edit(f);
      const res = await approve(api, runId, { framework: f });
      expect(res.status, code).toBe(422);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors.map(e => e.code), code).toContain(code);
    };
    await check(f => { f.kpis[0]!.weightPercent = 35; }, 'weight_total');
    await check(f => { if (f.kpis[2]!.method === 'judgement') f.kpis[2]!.rubric.levels['3'] = ''; }, 'incomplete_rubric');
    await check(f => { f.kpis[1]!.isGate = true; }, 'gate_count');
    await check(f => { f.kpis[0]!.sources = ['bloomberg_terminal' as never]; }, 'unknown_source');
    expect((await approve(api, runId, { framework: { kpis: 'many' } })).status).toBe(422);
    expect((await approve(api, runId, { exclusions: [] })).status).toBe(400);
    const sameShuffled = Object.fromEntries(Object.entries(framework).reverse());
    expect(sameShuffled).toEqual(framework);
    expect((await approve(api, runId, { framework, extra: true })).status).toBe(400);
    expect((await approve(api, runId, { framework }, { 'x-approval-token': 'wrong' })).status).toBe(401);
    expect((await approve(api, randomUUID(), { framework })).status).toBe(404);
    expect((await approve(api, 'not-a-uuid', { framework })).status).toBe(400);
    expect(await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId))).toHaveLength(0);
    expect(await db.select().from(humanDecisions).where(eq(humanDecisions.runId, runId))).toHaveLength(0);
    expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe('awaiting_kpi_approval');
  });

  it('refuses to approve a run that is not at gate 1', async () => {
    const api = make();
    const { runId } = await (await post(api.app, '/api/runs', brief)).json() as { runId: string };
    const before = queued.length;
    const res = await approve(api, runId, { framework });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('draft');
    expect(queued).toHaveLength(before);
  });

  it('freezes an unedited framework, records the decision against the version and advances the run', async () => {
    const { api, runId } = await readyRun();
    const res = await approve(api, runId, { framework, exclusions: ['pure EV makers'], reason: 'Looks right' });
    expect(res.status).toBe(201);
    const created = await res.json() as { versionId: string; version: number; status: string };
    expect(created).toMatchObject({ version: 1, status: 'prescreening' });
    const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId));
    expect(version).toMatchObject({ id: created.versionId, version: 1, edited: false, approvedBy: 'Ada Analyst', exclusions: ['pure EV makers'] });
    expect(version?.framework).toEqual(framework);
    const [draft] = await db.select().from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, runId));
    expect(version?.sourceDraftId).toBe(draft?.id);
    const [decision] = await db.select().from(humanDecisions).where(eq(humanDecisions.runId, runId));
    expect(decision).toMatchObject({ userId: 'Ada Analyst', stage: 'awaiting_kpi_approval', target: created.versionId, action: 'approve', reason: 'Looks right' });
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ status: 'prescreening', frameworkVersion: created.versionId });
    // The approval queued the run again for the worker: once when it was created, once now. A blocked approval queues nothing.
    expect(queued.filter(id => id === runId)).toHaveLength(2);
    // The frozen version never changes, and a second approval is blocked.
    await expect(client.unsafe('DELETE FROM kpi_framework_versions')).rejects.toThrow('append-only');
    expect((await approve(api, runId, { framework })).status).toBe(409);
    expect(queued.filter(id => id === runId)).toHaveLength(2);
    expect(await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId))).toHaveLength(1);
  });

  it('freezes an edited framework as edited, leaving the model draft untouched', async () => {
    const { api, runId } = await readyRun();
    const edited = clone();
    const judgement = edited.kpis.find(k => k.method === 'judgement');
    if (!judgement || judgement.method !== 'judgement') throw new Error('golden needs a judgement KPI');
    judgement.rubric.levels['4'] = 'The company is defined by storage products, with segment revenue disclosed above 60 percent.';
    edited.kpis[0]!.weightPercent = 25; edited.kpis[3]!.weightPercent = 25;
    const res = await approve(api, runId, { framework: edited });
    expect(res.status).toBe(201);
    const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId));
    expect(version?.edited).toBe(true);
    const stored = version?.framework as typeof edited;
    expect(stored.kpis[0]!.weightPercent).toBe(25);
    expect(stored.kpis.find(k => k.id === judgement.id && k.method === 'judgement')).toMatchObject({ rubric: { levels: { '4': expect.stringContaining('60 percent') } } });
    const [draft] = await db.select().from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, runId));
    expect(draft?.framework).toEqual(framework);
  });

  it('handles 100 brief submissions and 100 approvals inside the ceiling', async () => {
    const api = make();
    const submit: number[] = [];
    const ids: string[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      const res = await post(api.app, '/api/runs', { ...brief, brief: `${brief.brief} Variant ${i}.` });
      submit.push(performance.now() - t);
      expect(res.status).toBe(202);
      ids.push(((await res.json()) as { runId: string }).runId);
    }
    for (const id of ids) await workerReachesGate1(id);
    const approvals: number[] = [];
    for (const id of ids) {
      const t = performance.now();
      const res = await approve(api, id, { framework });
      approvals.push(performance.now() - t);
      expect(res.status).toBe(201);
    }
    const total = performance.now() - t0;
    submit.sort((a, b) => a - b); approvals.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: '100 brief submissions and 100 approvals through the API', totalMs: Math.round(total), submitMedianMs: Math.round(submit[50] ?? 0), approveMedianMs: Math.round(approvals[50] ?? 0), approveP95Ms: Math.round(approvals[95] ?? 0) })}\n`);
    expect(total).toBeLessThan(30_000);
  }, 120_000);
});
