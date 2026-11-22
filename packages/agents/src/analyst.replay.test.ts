import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ZodTypeAny } from 'zod';
import { validateScore, type EvidenceItem, type Framework, type Kpi } from '@open-foresight/core';
import { createSnapshot, kpiFrameworkDrafts, kpiScores, llmCalls, runs, securities } from '@open-foresight/db';
import { scoreWithEvidence, type AnalystContext } from './analyst.js';
import type { StructuredGenerator } from './designer.js';

type Recorded = { asOf: string; company: string; symbol: string; issuerKey: string; framework: Framework; items: Array<{ kpiId: string; evidence: EvidenceItem[]; attempts: Array<{ output: unknown; valid: boolean; errorCodes: string[] }> }> };
const path = new URL('../fixtures/analyst-real-scores.json', import.meta.url);
const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Recorded : undefined;

const url = process.env.TEST_DATABASE_URL;
const integration = url && recorded ? describe : describe.skip;

integration('Analyst replay of real recorded evidence and model outputs', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const rec = recorded as Recorded;

  async function setup() {
    const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning({ id: runs.id });
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-replay-${randomUUID()}`, name: rec.company }).returning({ id: securities.id });
    const [call] = await db.insert(llmCalls).values({ runId: run!.id, role: 'designer', promptVersion: 'x', model: 'recorded', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id });
    const [draft] = await db.insert(kpiFrameworkDrafts).values({ runId: run!.id, attempt: 1, promptVersion: 'x', model: 'recorded', llmCallId: call!.id, draft: {}, errors: [], valid: true, framework: rec.framework }).returning({ id: kpiFrameworkDrafts.id });
    const snapshot = await createSnapshot({ db });
    return { runId: run!.id, securityId: security!.id, draftId: draft!.id, snapshotId: snapshot.id };
  }
  const replayGateway = (runId: string, outputs: unknown[]) => {
    const seen: string[] = [];
    const generator: StructuredGenerator = {
      async generate(request) {
        const raw = outputs[seen.length];
        seen.push(request.user);
        const value = (request.schema as ZodTypeAny).parse(raw);
        const [row] = await db.insert(llmCalls).values({ runId, role: request.role, promptVersion: request.promptVersion, model: 'recorded/analyst', provider: 'recorded', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw as object }).returning({ id: llmCalls.id });
        request.onAudit?.(row?.id ?? '');
        return value;
      },
    };
    return { seen, generator };
  };

  it('scores each recorded KPI the way the real model did, with the same validation outcome', async () => {
    const s = await setup();
    let verbatimQuotes = 0;
    for (const item of rec.items) {
      const kpi = rec.framework.kpis.find(k => k.id === item.kpiId) as Exclude<Kpi, { method: 'quant' }>;
      const g = replayGateway(s.runId, item.attempts.map(a => a.output));
      const ctx: AnalystContext = {
        db, gateway: g.generator, retriever: { async search() { return []; } }, runId: s.runId, frameworkDraftId: s.draftId, snapshotId: s.snapshotId, asOf: rec.asOf,
        security: { id: s.securityId, name: rec.company, symbol: rec.symbol, ciks: [], issuerKeys: [rec.issuerKey] },
      };
      const outcome = await scoreWithEvidence(ctx, kpi, item.evidence);
      const last = item.attempts.at(-1);
      expect(outcome.valid, item.kpiId).toBe(last?.valid);
      expect(outcome.attempts, item.kpiId).toBe(item.attempts.length);
      expect(g.seen, item.kpiId).toHaveLength(item.attempts.length);
      const rows = (await db.select().from(kpiScores).where(eq(kpiScores.runId, s.runId))).filter(r => r.kpiId === item.kpiId).sort((a, b) => a.attempt - b.attempt);
      expect(rows.map(r => r.valid), item.kpiId).toEqual(item.attempts.map(a => a.valid));
      rows.forEach((r, i) => expect((r.errors as Array<{ code: string }>).map(e => e.code), item.kpiId).toEqual(item.attempts[i]?.errorCodes));
      if (item.attempts.length > 1) expect(g.seen[1], item.kpiId).toContain('Your previous answer was rejected');
      for (const c of outcome.citations) {
        const source = item.evidence.find(e => e.id === c.evidenceId);
        expect(source?.text.replace(/\s+/g, ' ')).toContain(c.quote);
        verbatimQuotes++;
      }
      if (outcome.valid && kpi.method === 'extract_then_quant' && outcome.extractedValue !== null) expect(Number.isFinite(outcome.extractedValue)).toBe(true);
    }
    expect(verbatimQuotes).toBeGreaterThan(0);
  });

  it('re-validates every recorded accepted output, and rejects the same output against another security or a later as-of date', async () => {
    for (const item of rec.items) {
      const kpi = rec.framework.kpis.find(k => k.id === item.kpiId) as Exclude<Kpi, { method: 'quant' }>;
      const accepted = item.attempts.find(a => a.valid);
      if (!accepted) continue;
      expect(validateScore({ kpi, output: accepted.output, evidence: item.evidence, asOf: rec.asOf, allowedIssuerKeys: [rec.issuerKey] }).ok, item.kpiId).toBe(true);
      const cited = (accepted.output as { citations: unknown[] }).citations.length;
      if (cited > 0) {
        const wrong = validateScore({ kpi, output: accepted.output, evidence: item.evidence, asOf: rec.asOf, allowedIssuerKeys: ['cik:0000000000'] });
        expect(wrong.ok, item.kpiId).toBe(false);
        const early = validateScore({ kpi, output: accepted.output, evidence: item.evidence, asOf: '2000-01-01', allowedIssuerKeys: [rec.issuerKey] });
        expect(early.ok, item.kpiId).toBe(false);
      }
    }
  });
});
