import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ZodTypeAny } from 'zod';
import { enabledSources, type FrameworkDraft } from '@open-foresight/core';
import { kpiFrameworkDrafts, llmCalls, runs } from '@open-foresight/db';
import { designerInputSchema, listDrafts, runDesigner, type DesignerInput, type StructuredGenerator } from './designer.js';

const golden = JSON.parse(readFileSync(new URL('../../core/fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const clone = () => structuredClone(golden);
const input: DesignerInput = {
  brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon, including grid equipment, efficiency products and storage, with second order suppliers.',
  keywords: ['smart grid'], seedNames: ['SU.PA'], exclusions: ['pure EV makers'], regions: ['US', 'EU'], exposureStyle: 'broad', asOf: '2026-11-20',
  universeSample: [{ symbol: 'SU.PA', name: 'Schneider Electric', sector: 'Industrials' }, { symbol: 'ENPH.US', name: 'Enphase Energy' }],
};
const sources = enabledSources({ eodhd: true });

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Designer on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const newRun = async () => { const [r] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning({ id: runs.id }); if (!r) throw new Error('no run'); return r.id; };

  /** Stands in for the gateway. Like the real one it parses against the schema and writes and reports an llm_calls row. */
  function stub(runResponses: unknown[]) {
    const calls: Array<{ system: string; user: string; promptVersion: string; schema: ZodTypeAny; inputEvidenceIds: string[] }> = [];
    const generator: StructuredGenerator = {
      async generate(request) {
        const raw = runResponses[calls.length];
        calls.push({ system: request.system, user: request.user, promptVersion: request.promptVersion, schema: request.schema, inputEvidenceIds: request.inputEvidenceIds });
        const value = request.schema.parse(raw);
        const [row] = await db.insert(llmCalls).values({ runId: request.runId, role: request.role, promptVersion: request.promptVersion, model: 'stub/designer', provider: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw as object }).returning({ id: llmCalls.id });
        request.onAudit?.(row?.id ?? '');
        return value;
      },
    };
    return { calls, generator };
  }

  it('saves a valid first draft with its prompt version and audit row', async () => {
    const runId = await newRun();
    const s = stub([golden]);
    const result = await runDesigner({ db, gateway: s.generator, runId, input, availableSources: sources });
    expect(result).toMatchObject({ ok: true, attempts: 1, reused: false });
    if (!result.ok) return;
    expect(result.framework.kpis).toHaveLength(5);
    const [draft] = await listDrafts(db, runId);
    expect(draft).toMatchObject({ attempt: 1, valid: true, model: 'stub/designer', errors: [] });
    expect(draft?.promptVersion).toMatch(/^designer@v3:[0-9a-f]{12}$/);
    expect(draft?.framework).toEqual(result.framework);
    expect(draft?.draft).toEqual(golden);
    const [call] = await db.select().from(llmCalls).where(eq(llmCalls.id, draft?.llmCallId ?? ''));
    expect(call?.promptVersion).toBe(draft?.promptVersion);
    expect(call?.role).toBe('designer');
    expect(call?.inputEvidenceIds).toEqual(['universe:SU.PA', 'universe:ENPH.US']);
  });

  it('fills the prompt from the brief and lists only enabled sources and quant functions', async () => {
    const withPrices = stub([golden]);
    await runDesigner({ db, gateway: withPrices.generator, runId: await newRun(), input, availableSources: sources });
    const first = withPrices.calls[0];
    expect(first?.user).toContain('Theme brief:\nSmart energy:');
    expect(first?.user).toContain('Regions: US, EU');
    expect(first?.user).toContain('- SU.PA | Schneider Electric | Industrials');
    expect(first?.user).not.toMatch(/\{\{/);
    expect(first?.system).toContain('- prices:');
    expect(first?.system).toContain('adv_usd_20d');

    const withoutPrices = stub([golden]);
    await runDesigner({ db, gateway: withoutPrices.generator, runId: await newRun(), input, availableSources: enabledSources({ eodhd: false }) });
    const second = withoutPrices.calls[0];
    expect(second?.system).not.toContain('- prices:');
    expect(second?.system).not.toContain('adv_usd_20d');
    expect(second?.system).toContain('rd_intensity');
    expect(() => withoutPrices.calls[0]?.schema.parse({ ...golden, kpis: golden.kpis.map(k => ({ ...k, sources: ['prices'] })) })).toThrow();
  });

  it('repairs an invalid draft once by showing every validation error, and saves both attempts', async () => {
    const bad = clone(); bad.kpis[0]!.weightPercent = 45; bad.kpis[3]!.isGate = true; bad.kpis[2]!.rubric!.level3 = '';
    const runId = await newRun();
    const s = stub([bad, golden]);
    const result = await runDesigner({ db, gateway: s.generator, runId, input, availableSources: sources });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(s.calls[0]?.user).not.toContain('failed validation');
    const repair = s.calls[1]?.user ?? '';
    expect(repair).toContain('failed validation');
    expect(repair).toContain('Weights must sum to 100 percent, got 115');
    expect(repair).toContain('At most one KPI may be a gate, got 2');
    expect(repair).toContain('kpis.2.rubric');
    const drafts = (await listDrafts(db, runId)).reverse();
    expect(drafts.map(d => [d.attempt, d.valid])).toEqual([[1, false], [2, true]]);
    expect(drafts[0]?.framework).toBeNull();
    expect((drafts[0]?.errors as unknown[]).length).toBe(3);
    expect(drafts[0]?.llmCallId).not.toBe(drafts[1]?.llmCallId);
  });

  it('returns the errors after the last attempt and saves no framework', async () => {
    const bad = clone(); bad.kpis[0]!.weightPercent = 10;
    const runId = await newRun();
    const result = await runDesigner({ db, gateway: stub([bad, bad]).generator, runId, input, availableSources: sources });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(2);
    expect(result.errors.map(e => e.code)).toEqual(['weight_total']);
    expect((await listDrafts(db, runId)).every(d => !d.valid && d.framework === null)).toBe(true);
    expect(await runDesigner({ db, gateway: stub([bad]).generator, runId, input, availableSources: sources, maxAttempts: 1 })).toMatchObject({ ok: false, attempts: 3 });
  });

  it('returns an existing valid draft without a model call, and regenerates only when asked', async () => {
    const runId = await newRun();
    const first = stub([golden]);
    await runDesigner({ db, gateway: first.generator, runId, input, availableSources: sources });
    const second = stub([golden]);
    const again = await runDesigner({ db, gateway: second.generator, runId, input, availableSources: sources });
    expect(again).toMatchObject({ ok: true, reused: true, attempts: 1 });
    expect(second.calls).toHaveLength(0);
    const third = stub([golden]);
    expect(await runDesigner({ db, gateway: third.generator, runId, input, availableSources: sources, regenerate: true })).toMatchObject({ ok: true, reused: false, attempts: 2 });
    expect(third.calls).toHaveLength(1);
    expect(await listDrafts(db, runId)).toHaveLength(2);
  });

  it('rejects bad input before any model call', async () => {
    const runId = await newRun();
    const s = stub([golden]);
    const run = (over: Partial<DesignerInput>, extra: { availableSources?: typeof sources; maxAttempts?: number } = {}) =>
      runDesigner({ db, gateway: s.generator, runId, input: { ...input, ...over }, availableSources: extra.availableSources ?? sources, maxAttempts: extra.maxAttempts });
    await expect(run({ brief: 'Too short a brief.' })).rejects.toThrow('20 words');
    await expect(run({ regions: [] })).rejects.toThrow();
    await expect(run({ asOf: '2026-13-40' })).rejects.toThrow();
    await expect(run({}, { availableSources: [] })).rejects.toThrow('No sources');
    await expect(run({}, { maxAttempts: 0 })).rejects.toThrow('maxAttempts');
    await expect(run({ extra: 1 } as unknown as Partial<DesignerInput>)).rejects.toThrow();
    expect(s.calls).toHaveLength(0);
    expect(designerInputSchema.safeParse(input).success).toBe(true);
  });

  it('keeps drafts append-only and ties a valid flag to a framework', async () => {
    const runId = await newRun();
    await runDesigner({ db, gateway: stub([golden]).generator, runId, input, availableSources: sources });
    const [draft] = await listDrafts(db, runId);
    await expect(client.unsafe('DELETE FROM kpi_framework_drafts')).rejects.toThrow('append-only');
    await expect(db.update(kpiFrameworkDrafts).set({ valid: false }).where(eq(kpiFrameworkDrafts.id, draft?.id ?? ''))).rejects.toThrow();
    await expect(db.insert(kpiFrameworkDrafts).values({ runId, attempt: 9, promptVersion: 'x', model: 'm', llmCallId: draft?.llmCallId ?? '', draft: {}, errors: [], valid: true, framework: null })).rejects.toThrow();
    await expect(db.insert(kpiFrameworkDrafts).values({ runId, attempt: 1, promptVersion: 'x', model: 'm', llmCallId: draft?.llmCallId ?? '', draft: {}, errors: [], valid: false, framework: null })).rejects.toThrow();
  });
});
