import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources } from '@open-foresight/core';
import { llmCalls, runs } from '@open-foresight/db';
import { createGateway } from '@open-foresight/llm';
import { listDrafts, runDesigner, type DesignerInput } from './designer.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as { model: string; provider: string; usage: { prompt_tokens: number; completion_tokens: number; cost: number }; choices: Array<{ message: { content: string } }> };
// A real OpenRouter completion recorded by scripts/live.ts.
const corrected = fixture('designer-real-completion.json');

// The gateway caches on the full request, so the brief carries a token unique to this execution. A reused database then never serves an answer cached by an earlier run.
const input: DesignerInput = {
  brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon. Include grid equipment and automation, energy efficiency products, demand response, and the storage and inverter makers that let grids absorb variable renewables, including second order suppliers. Exclude pure electric vehicle makers and pure fossil fuel producers.',
  keywords: ['smart grid', 'battery storage', `run ${randomUUID()}`], seedNames: ['SU.PA', 'ABBN.SW'], exclusions: ['pure EV makers'], regions: ['US', 'EU', 'UK', 'CH'], exposureStyle: 'broad', asOf: '2026-11-20',
  universeSample: [{ symbol: 'SU.PA', name: 'Schneider Electric' }, { symbol: 'ENPH.US', name: 'Enphase Energy' }],
};

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Designer through the real gateway with recorded real completions', () => {
  const sql = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(sql);
  let server: Server;
  let baseURL = '';
  let queue: Array<typeof corrected> = [];
  const requests: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      const parameters = ['structured_outputs', 'tools', 'temperature', 'max_tokens'];
      if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'anthropic/claude-opus-5.5' }] }));
      if (request.url === '/v1/endpoints/zdr') return response.end(JSON.stringify({ data: [{ model_id: 'anthropic/claude-opus-5.5', tag: 'google', supported_parameters: parameters, pricing: { prompt: '0.000005', completion: '0.000025', request: '0' } }] }));
      if (request.url === '/v1/models/anthropic/claude-opus-5.5/endpoints') return response.end(JSON.stringify({ data: { id: 'anthropic/claude-opus-5.5', endpoints: [{ tag: 'google', supported_parameters: parameters }] } }));
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; return response.end('{}'); }
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const next = queue.shift();
      if (!next) { response.statusCode = 500; return response.end(JSON.stringify({ error: { message: 'no recorded completion left' } })); }
      return response.end(JSON.stringify(next));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await sql.end(); });

  const newRun = async () => { const [r] = await db.insert(runs).values({ settings: {}, modelProfile: 'quality' }).returning({ id: runs.id }); if (!r) throw new Error('no run'); return r.id; };
  const makeGateway = () => createGateway({ apiKey: 'fixture-key', models: [{ role: 'designer', model: 'anthropic/claude-opus-5.5' }], db, baseURL });

  it('saves the draft and an audit row that match the recorded real response', async () => {
    queue = [corrected]; requests.length = 0;
    const runId = await newRun();
    const result = await runDesigner({ db, gateway: await makeGateway(), runId, input, availableSources: enabledSources({ eodhd: true }) });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    if (!result.ok) return;
    const [draft] = await listDrafts(db, runId);
    const [call] = await db.select().from(llmCalls).where(eq(llmCalls.id, draft?.llmCallId ?? ''));
    expect(draft).toMatchObject({ valid: true, attempt: 1, model: corrected.model });
    expect(draft?.draft).toEqual(JSON.parse(corrected.choices[0]!.message.content));
    expect(call).toMatchObject({ role: 'designer', provider: corrected.provider, promptVersion: draft?.promptVersion });
    expect(call?.response).toEqual(corrected);
    expect(call?.tokens).toMatchObject({ prompt_tokens: corrected.usage.prompt_tokens, completion_tokens: corrected.usage.completion_tokens });
    expect(Number(call?.cost)).toBeCloseTo(corrected.usage.cost, 8);
    // The request pinned privacy and routing, and asked for strict structured output built from the enabled sources.
    const sent = requests[0] as { provider: Record<string, unknown>; response_format: { json_schema: { name: string; strict: boolean } }; messages: Array<{ role: string; content: string }> };
    expect(sent.provider).toMatchObject({ order: ['google'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true });
    expect(sent.response_format.json_schema).toMatchObject({ name: 'kpi_framework', strict: true });
    expect(sent.messages[0]?.content).toContain('Designer for Open Foresight');
    expect(sent.messages[1]?.content).toContain('Smart energy:');
    expect(result.framework.kpis.reduce((s, k) => s + k.weightPercent, 0)).toBe(100);
    expect(result.framework.kpis.filter(k => k.isGate).length).toBeLessThanOrEqual(1);
  });

  it('serves a second run with the same brief from the gateway cache, and records it', async () => {
    queue = [corrected]; requests.length = 0;
    const gateway = await makeGateway();
    const cached = { ...input, keywords: [...(input.keywords ?? []), 'cache case'] };
    const first = await runDesigner({ db, gateway, runId: await newRun(), input: cached, availableSources: enabledSources({ eodhd: true }) });
    const before = requests.length;
    queue = [];
    const secondRun = await newRun();
    const second = await runDesigner({ db, gateway, runId: secondRun, input: cached, availableSources: enabledSources({ eodhd: true }) });
    expect(first.ok && second.ok).toBe(true);
    expect(requests.length).toBe(before);
    const [audit] = await db.select().from(llmCalls).where(eq(llmCalls.runId, secondRun));
    expect(audit?.params).toMatchObject({ cacheHit: true });
  });
});
