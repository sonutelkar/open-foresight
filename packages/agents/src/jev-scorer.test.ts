import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceItem, Framework, Kpi } from '@open-foresight/core';
import { createGateway } from '@open-foresight/llm';
import { scoreWithJev, type ScoreJudge } from './jev-scorer.js';

/** Real Enphase passages and the real framework from the PR 13 live run. */
const real = JSON.parse(readFileSync(new URL('../fixtures/analyst-real-scores.json', import.meta.url), 'utf8')) as { asOf: string; company: string; framework: Framework; items: Array<{ kpiId: string; evidence: EvidenceItem[] }> };
const item = real.items.find(i => i.kpiId === 'storage_inverter_offering')!;
const kpi = real.framework.kpis.find(k => k.id === item.kpiId) as Extract<Kpi, { method: 'judgement' }>;
/** The real Score and Noul answers recorded from Jev in PR 05b, under this scorer's question names. */
const recorded = (name: string) => JSON.parse(readFileSync(new URL(`../../llm/fixtures/jev/${name}.json`, import.meta.url), 'utf8')).response;
const score = recorded('score'), noul = recorded('noul');
const recordedResponse = { ...score, answers: { level: score.answers.score, known: noul.answers.noul } };
const RUN = '00000000-0000-4000-8000-000000000013';
const input = (passages = item.evidence) => ({ runId: RUN, company: real.company, asOf: real.asOf, kpi, passages });

/** A judge that answers every call with the given level probabilities, Jev confidence and known probability. */
function judge(probabilities: Record<string, number>, known: number, confidence = 0.5) {
  const calls: Parameters<ScoreJudge['decide']>[0][] = [];
  const j: ScoreJudge = {
    async decide(request) {
      calls.push(request);
      return { id: `d${calls.length}`, answers: { level: { type: 'score', score: 0, legend: {}, probabilities, confidence }, known: { type: 'noul', noul: known } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0.0004 } };
    },
  };
  return { j, calls };
}

describe('scoreWithJev through the real gateway', () => {
  it('sends the rubric and the real passages to the pinned provider, audits the call and reads the recorded answer as level 4', async () => {
    const bodies: Array<Record<string, any>> = [];
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test/model' }] }));
      if (req.url === '/v1/endpoints/zdr') return res.end(JSON.stringify({ data: [{ model_id: 'test/model', tag: 'provider', supported_parameters: ['structured_outputs', 'tools'], pricing: { prompt: '0', completion: '0' } }, { model_id: 'typesafe/jev-1.14', tag: 'typesafe', supported_parameters: [] }] }));
      if (req.url === '/v1/models/test/model/endpoints') return res.end(JSON.stringify({ data: { id: 'test/model', endpoints: [{ tag: 'provider', supported_parameters: ['structured_outputs', 'tools'] }] } }));
      let body = ''; for await (const part of req) body += part;
      bodies.push(JSON.parse(body));
      return res.end(JSON.stringify(recordedResponse));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const values = vi.fn((_row: Record<string, unknown>) => ({ returning: async () => [{ id: 'audit' }] }));
    const db = { insert: vi.fn(() => ({ values })) } as unknown as PostgresJsDatabase;
    try {
      const gateway = await createGateway({ apiKey: 'fixture', models: [{ role: 'analyst', model: 'test/model' }], db, baseURL: `http://127.0.0.1:${address.port}/v1` });
      const r = await scoreWithJev(gateway, input());
      expect(r).toMatchObject({ level: '4', reason: 'level', weighted: 4, confidence: 1, version: 'jev-kpi-score@v1' });
      expect(r.answer).toMatchObject({ decisionId: score.id, score: 4, known: 0.98, costUsd: score.usage.cost });
      expect(bodies).toHaveLength(1);
      const sent = bodies[0]!;
      expect(sent.model).toBe('typesafe/jev-1.14');
      expect(sent.provider).toMatchObject({ order: ['typesafe'], allow_fallbacks: false, zdr: true, data_collection: 'deny' });
      expect(sent.questions.level).toEqual({ type: 'score', instructions: expect.any(String), criteria: ['0', '1', '2', '3', '4'].map(l => kpi.rubric.levels[l as '0']) });
      expect(sent.questions.known.instructions).toContain(kpi.rubric.unknown);
      const state = JSON.parse(sent.state) as { company: string; as_of: string; kpi: string; kpi_definition: string; passages: Record<string, string> };
      expect(state).toMatchObject({ company: 'ENPHASE ENERGY INC', as_of: real.asOf, kpi: kpi.name, kpi_definition: kpi.definition });
      expect(Object.keys(state.passages)).toEqual(item.evidence.map(e => e.id));
      expect(state.passages.e1).toBe(`${item.evidence[0]!.section}\n${item.evidence[0]!.text}`);
      expect(values).toHaveBeenCalledOnce();
      expect(values.mock.calls[0]![0]).toMatchObject({ runId: RUN, role: 'jev-scorer', promptVersion: 'jev-kpi-score@v1', inputEvidenceIds: item.evidence.map(e => e.chunkId), error: null });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
  });
});

describe('scoreWithJev', () => {
  it('makes no call and gives unknown when there are no passages', async () => {
    const { j, calls } = judge({ '4': 1 }, 1);
    expect(await scoreWithJev(j, input([]))).toEqual({ level: 'unknown', reason: 'no_evidence', weighted: null, confidence: 0, version: 'jev-kpi-score@v1', answer: null });
    expect(calls).toHaveLength(0);
  });

  it('reads the unknown rule from the known question, whatever the level answer says', async () => {
    const r = await scoreWithJev(judge({ '0': 0, '1': 0, '2': 0, '3': 1, '4': 0 }, 0.1).j, input());
    expect(r).toMatchObject({ level: 'unknown', reason: 'unknown_rule', weighted: 3 });
    expect(r.answer).toMatchObject({ known: 0.1, costUsd: 0.0004 });
  });

  it("keeps Jev's own confidence on the record but takes the level and its confidence from the probabilities", async () => {
    const spread = await scoreWithJev(judge({ '0': 0, '1': 0.3, '2': 0.4, '3': 0.3, '4': 0 }, 0.9, 0.97).j, input());
    expect(spread).toMatchObject({ level: '2', reason: 'level', confidence: 0.4 });
    expect(spread.answer?.confidence).toBe(0.97);
    const split = await scoreWithJev(judge({ '0': 0.5, '1': 0, '2': 0, '3': 0, '4': 0.5 }, 0.9, 0.97).j, input());
    expect(split).toMatchObject({ level: 'unknown', reason: 'split', confidence: 0 });
  });

  it('throws when the call fails or an answer is missing, so a bake-off counts it as a failure and not a level', async () => {
    await expect(scoreWithJev({ async decide() { throw new Error('Decision call failed: 503'); } }, input())).rejects.toThrow('503');
    await expect(scoreWithJev({ async decide() { return { id: 'd', answers: { level: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }; } }, input())).rejects.toThrow('did not answer');
  });
});
