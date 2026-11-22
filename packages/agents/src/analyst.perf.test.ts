import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { validateScore, type EvidenceItem, type Framework, type Kpi } from '@open-foresight/core';
import { createSnapshot, kpiFrameworkDrafts, llmCalls, runs, securities } from '@open-foresight/db';
import { scoreWithEvidence, type AnalystContext } from './analyst.js';
import type { StructuredGenerator } from './designer.js';

type Recorded = { asOf: string; company: string; symbol: string; issuerKey: string; framework: Framework; items: Array<{ kpiId: string; evidence: EvidenceItem[]; attempts: Array<{ output: unknown; valid: boolean }> }> };
const path = new URL('../fixtures/analyst-real-scores.json', import.meta.url);
const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Recorded : undefined;
const accepted = (recorded?.items ?? []).flatMap(item => { const a = item.attempts.find(x => x.valid); return a ? [{ item, output: a.output }] : []; });

describe.skipIf(!recorded || accepted.length === 0)('Analyst validation performance', () => {
  it('validates 1,000 recorded real scores inside the ceiling', () => {
    const rec = recorded as Recorded;
    const start = performance.now();
    let ok = 0;
    for (let i = 0; i < 1000; i++) {
      const { item, output } = accepted[i % accepted.length]!;
      const kpi = rec.framework.kpis.find(k => k.id === item.kpiId) as Exclude<Kpi, { method: 'quant' }>;
      if (validateScore({ kpi, output, evidence: item.evidence, asOf: rec.asOf, allowedIssuerKeys: [rec.issuerKey] }).ok) ok++;
    }
    const total = performance.now() - start;
    process.stdout.write(`${JSON.stringify({ perf: 'validate 1,000 recorded real scores', totalMs: Math.round(total), perScoreMicros: Math.round((total * 1000) / 1000), accepted: ok })}\n`);
    expect(ok).toBe(1000);
    expect(total).toBeLessThan(30_000);
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url || !recorded || accepted.length === 0)('Analyst pipeline performance', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('scores 1,000 recorded KPI results end to end, validating, saving the attempt and its audit row, inside the same ceiling', async () => {
    const rec = recorded as Recorded;
    const [call] = await db.insert(llmCalls).values({ runId: (await db.insert(runs).values({ settings: {}, modelProfile: 'perf' }).returning({ id: runs.id }))[0]!.id, role: 'designer', promptVersion: 'x', model: 'recorded', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id, runId: llmCalls.runId });
    const snapshot = await createSnapshot({ db });
    const [draft] = await db.insert(kpiFrameworkDrafts).values({ runId: call!.runId, attempt: 1, promptVersion: 'x', model: 'recorded', llmCallId: call!.id, draft: {}, errors: [], valid: true, framework: rec.framework }).returning({ id: kpiFrameworkDrafts.id });
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-perf-${randomUUID()}`, name: rec.company }).returning({ id: securities.id });
    const timings: number[] = [];
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const { item, output } = accepted[i % accepted.length]!;
      const kpi = rec.framework.kpis.find(k => k.id === item.kpiId) as Exclude<Kpi, { method: 'quant' }>;
      // Each iteration is its own run, so the idempotency check never short-circuits.
      const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'perf' }).returning({ id: runs.id });
      const generator: StructuredGenerator = {
        async generate(request) {
          const value = request.schema.parse(output);
          const [row] = await db.insert(llmCalls).values({ runId: run!.id, role: request.role, promptVersion: request.promptVersion, model: 'recorded/analyst', provider: 'recorded', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: output as object }).returning({ id: llmCalls.id });
          request.onAudit?.(row?.id ?? '');
          return value;
        },
      };
      const ctx: AnalystContext = { db, gateway: generator, retriever: { async search() { return []; } }, runId: run!.id, frameworkDraftId: draft!.id, snapshotId: snapshot.id, asOf: rec.asOf, security: { id: security!.id, name: rec.company, symbol: rec.symbol, ciks: [], issuerKeys: [rec.issuerKey] } };
      const t = performance.now();
      const outcome = await scoreWithEvidence(ctx, kpi, item.evidence);
      timings.push(performance.now() - t);
      expect(outcome.valid).toBe(true);
    }
    const total = performance.now() - start;
    timings.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: 'score 1,000 recorded results end to end', totalMs: Math.round(total), medianMs: Math.round(timings[500] ?? 0), p95Ms: Math.round(timings[950] ?? 0) })}\n`);
    expect(total).toBeLessThan(30_000);
  }, 120_000);
});
