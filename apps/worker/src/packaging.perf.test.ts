import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { packageBasket, type BasketKpi, type Framework, type ScoreLevel } from '@open-foresight/core';
import { baskets, basketMembers, createSnapshot, kpiFrameworkDrafts, kpiScores, llmCalls, runUniverse, runs, securities } from '@open-foresight/db';
import { advance, type WorkerDeps } from './stages.js';
import { approve, createRun, freshDatabase, framework } from './test-world.js';

/** The real scores of the 50 name live run, recorded by scripts/record-pilot-scores.ts. */
type Recorded = {
  asOf: string; unknownMode: 'strict' | 'lenient'; kpis: BasketKpi[];
  names: Array<{ symbol: string; name: string; marketCapUsd: number; advUsd: number; scores: Record<string, { level: ScoreLevel; confidence: number; method: string }> }>;
};
const path = new URL('../fixtures/pilot-50-scores.json', import.meta.url);
const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Recorded : undefined;
const url = process.env.TEST_DATABASE_URL;
const N = 3000;

/** The recorded names, repeated and perturbed in market cap and liquidity so no two securities are identical. */
const replicated = (rec: Recorded) => Array.from({ length: N }, (_, i) => {
  const base = rec.names[i % rec.names.length]!;
  return { ...base, symbol: `${base.symbol.split('.')[0]}${i}.${base.symbol.split('.')[1] ?? 'US'}`, marketCapUsd: base.marketCapUsd * (1 + (i % 17) / 100), advUsd: base.advUsd * (1 + (i % 13) / 50) };
});

describe.skipIf(!recorded)('Packaging performance, pure', () => {
  it('packages 3,000 recorded securities in code', () => {
    const rec = recorded as Recorded;
    const candidates = replicated(rec).map((n, i) => ({ securityId: `s${i}`, symbol: n.symbol, name: n.name, marketCapUsd: n.marketCapUsd, advUsd: n.advUsd, scores: n.scores }));
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      const b = packageBasket({ candidates, kpis: rec.kpis, rules: { size: 200, weightCapPercent: 2, weighting: 'score_sqrt_cap', unknownMode: rec.unknownMode } });
      times.push(performance.now() - t);
      expect(b.funnel.candidates).toBe(N);
      expect(b.members.reduce((s, m) => s + m.weightPercent, 0)).toBeCloseTo(100, 9);
    }
    times.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: 'packageBasket on 3,000 recorded securities', medianMs: Math.round(times[1]!), runsMs: times.map(Math.round) })}\n`);
    expect(times[1]!).toBeLessThan(30_000);
  });
});

describe.skipIf(!url || !recorded)('Packaging performance, stage on Postgres', () => {
  let world: Awaited<ReturnType<typeof freshDatabase>>;
  let db: PostgresJsDatabase;
  beforeAll(async () => { world = await freshDatabase(); db = world.db; }, 60_000);
  afterAll(async () => { await world?.close(); });

  it('runs the packaging stage for 3,000 recorded securities, reading the scores and writing the basket, inside the ceiling', async () => {
    const rec = recorded as Recorded;
    const names = replicated(rec);
    const runId = await createRun(db, { asOf: rec.asOf, exposureStyle: rec.unknownMode === 'strict' ? 'strict' : 'broad', basketSize: 200, weightCapPercent: 2, weighting: 'score_sqrt_cap' });
    const [call] = await db.insert(llmCalls).values({ runId, role: 'designer', promptVersion: 'x', model: 'recorded', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id });
    // Packaging reads only each KPI's id, weight and gate flag, so the recorded KPIs stand in for the full framework.
    const recordedFramework = { ...framework, kpis: rec.kpis.map(k => ({ id: k.id, weightPercent: k.weight * 100, isGate: k.isGate })) } as unknown as Framework;
    await db.insert(kpiFrameworkDrafts).values({ runId, attempt: 1, promptVersion: 'x', model: 'recorded', llmCallId: call!.id, draft: {}, errors: [], valid: true, framework: recordedFramework });
    const snapshot = await createSnapshot({ db });
    for (const status of ['universe_built', 'designing', 'awaiting_kpi_approval'] as const) await db.update(runs).set({ status }).where(eq(runs.id, runId));
    await approve(db, runId, 'analyst', recordedFramework);
    await db.update(runs).set({ status: 'analysing', snapshotId: snapshot.id }).where(eq(runs.id, runId));
    await db.update(runs).set({ status: 'packaging' }).where(eq(runs.id, runId));
    const [draft] = await db.select({ id: kpiFrameworkDrafts.id }).from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, runId));

    const ids: string[] = [];
    for (let i = 0; i < N; i += 1000) ids.push(...(await db.insert(securities).values(names.slice(i, i + 1000).map((n, j) => ({ shareClassFigi: `SC-perf-${i + j}-${randomUUID()}`, name: n.name }))).returning({ id: securities.id })).map(r => r.id));
    for (let i = 0; i < N; i += 1000) await db.insert(runUniverse).values(names.slice(i, i + 1000).map((n, j) => ({ runId, symbol: n.symbol, name: n.name, included: true, reasons: [], region: 'US', marketCapUsd: String(n.marketCapUsd), advUsd: String(n.advUsd), securityId: ids[i + j]!, coverage: 'sec' })));
    const rows = names.flatMap((n, i) => Object.entries(n.scores).map(([kpiId, s]) => ({
      runId, frameworkDraftId: draft!.id, snapshotId: snapshot.id, securityId: ids[i]!, symbol: n.symbol, kpiId, asOf: rec.asOf, attempt: 1, method: s.method, level: s.level,
      confidence: String(s.confidence), valid: true, citations: [], rationale: '', conflicts: [], evidence: [], errors: [],
    })));
    for (let i = 0; i < rows.length; i += 1000) await db.insert(kpiScores).values(rows.slice(i, i + 1000));

    const deps = { db } as unknown as WorkerDeps;
    const t = performance.now();
    const step = await advance(deps, runId);
    const ms = performance.now() - t;
    expect(step).toMatchObject({ from: 'packaging', to: 'done' });
    const [basket] = await db.select().from(baskets).where(eq(baskets.runId, runId));
    const members = await db.select().from(basketMembers).where(eq(basketMembers.basketId, basket!.id));
    expect(basket?.funnel).toMatchObject({ candidates: N });
    expect(members).toHaveLength(200);
    process.stdout.write(`${JSON.stringify({ perf: 'packaging stage on 3,000 recorded securities', stageMs: Math.round(ms), scoreRows: rows.length, members: members.length })}\n`);
    expect(ms).toBeLessThan(30_000);
  }, 180_000);
});


