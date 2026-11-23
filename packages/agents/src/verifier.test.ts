import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources, validateFramework, type FrameworkDraft, type Kpi, type ResolvedCitation } from '@open-foresight/core';
import { documentChunks } from '@open-foresight/db';
import { loadStoredSpans, verifyClaim, type SpanJudge } from './verifier.js';

const golden = JSON.parse(readFileSync(new URL('../../core/fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const checked = validateFramework(golden, { availableSources: enabledSources({ eodhd: true }) });
if (!checked.ok) throw new Error('golden framework must be valid');
const judgeKpi = checked.framework.kpis.find(k => k.method === 'judgement') as Extract<Kpi, { method: 'judgement' }>;
const extractKpi = checked.framework.kpis.find(k => k.method === 'extract_then_quant')!;

const TEXT = 'Our grid products segment generated $3.1 billion of revenue, or 26% of total revenue, in fiscal 2025. We also sell storage systems.';
const QUOTE = 'grid products segment generated $3.1 billion of revenue, or 26% of total revenue';
const zero = JSON.parse(`[${new Array(1536).fill(0).join(',')}]`) as number[];
const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Jev span check on stored spans', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const issuer = `cik:v${Math.floor(Math.random() * 1e9)}`;
  const ctx = (judge: SpanJudge) => ({ db, judge, runId: randomUUID(), asOf: '2026-11-01', security: { name: 'Alpha Energy Inc', issuerKeys: [issuer] } });

  async function chunk(over: Partial<typeof documentChunks.$inferInsert> = {}) {
    const docId = randomUUID();
    const [row] = await db.insert(documentChunks).values({ docKind: 'sec_filing', docId, issuerKey: issuer, availableOn: '2026-05-01', section: 'Item 1. Business', ordinal: 0, startOffset: 0, endOffset: TEXT.length, text: TEXT, embedding: zero, indexVersion: `v-${randomUUID()}`, ...over }).returning();
    return row!;
  }
  const cite = (c: { id: string; docId: string; docKind: string }, quote = QUOTE, evidenceId = 'e1'): ResolvedCitation => ({ evidenceId, quote, chunkId: c.id, docKind: c.docKind as 'sec_filing', docId: c.docId, section: 'Item 1. Business', startOffset: 0, endOffset: 50, availableOn: '2026-05-01' });

  /** A recorded judge: the probability for each rubric claim, by level. It records every request so a test can read what Jev was shown. */
  function judge(byLevel: Partial<Record<'4' | '3' | '2' | '1', number>>, fail = false) {
    const requests: Array<{ state: string; questions: string[]; inputEvidenceIds: string[]; role: string }> = [];
    const j: SpanJudge = {
      async decide(input) {
        requests.push({ state: input.state, questions: Object.keys(input.questions), inputEvidenceIds: input.inputEvidenceIds, role: input.role });
        if (fail) throw new Error('Decision call failed: 503');
        const claim = (JSON.parse(input.state) as { claim: string }).claim;
        const level = (['4', '3', '2', '1'] as const).find(l => judgeKpi.rubric.levels[l] === claim)!;
        return { id: `d${requests.length}`, answers: Object.fromEntries(Object.keys(input.questions).map(q => [q, { type: 'noul' as const, noul: byLevel[level] ?? 0 }])) };
      },
    };
    return { j, requests };
  }

  it('keeps a supported level with one call, and shows Jev the stored text and the rubric claim', async () => {
    const c = await chunk();
    const { j, requests } = judge({ '4': 0.92 });
    const d = await verifyClaim(ctx(j), judgeKpi, '4', [cite(c)]);
    expect(d).toEqual({ level: '4', adjustment: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: 'verifier', questions: ['support_e1'], inputEvidenceIds: [c.id] });
    const state = JSON.parse(requests[0]!.state) as { claim: string; spans: Record<string, string>; company: string };
    expect(state.claim).toBe(judgeKpi.rubric.levels['4']);
    expect(state.spans.e1).toContain(QUOTE);
    expect(state.company).toBe('Alpha Energy Inc');
  });

  it('steps down level by level to the first supported one', async () => {
    const c = await chunk();
    const { j, requests } = judge({ '4': 0.1, '3': 0.2, '2': 0.9 });
    const d = await verifyClaim(ctx(j), judgeKpi, '4', [cite(c)]);
    expect(d.level).toBe('2');
    expect(d.adjustment).toMatchObject({ code: 'jev_unsupported', from: '4', to: '2' });
    expect(requests).toHaveLength(3);
  });

  it('falls to level 1 and never 0 when nothing is supported', async () => {
    const c = await chunk();
    const d = await verifyClaim(ctx(judge({}).j), judgeKpi, '3', [cite(c)]);
    expect(d.level).toBe('1');
  });

  it('keeps a borderline level, records the doubt and makes no further call', async () => {
    const c = await chunk();
    const { j, requests } = judge({ '4': 0.5 });
    const d = await verifyClaim(ctx(j), judgeKpi, '4', [cite(c)]);
    expect(d.level).toBe('4');
    expect(d.adjustment).toMatchObject({ code: 'jev_borderline', from: '4', to: '4' });
    expect(requests).toHaveLength(1);
  });

  it('keeps the level and says the check did not run when the call fails', async () => {
    const c = await chunk();
    const d = await verifyClaim(ctx(judge({}, true).j), judgeKpi, '4', [cite(c)]);
    expect(d.level).toBe('4');
    expect(d.adjustment).toMatchObject({ code: 'jev_unavailable', from: '4', to: '4' });
  });

  it('does not call Jev for levels 0 to 2, unknown, or an extraction KPI', async () => {
    const c = await chunk();
    const { j, requests } = judge({ '4': 0.9 });
    for (const level of ['2', '1', '0', 'unknown'] as const) expect(await verifyClaim(ctx(j), judgeKpi, level, [cite(c)])).toEqual({ level, adjustment: null });
    expect(await verifyClaim(ctx(j), extractKpi, '4', [cite(c)])).toEqual({ level: '4', adjustment: null });
    expect(requests).toHaveLength(0);
  });

  describe('stored span selection', () => {
    it('rejects a nonexistent chunk, an altered span, a wrong company, and future evidence', async () => {
      const ok = await chunk();
      const other = await chunk({ issuerKey: 'cik:somebodyelse' });
      const future = await chunk({ availableOn: '2026-12-01' });
      const wrongDoc = await chunk();
      const { spans, rejected } = await loadStoredSpans(db, [
        cite(ok, QUOTE, 'e1'), cite({ id: randomUUID(), docId: randomUUID(), docKind: 'sec_filing' }, QUOTE, 'e2'), cite(ok, 'grid products segment generated $9.9 billion of revenue', 'e3'),
        cite(other, QUOTE, 'e4'), cite(future, QUOTE, 'e5'), cite({ ...wrongDoc, docId: randomUUID() }, QUOTE, 'e6'),
      ], { asOf: '2026-11-01', issuerKeys: [issuer] });
      expect(spans.map(s => s.evidenceId)).toEqual(['e1']);
      expect(rejected).toEqual([
        { evidenceId: 'e2', reason: 'no_such_chunk' }, { evidenceId: 'e3', reason: 'altered_span' }, { evidenceId: 'e4', reason: 'wrong_company' }, { evidenceId: 'e5', reason: 'future_evidence' }, { evidenceId: 'e6', reason: 'wrong_document' },
      ]);
    });

    it('lowers to level 2 without calling Jev when no cited quote is confirmed in the store', async () => {
      const c = await chunk();
      const { j, requests } = judge({ '4': 0.99 });
      const d = await verifyClaim(ctx(j), judgeKpi, '4', [cite(c, 'a sentence the stored filing never contains')]);
      expect(d.level).toBe('2');
      expect(d.adjustment).toMatchObject({ code: 'span_unverified', from: '4', to: '2' });
      expect(requests).toHaveLength(0);
    });

    it('shows Jev only the confirmed spans and records the rejected ones', async () => {
      const c = await chunk(), bad = await chunk({ issuerKey: 'cik:somebodyelse' });
      const { j, requests } = judge({ '4': 0.1, '3': 0.1, '2': 0.1, '1': 0.1 });
      const d = await verifyClaim(ctx(j), judgeKpi, '4', [cite(c, QUOTE, 'e1'), cite(bad, QUOTE, 'e2')]);
      expect(requests.every(r => r.questions.join() === 'support_e1')).toBe(true);
      expect(d.adjustment?.detail).toMatchObject({ rejected: [{ evidenceId: 'e2', reason: 'wrong_company' }] });
    });
  });
});
