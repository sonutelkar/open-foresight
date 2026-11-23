import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { basketMembers, baskets, humanDecisions, kpiScores, llmCalls, runStatusHistory, runUniverse, runs } from '@open-foresight/db';
import { advance, drive, failRun, StageFailure, type WorkerDeps } from './stages.js';
import { framework, approve, createRun, fakeDesigner, fakeGateway, fakeRetriever, freshDatabase, seedWorld } from './test-world.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('run orchestration on Postgres', () => {
  let world: Awaited<ReturnType<typeof freshDatabase>>;
  let db: PostgresJsDatabase;
  let issuers: Map<string, string>;
  beforeAll(async () => {
    world = await freshDatabase(); db = world.db;
    issuers = new Map([...(await seedWorld(db))].map(([, v]) => [v.id, v.issuerKey]));
  });
  afterAll(async () => { await world.close(); });

  const depsFor = () => {
    const designer = fakeDesigner(db);
    const gateway = fakeGateway(db);
    const deps: WorkerDeps = { db, design: designer.design, gateway: gateway.generator, retriever: fakeRetriever(id => issuers.get(id) ?? 'none'), availableSources: ['sec_filings', 'esef_filings', 'sec_facts', 'prices', 'market_cap'], scoreConcurrency: 2 };
    return { deps, designer, gateway };
  };
  const statusOf = async (runId: string) => (await db.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)))[0]!.s;
  const modelCalls = async (runId: string) => (await db.select({ id: llmCalls.id, role: llmCalls.role }).from(llmCalls).where(eq(llmCalls.runId, runId))).filter(c => c.role === 'analyst').length;
  /** The text KPIs of the golden framework: one extract_then_quant and two judgement. Quant KPIs make no model call. */
  const textKpis = 3;

  it('drives a brief to gate 1 and stops, recording the universe and the draft', async () => {
    const { deps, designer } = depsFor();
    const runId = await createRun(db);
    expect(await drive(deps, runId)).toBe('awaiting_kpi_approval');
    expect(designer.state.calls).toBe(1);
    const rows = await db.select().from(runUniverse).where(eq(runUniverse.runId, runId));
    const by = new Map(rows.map(r => [r.symbol, r]));
    expect(rows).toHaveLength(7);
    expect(rows.filter(r => r.included).map(r => r.symbol).sort()).toEqual(['ALPH.US', 'BETA.US', 'DELT.PA', 'GAMM.US', 'NOSE.US']);
    expect(by.get('TINY.US')).toMatchObject({ included: false, reasons: ['below_min_market_cap'] });
    expect(by.get('EXCL.US')).toMatchObject({ included: false, reasons: ['excluded_by_rule'] });
    expect(Number(by.get('DELT.PA')!.marketCapUsd)).toBeCloseTo(10e9, 0);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.snapshotId).toBeTruthy();
    expect((run?.settings as { universe: { included: number } }).universe.included).toBe(5);
  });

  it('enforces gate 1: nothing moves a run past it without a recorded approval', async () => {
    const { deps, gateway } = depsFor();
    const runId = await createRun(db);
    await drive(deps, runId);
    expect(await advance(deps, runId)).toMatchObject({ from: 'awaiting_kpi_approval', to: 'awaiting_kpi_approval', more: false });
    expect(await drive(deps, runId)).toBe('awaiting_kpi_approval');
    await expect(db.update(runs).set({ status: 'prescreening' }).where(eq(runs.id, runId))).rejects.toThrow();
    expect(await statusOf(runId)).toBe('awaiting_kpi_approval');
    expect(gateway.state.calls).toBe(0);
    await approve(db, runId, 'ada');
    expect(await db.select().from(humanDecisions).where(eq(humanDecisions.runId, runId))).toMatchObject([{ userId: 'ada', stage: 'awaiting_kpi_approval', action: 'approve' }]);
    expect(await statusOf(runId)).toBe('prescreening');
  });

  it('runs from approval to a provisional basket with a funnel, weights and exact contributions', async () => {
    const { deps, gateway } = depsFor();
    const runId = await createRun(db);
    await drive(deps, runId);
    await approve(db, runId);
    expect(await drive(deps, runId)).toBe('done');

    const universe = await db.select().from(runUniverse).where(eq(runUniverse.runId, runId));
    expect(universe.find(r => r.symbol === 'NOSE.US')).toMatchObject({ included: false, reasons: ['no_security'] });
    expect(universe.find(r => r.symbol === 'ALPH.US')).toMatchObject({ coverage: 'none', ciks: ['0000000101'], issuerKeys: ['cik:0000000101'] });
    expect(gateway.state.calls).toBe(4 * textKpis);

    const [basket] = await db.select().from(baskets).where(eq(baskets.runId, runId));
    expect(basket).toMatchObject({ status: 'provisional', unknownMode: 'lenient' });
    expect(basket?.funnel).toMatchObject({ universe: 7, screened: 4, candidates: 4, gateFailed: 1, gateUnknown: 0, eligible: 3, selected: 3, belowCutoff: 0 });
    expect(basket?.excluded).toEqual([expect.objectContaining({ symbol: 'GAMM.US', reason: 'gate_failed' })]);
    const members = (await db.select().from(basketMembers).where(eq(basketMembers.basketId, basket!.id))).sort((a, b) => a.rank - b.rank);
    expect(members.map(m => m.symbol)).toEqual(['ALPH.US', 'DELT.PA', 'BETA.US']);
    expect(members.reduce((s, m) => s + Number(m.weightPercent), 0)).toBeCloseTo(100, 6);
    for (const m of members) {
      const parts = m.contributions as Array<{ contribution: number }>;
      expect(parts.reduce((s, c) => s + c.contribution, 0) + Number(m.capAdjustment)).toBeCloseTo(Number(m.score), 9);
    }
    // Alpha: the extracted 0.4 is level 3 on the gate, the judgements are 4 and 4, market cap is level 3, and R&D intensity has no filing facts, so it is unknown.
    // The score renormalises over the 85 known percent.
    expect(Number(members[0]!.score)).toBeCloseTo((0.3 * 0.75 + 0.25 + 0.2 + 0.1 * 0.75) / 0.85, 9);
    expect(Number(members[0]!.unknownWeight)).toBeCloseTo(0.15, 9);
    expect((await db.select({ s: runStatusHistory.status }).from(runStatusHistory).where(eq(runStatusHistory.runId, runId)).orderBy(runStatusHistory.sequence)).map(r => r.s))
      .toEqual(['draft', 'universe_built', 'designing', 'awaiting_kpi_approval', 'prescreening', 'analysing', 'packaging', 'done']);
  });

  it('with Jev first scoring on, carries the Luna fallback flag into the basket and keeps Jev\'s unknown answer, and with it off adds no flag', async () => {
    const { deps, gateway } = depsFor();
    const jevFirst = { async decide(input: { state: string }) {
      const known = (JSON.parse(input.state) as { company: string }).company === 'Alpha Energy Inc';
      return { id: 'jev-dec', answers: { level: { type: 'score' as const, score: 3, legend: {}, probabilities: { '3': 1 }, confidence: 0.9 }, known: { type: 'noul' as const, noul: known ? 0.95 : 0.1 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } };
    } };
    const judgementIds = framework.kpis.filter(k => k.method === 'judgement').map(k => k.id);
    const runId = await createRun(db);
    await drive(deps, runId);
    await approve(db, runId);
    expect(await drive({ ...deps, jevFirst }, runId)).toBe('done');
    // Alpha's judgement KPIs come from Jev. The other three names fall back, so the Analyst scores their judgement KPIs and every name's extraction KPI.
    expect(gateway.state.calls).toBe(4 + 3 * judgementIds.length);
    const rows = await db.select().from(kpiScores).where(eq(kpiScores.runId, runId));
    const universe = await db.select().from(runUniverse).where(eq(runUniverse.runId, runId));
    const alpha = universe.find(u => u.symbol === 'ALPH.US')!.securityId, beta = universe.find(u => u.symbol === 'BETA.US')!.securityId;
    expect(rows.filter(r => r.securityId === alpha && judgementIds.includes(r.kpiId)).map(r => r.route)).toEqual(judgementIds.map(() => 'jev'));
    const fallbackRows = rows.filter(r => r.securityId === beta && judgementIds.includes(r.kpiId));
    expect(fallbackRows).toHaveLength(judgementIds.length);
    for (const r of fallbackRows) expect(r).toMatchObject({ route: 'luna-fallback', jevAnswer: { level: 'unknown', reason: 'unknown_rule' } });
    expect(rows.filter(r => !judgementIds.includes(r.kpiId)).every(r => r.route === null)).toBe(true);
    const [basket] = await db.select().from(baskets).where(eq(baskets.runId, runId));
    const members = await db.select().from(basketMembers).where(eq(basketMembers.basketId, basket!.id));
    const routes = (symbol: string) => (members.find(m => m.symbol === symbol)!.contributions as Array<{ kpiId: string; route?: string }>).filter(c => c.route).map(c => c.route);
    expect(routes('ALPH.US')).toEqual(judgementIds.map(() => 'jev'));
    expect(routes('BETA.US')).toEqual(judgementIds.map(() => 'luna-fallback'));

    const off = await createRun(db);
    await drive(deps, off);
    await approve(db, off);
    await drive(deps, off);
    const [offBasket] = await db.select().from(baskets).where(eq(baskets.runId, off));
    const offMembers = await db.select().from(basketMembers).where(eq(basketMembers.basketId, offBasket!.id));
    expect(JSON.stringify(offMembers.map(m => m.contributions))).not.toContain('route');
    expect((await db.select().from(kpiScores).where(eq(kpiScores.runId, off))).every(r => r.route === null && r.jevAnswer === null)).toBe(true);
  });

  it('with the exposure check on, settles a name plainly outside the theme as a known gate failure and spends no Analyst call on its gate KPI', async () => {
    const { deps, gateway } = depsFor();
    const asked: string[] = [];
    const exposureJudge = { async decide(input: { state: string; role: string }) { const company = (JSON.parse(input.state) as { company: string }).company; asked.push(company); const none = company === 'Gamma Oil Co'; return { id: `dec-${asked.length}`, answers: { exposure: { type: 'choice' as const, choice: none ? 'none' : 'core', probabilities: { core: none ? 0 : 0.9, partial: 0.05, none: none ? 0.98 : 0, cannot_tell: 0 }, confidence: 0.9 } } }; } };
    const gated = { ...framework, kpis: framework.kpis.map(k => ({ ...k, isGate: k.id === 'storage_commitment' })) } as typeof framework;
    const runId = await createRun(db);
    await drive({ ...deps, exposureJudge }, runId);
    await approve(db, runId, 'ada', gated);
    expect(await drive({ ...deps, exposureJudge }, runId)).toBe('done');
    expect(new Set(asked)).toEqual(new Set(['Alpha Energy Inc', 'Beta Grid Corp', 'Gamma Oil Co', 'Delta Electrique SA']));
    const [gamma] = await db.select().from(runUniverse).where(eq(runUniverse.runId, runId)).then(r => r.filter(u => u.symbol === 'GAMM.US'));
    const rows = await db.select().from(kpiScores).where(eq(kpiScores.runId, runId));
    expect(rows.filter(r => r.securityId === gamma!.securityId && r.kpiId === 'storage_commitment')).toMatchObject([{ level: '0', valid: true, promptVersion: 'exposure-choice@v1', llmCallId: null }]);
    expect(gateway.state.calls).toBe(4 * textKpis - 1);
    const [basket] = await db.select().from(baskets).where(eq(baskets.runId, runId));
    expect(basket?.excluded).toEqual([expect.objectContaining({ symbol: 'GAMM.US', reason: 'gate_failed' })]);
  });

  it('is safe to repeat: a finished run, or a second packaging job, adds nothing', async () => {
    const { deps, gateway } = depsFor();
    const runId = await createRun(db);
    await drive(deps, runId);
    await approve(db, runId);
    await drive(deps, runId);
    const calls = gateway.state.calls;
    expect(await drive(deps, runId)).toBe('done');
    expect(await advance(deps, runId)).toMatchObject({ from: 'done', more: false });
    expect(gateway.state.calls).toBe(calls);
    expect(await db.select().from(baskets).where(eq(baskets.runId, runId))).toHaveLength(1);

    // Two workers on the packaging stage at once still produce one basket, with its members once.
    const racing = await createRun(db);
    await drive(deps, racing);
    await approve(db, racing);
    while ((await statusOf(racing)) !== 'packaging') await advance(deps, racing);
    const both = await Promise.all([advance(deps, racing), advance(deps, racing)]);
    expect(both.map(r => r.to)).toContain('done');
    expect(await statusOf(racing)).toBe('done');
    const [made] = await db.select().from(baskets).where(eq(baskets.runId, racing));
    expect(await db.select().from(baskets).where(eq(baskets.runId, racing))).toHaveLength(1);
    expect((await db.select().from(basketMembers).where(eq(basketMembers.basketId, made!.id))).length).toBe(3);
  });

  it('resumes after a model outage without repeating finished model calls', async () => {
    const { deps, gateway } = depsFor();
    const runId = await createRun(db);
    await drive(deps, runId);
    await approve(db, runId);
    gateway.state.failAfter = 5;
    await expect(drive(deps, runId)).rejects.toThrow('unavailable');
    expect(await statusOf(runId)).toBe('analysing');
    const saved = await db.select().from(kpiScores).where(eq(kpiScores.runId, runId));
    expect(saved.filter(s => s.method !== 'quant' && s.valid).length).toBe(5);

    gateway.state.failAfter = Infinity;
    expect(await drive(deps, runId)).toBe('done');
    expect(await modelCalls(runId)).toBe(4 * textKpis);
    expect(await db.select().from(baskets).where(eq(baskets.runId, runId))).toHaveLength(1);
  });

  it('fails the run with the reason when the Designer produces no valid framework', async () => {
    const { deps, designer } = depsFor();
    designer.state.fail = true;
    const runId = await createRun(db);
    await expect(drive(deps, runId)).rejects.toBeInstanceOf(StageFailure);
    expect(await statusOf(runId)).toBe('designing');
    await failRun(db, runId, 'worker', 'The Designer produced no valid framework');
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run?.status).toBe('failed');
    expect((run?.settings as { failure: { message: string } }).failure.message).toContain('no valid framework');
    expect(await drive(deps, runId)).toBe('failed');
    expect(designer.state.calls).toBe(1);
  });
});
