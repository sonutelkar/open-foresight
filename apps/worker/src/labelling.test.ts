import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { DocKind, Kpi, Level } from '@open-foresight/core';
import { documentChunks, kpiScores, llmCalls } from '@open-foresight/db';
import type { EvidenceSearcher, StructuredGenerator } from '@open-foresight/agents';
import { summarizeLabelled } from '@open-foresight/evals';
import { loadPrompt, render } from '@open-foresight/prompts';
import { analystCheck, labellerUser, labelTask, loadPool, loadTasks, samplePool, selectPool, type LabelTask, type StoredScore } from './labelling.js';
import { drive } from './stages.js';
import { approve, createRun, fakeDesigner, framework, freshDatabase, seedWorld } from './test-world.js';

const prompt = loadPrompt('labeller-judgement', 'v1');
const kpi = framework.kpis.find(k => k.id === 'storage_commitment') as Extract<Kpi, { method: 'judgement' }>;
const RUN_A = '00000000-0000-4000-8000-00000000000a', RUN_B = '00000000-0000-4000-8000-00000000000b';
const ref = { id: 'e1', chunkId: 'c1', docKind: 'sec_filing' as DocKind, section: 'ITEM 1. BUSINESS', availableOn: '2026-03-02' };
let serial = 0;
const stored = (over: Partial<StoredScore> = {}): StoredScore => ({
  id: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`, runId: RUN_A, securityId: 'sec-1', symbol: 'ALPH.US', kpiId: 'storage_commitment',
  method: 'judgement', level: '2', valid: true, attempt: 1, promptVersion: 'analyst-judgement@v1:490df005e8b0', llmCallId: null, asOf: '2026-11-20', evidence: [ref], ...over,
});

describe('selectPool', () => {
  it('keeps the latest valid Analyst judgement per run, security and KPI, with a known level and passages', () => {
    const kept = stored({ securityId: 'a', attempt: 2, level: '3' });
    const otherRun = stored({ securityId: 'a', attempt: 1, level: '1', runId: RUN_B });
    const pool = selectPool([
      stored({ securityId: 'a', attempt: 1, level: 'unknown', valid: false }), kept, otherRun,
      stored({ securityId: 'b', attempt: 1, level: '2' }), stored({ securityId: 'b', attempt: 2, level: 'unknown' }),
      stored({ securityId: 'c', level: '4', method: 'extract_then_quant' }),
      stored({ securityId: 'd', level: '2', evidence: [] }),
      stored({ securityId: 'e', level: '0', promptVersion: 'jev-exposure@v1' }),
      stored({ securityId: 'f', level: '3', valid: false }),
    ]);
    expect(pool.map(p => p.id).sort()).toEqual([kept.id, otherRun.id].sort());
  });
});

describe('samplePool', () => {
  const counts: Record<Level, number> = { 0: 2, 1: 60, 2: 30, 3: 6, 4: 1 };
  const pool = selectPool(Object.entries(counts).flatMap(([level, n]) => Array.from({ length: n }, (_, i) => stored({ securityId: `s${level}-${i}`, level: level as Level }))));
  const levels = (sample: { level: Level }[]) => Object.fromEntries((['0', '1', '2', '3', '4'] as const).map(l => [l, sample.filter(s => s.level === l).length]));

  it('takes the whole pool when it is not larger than the count', () => {
    expect(samplePool(pool, 99, 1)).toHaveLength(99);
    expect(samplePool(pool, 500, 1).map(p => p.id).sort()).toEqual(pool.map(p => p.id).sort());
  });

  it('gives every level one pair, then the rest in proportion to what each level has left', () => {
    // 15 left after one each, over 1, 59, 29, 5 and 0 spare: 0.16, 9.41, 4.63, 0.80, 0. Floors give 13 and the two largest remainders, levels 3 and 2, get one more.
    const sample = samplePool(pool, 20, 7);
    expect(sample).toHaveLength(20);
    expect(new Set(sample.map(s => s.id)).size).toBe(20);
    expect(levels(sample)).toEqual({ 0: 1, 1: 10, 2: 6, 3: 2, 4: 1 });
  });

  it('is the same sample for the same seed whatever the pool order, and another for another seed', () => {
    const ids = (seed: number, from = pool) => samplePool(from, 20, seed).map(s => s.id);
    expect(ids(7, [...pool].reverse())).toEqual(ids(7));
    expect(ids(8)).not.toEqual(ids(7));
  });
});

const passages = [
  { ...ref, text: 'We signed a 200 MWh battery storage contract with a utility.' },
  { id: 'e2', chunkId: 'c2', docKind: 'web_report' as DocKind, section: 'Annual report', availableOn: '2026-04-01', text: 'Storage is a growing market.' },
];
const task: LabelTask = { score: { ...stored({ level: '2' }), level: '2' }, company: 'Alpha Energy Inc', kpi, passages, analystUser: null, analystModel: null };
/** The Analyst's message for the same pair, built from its own prompt file and its passage layout written out by hand. */
const analystMessage = (passageText: string) => render(loadPrompt('analyst-judgement', 'v1').user, {
  company: 'Alpha Energy Inc', symbol: 'ALPH.US', as_of: '2026-11-20', kpi_name: kpi.name, definition: kpi.definition,
  rubric: (['0', '1', '2', '3', '4'] as const).map(l => `${l}: ${kpi.rubric.levels[l]}`).join('\n'), unknown_rule: kpi.rubric.unknown,
  passages: `[e1] SEC filing available 2026-03-02 | ITEM 1. BUSINESS\n${passageText}\n\n---\n\n[e2] Company report available 2026-04-01 | Annual report\nStorage is a growing market.`,
});

describe('the labeller prompt', () => {
  it('shows the KPI, the full rubric and the passages in the Analyst layout', () => {
    const user = labellerUser(prompt, task);
    expect(user).toContain('Company: Alpha Energy Inc (ALPH.US)\nAs-of date: 2026-11-20');
    for (const l of ['0', '1', '2', '3', '4'] as const) expect(user).toContain(`${l}: ${kpi.rubric.levels[l]}`);
    expect(user).toContain(`Unknown rule: ${kpi.rubric.unknown}`);
    expect(user).toContain('[e1] SEC filing available 2026-03-02 | ITEM 1. BUSINESS\nWe signed a 200 MWh battery storage contract with a utility.\n\n---\n\n[e2] Company report available 2026-04-01 | Annual report\nStorage is a growing market.');
  });

  it('matches the Analyst message for the same pair, and notices when a passage differs', () => {
    const user = labellerUser(prompt, task);
    expect(analystCheck(user, analystMessage('We signed a 200 MWh battery storage contract with a utility.'))).toBe('same');
    expect(analystCheck(user, `${analystMessage('We signed a 200 MWh battery storage contract with a utility.')}\n\nYour previous answer was rejected.`)).toBe('same');
    expect(analystCheck(user, analystMessage('We signed a 300 MWh battery storage contract with a utility.'))).toBe('different');
    expect(analystCheck(user, null)).toBe('not_recorded');
  });
});

/** A gateway that answers from recorded outputs and writes an audit row with the messages, like the real one. */
function recordingGateway(db: PostgresJsDatabase | null, answer: (request: Parameters<StructuredGenerator['generate']>[0]) => unknown) {
  const requests: Parameters<StructuredGenerator['generate']>[0][] = [];
  const generator: StructuredGenerator = {
    async generate(request) {
      requests.push(request);
      const raw = answer(request);
      const value = request.schema.parse(raw);
      if (db) {
        const [row] = await db.insert(llmCalls).values({ runId: request.runId, role: request.role, promptVersion: request.promptVersion, model: `stub/${request.role}`, provider: 'stub', params: { messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] }, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw as object }).returning({ id: llmCalls.id });
        request.onAudit?.(row!.id);
      }
      return value;
    },
  };
  return { generator, requests };
}

describe('labelTask', () => {
  it('asks the labeller role for a label, audited under the given run, and pairs it with the Analyst level', async () => {
    const { generator, requests } = recordingGateway(null, () => ({ level: '3', rationale: 'e1 reports a 200 MWh storage contract, which is committed capital.' }));
    const pair = await labelTask(generator, prompt, task, RUN_B);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ runId: RUN_B, role: 'labeller', promptVersion: prompt.promptVersion, system: prompt.system, schemaName: 'kpi_label', inputEvidenceIds: ['c1', 'c2'] });
    expect(pair).toEqual({ id: task.score.id, runId: RUN_A, symbol: 'ALPH.US', kpiId: 'storage_commitment', method: 'judgement', analystLevel: '2', labelLevel: '3', labelRationale: 'e1 reports a 200 MWh storage contract, which is committed capital.', chunkIds: ['c1', 'c2'] });
  });

  it('rejects an answer outside the level schema', async () => {
    const { generator } = recordingGateway(null, () => ({ level: '5', rationale: 'Too high.' }));
    await expect(labelTask(generator, prompt, task, RUN_B)).rejects.toThrow();
  });
});

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('labelling a real Analyst run on Postgres', () => {
  let world: Awaited<ReturnType<typeof freshDatabase>>;
  let db: PostgresJsDatabase;
  beforeAll(async () => { world = await freshDatabase(); db = world.db; });
  afterAll(async () => { await world.close(); });

  it('reloads what the Analyst saw, byte for byte, and never shows its level or rationale', async () => {
    const securities = await seedWorld(db);
    const issuerOf = new Map([...securities.values()].map(s => [s.id, s.issuerKey]));
    const quote = 'We signed a 200 MWh battery storage contract with a utility';
    for (const { issuerKey } of securities.values()) {
      await db.insert(documentChunks).values([
        { docKind: 'sec_filing', docId: randomUUID(), issuerKey, availableOn: '2026-03-02', section: 'ITEM 1. BUSINESS', ordinal: 0, startOffset: 0, endOffset: 64, text: `${quote} for grid balancing and battery capacity.`, embedding: new Array(1536).fill(0) as number[], indexVersion: 'v-test' },
        { docKind: 'web_report', docId: randomUUID(), issuerKey, availableOn: '2026-04-01', section: 'Annual report', ordinal: 1, startOffset: 0, endOffset: 28, text: 'Storage is a growing market.', embedding: new Array(1536).fill(0) as number[], indexVersion: 'v-test' },
      ]);
    }
    const retriever: EvidenceSearcher = {
      async search(input) {
        const rows = await db.select().from(documentChunks).where(eq(documentChunks.issuerKey, issuerOf.get(input.securityId) ?? 'none')).orderBy(documentChunks.ordinal);
        return rows.map(r => ({ chunkId: r.id, docKind: r.docKind as DocKind, docId: r.docId, issuerKey: r.issuerKey, section: r.section, startOffset: r.startOffset, endOffset: r.endOffset, text: r.text, availableOn: r.availableOn }));
      },
    };
    const levels: Record<string, string> = { 'Alpha Energy Inc': '2', 'Beta Grid Corp': '1', 'Gamma Oil Co': 'unknown', 'Delta Electrique SA': '2' };
    const gateway = recordingGateway(db, r => {
      if (r.role === 'labeller') return { level: '2', rationale: 'e1 names a storage contract with a figure.' };
      const level = Object.entries(levels).find(([name]) => r.user.includes(name))?.[1] ?? 'unknown';
      const common = { citations: [{ evidenceId: 'e1', quote }], rationale: 'ANALYST RATIONALE MARKER', conflicts: [] };
      return r.schemaName === 'kpi_score_extraction' ? { extractedValue: 0.3, ...common } : { level, ...common };
    });
    const deps = { db, design: fakeDesigner(db).design, gateway: gateway.generator, retriever, availableSources: ['sec_filings', 'esef_filings', 'sec_facts', 'prices', 'market_cap'] as const, scoreConcurrency: 2 };
    const runId = await createRun(db);
    expect(await drive({ ...deps, availableSources: [...deps.availableSources] }, runId)).toBe('awaiting_kpi_approval');
    await approve(db, runId);
    expect(await drive({ ...deps, availableSources: [...deps.availableSources] }, runId)).toBe('done');

    const pool = await loadPool(db, [runId]);
    const judged = await db.select().from(kpiScores).where(and(eq(kpiScores.runId, runId), eq(kpiScores.method, 'judgement'), eq(kpiScores.valid, true)));
    // Two judgement KPIs for the three names with a known level. Gamma said unknown, so it is not in the pool.
    expect(pool).toHaveLength(6);
    expect(pool.every(p => p.symbol !== 'GAMM.US')).toBe(true);
    expect(judged.filter(j => j.level !== 'unknown')).toHaveLength(6);

    const tasks = await loadTasks(db, pool);
    for (const t of tasks) {
      expect(t.passages.map(p => p.text)).toEqual([`${quote} for grid balancing and battery capacity.`, 'Storage is a growing market.']);
      expect(analystCheck(labellerUser(prompt, t), t.analystUser)).toBe('same');
      expect(t.analystModel).toBe('stub/analyst');
    }
    const pairs = [];
    for (const t of tasks) pairs.push(await labelTask(gateway.generator, prompt, t, runId));
    const sent = gateway.requests.filter(r => r.role === 'labeller');
    expect(sent).toHaveLength(6);
    for (const r of sent) expect(`${r.system}\n${r.user}`).not.toContain('ANALYST RATIONALE MARKER');
    const audited = await db.select().from(llmCalls).where(and(eq(llmCalls.runId, runId), eq(llmCalls.role, 'labeller')));
    expect(audited).toHaveLength(6);
    expect(new Set(pairs.map(p => p.analystLevel))).toEqual(new Set(pool.map(p => p.level)));
    const summary = summarizeLabelled({ schemaVersion: 1, source: 'ai', provisional: true, labeller: { model: 'stub/labeller', provider: 'stub', promptVersion: prompt.promptVersion }, analyst: { model: 'stub/analyst' }, runIds: [runId], createdAt: new Date().toISOString(), sample: { requested: 200, pool: 6, seed: 1 }, note: 'N is 6.', pairs });
    expect(summary.n).toBe(6);
  });
});
