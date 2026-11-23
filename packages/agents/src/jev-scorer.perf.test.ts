import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { expect, it } from 'vitest';
import type { EvidenceItem, Framework, Kpi } from '@open-foresight/core';
import { createGateway } from '@open-foresight/llm';
import { scoreWithJev } from './jev-scorer.js';

const real = JSON.parse(readFileSync(new URL('../fixtures/analyst-real-scores.json', import.meta.url), 'utf8')) as { asOf: string; company: string; framework: Framework; items: Array<{ kpiId: string; evidence: EvidenceItem[] }> };
const judged = real.items.flatMap(item => { const kpi = real.framework.kpis.find(k => k.id === item.kpiId); return kpi?.method === 'judgement' ? [{ kpi, evidence: item.evidence }] : []; });
/** 100 cases: the real judgement KPIs and their 10 real passages each, in turn. Case i answers mostly level i mod 5, and every tenth case fails the unknown rule. */
const cases = Array.from({ length: 100 }, (_, i) => ({ ...judged[i % judged.length]!, peak: i % 5, known: i % 10 === 9 ? 0.2 : 0.9 }));

it('scores 100 fixture cases through the gateway inside the 30 second ceiling', async () => {
  let served = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test/model' }] }));
    if (req.url === '/v1/endpoints/zdr') return res.end(JSON.stringify({ data: [{ model_id: 'test/model', tag: 'provider', supported_parameters: ['structured_outputs', 'tools'], pricing: { prompt: '0', completion: '0' } }, { model_id: 'typesafe/jev-1.14', tag: 'typesafe', supported_parameters: [] }] }));
    if (req.url === '/v1/models/test/model/endpoints') return res.end(JSON.stringify({ data: { id: 'test/model', endpoints: [{ tag: 'provider', supported_parameters: ['structured_outputs', 'tools'] }] } }));
    let body = ''; for await (const part of req) body += part;
    const c = cases[served++ % cases.length]!;
    const probabilities = Object.fromEntries(['0', '1', '2', '3', '4'].map((l, i) => [l, i === c.peak ? 0.8 : Math.abs(i - c.peak) === 1 ? 0.1 : 0]));
    return res.end(JSON.stringify({ id: `dec-${served}`, model: 'typesafe/jev-1.14-20261014', provider: 'TypeSafe', answers: { level: { type: 'score', score: c.peak, legend: {}, probabilities, confidence: 0.8 }, known: { type: 'noul', noul: c.known } }, usage: { input_tokens: 3000, output_tokens: 20, cost: 0.0004 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  let audits = 0;
  const db = { insert: () => ({ values: () => ({ returning: async () => [{ id: `audit-${++audits}` }] }) }) } as unknown as PostgresJsDatabase;
  try {
    const gateway = await createGateway({ apiKey: 'fixture', models: [{ role: 'analyst', model: 'test/model' }], db, baseURL: `http://127.0.0.1:${address.port}/v1` });
    const pass = async () => {
      const out = [];
      for (const c of cases) out.push(await scoreWithJev(gateway, { runId: '00000000-0000-4000-8000-000000000013', company: real.company, asOf: real.asOf, kpi: c.kpi as Extract<Kpi, { method: 'judgement' }>, passages: c.evidence }));
      return out;
    };
    await pass();
    const times: number[] = [];
    let levels: Record<string, number> = {};
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const out = await pass();
      times.push(performance.now() - start);
      levels = out.reduce<Record<string, number>>((m, r) => ({ ...m, [r.level]: (m[r.level] ?? 0) + 1 }), {});
    }
    times.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: 'score 100 fixture cases with Jev through the gateway', medianMs: Math.round(times[1]!), runsMs: times.map(t => Math.round(t)), served, audits, levels })}\n`);
    // Every case reached the server and was audited, and the levels are what the answers say. Each level peaks in 20 cases,
    // and the 10 cases that fail the unknown rule (i mod 10 = 9) all peak at level 4, so level 4 keeps 10.
    expect(served).toBe(400);
    expect(audits).toBe(400);
    expect(levels).toEqual({ '0': 20, '1': 20, '2': 20, '3': 20, '4': 10, unknown: 10 });
    expect(times[1]!).toBeLessThan(30_000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}, 120_000);
