import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { llmCalls, runs, toolCalls } from '@open-foresight/db';
import { createGateway, runAgent } from './index.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('gateway with a real HTTP fixture server and PostgreSQL', () => {
  const sql = postgres(url ?? 'postgres://localhost/unused');
  const db = drizzle(sql);
  const requests: Array<Record<string, unknown>> = [];
  let mode: 'good' | 'repair' | 'bad' | 'transport' | 'agent' = 'good';
  let active = 0;
  let maxActive = 0;
  let attempts = 0;
  let supported = true;
  let zdrEnabled = true;
  let providerTag = 'fixture';
  let pricing: unknown = { prompt: '0.000001', completion: '0.000002', request: '0' };
  let extraProviders: Array<{ tag: string; pricing: unknown; supported_parameters: string[] }> = [];
  let endpointParameters = ['structured_outputs', 'tools', 'temperature', 'max_tokens'];
  let zdrParameters = ['structured_outputs', 'tools', 'temperature', 'max_tokens'];
  let server: Server;
  let baseURL = '';
  let runId = '';
  let brief = '';
  beforeEach(() => { brief = randomUUID(); });
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'test/model' }] }));
      if (request.url === '/v1/endpoints/zdr') return response.end(JSON.stringify({ data: zdrEnabled ? [{ model_id: 'test/model', tag: providerTag, supported_parameters: zdrParameters, pricing }, ...extraProviders.map(item => ({ ...item, model_id: 'test/model' }))] : [] }));
      if (request.url === '/v1/models/test/model/endpoints') return response.end(JSON.stringify({ data: { id: 'test/model', endpoints: [{ tag: providerTag, supported_parameters: supported ? endpointParameters : [] }, ...extraProviders.map(item => ({ tag: item.tag, supported_parameters: item.supported_parameters }))] } }));
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; return response.end('{}'); }
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      attempts++;
      if (mode === 'transport') { response.statusCode = 500; return response.end(JSON.stringify({ error: { message: 'fixture failure' } })); }
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      if (mode === 'agent') {
        const action = attempts === 1 ? { kind: 'tool', name: 'lookup', input: JSON.stringify({ id: 'one' }), value: '' } : { kind: 'final', name: '', input: '', value: JSON.stringify({ answer: 'ok' }) };
        return response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'test/model', provider: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(action) } }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.001 } }));
      }
      const valid = mode === 'good' || (mode === 'repair' && attempts === 2);
      return response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'test/model', provider: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answer: valid ? 'ok' : 123 }) } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, cost: 0.001, prompt_tokens_details: { cached_tokens: 2 } } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    baseURL = `http://127.0.0.1:${address.port}/v1`;
    const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning();
    if (!run) throw new Error('Failed to create run');
    runId = run.id;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await sql.end(); });
  const options = () => ({ apiKey: 'fixture-key', models: [{ role: 'designer', model: 'test/model' }], db, baseURL });
  const input = () => ({ runId, role: 'designer', promptVersion: 'v1', system: 'system', user: brief, schemaName: 'answer', schema: z.object({ answer: z.string() }).strict(), inputEvidenceIds: ['evidence:1'], maxOutputTokens: 32 });

  it('rejects unsupported provider capabilities before any model call', async () => {
    supported = false;
    await expect(createGateway(options())).rejects.toThrow('No eligible ZDR provider');
    supported = true;
  });
  it('rejects unknown models and providers without ZDR', async () => {
    await expect(createGateway({ ...options(), models: [{ role: 'designer', model: 'unknown/model' }] })).rejects.toThrow('Unknown model');
    zdrEnabled = false;
    await expect(createGateway(options())).rejects.toThrow('No eligible ZDR provider');
    zdrEnabled = true;
  });
  it('pins the cheapest valid ZDR provider and keeps the choice after prices change', async () => {
    extraProviders = [
      { tag: 'other', pricing: { prompt: '0.0000001', completion: '0.0000001', request: '0' }, supported_parameters: ['structured_outputs', 'tools', 'max_tokens'] },
      { tag: 'malformed', pricing: { prompt: '', completion: 0, request: 0 }, supported_parameters: ['structured_outputs', 'tools'] },
    ];
    mode = 'good'; attempts = 0;
    const gateway = await createGateway(options());
    extraProviders[0] = { tag: 'other', pricing: { prompt: 10, completion: 10, request: 0 }, supported_parameters: ['structured_outputs', 'tools', 'max_tokens'] };
    await gateway.generate(input());
    expect(requests.at(-1)?.provider).toMatchObject({ order: ['other'], allow_fallbacks: false });
    const records = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId));
    expect(records.at(-1)?.params).toMatchObject({ provider: { order: ['other'] } });
    extraProviders = [];
  });
  it('accepts genuine zero prices, breaks ties by provider tag, and rejects invalid prices', async () => {
    pricing = { prompt: '0', completion: '0', request: '0' };
    extraProviders = [
      { tag: 'a-free', pricing: { prompt: '0', completion: '0', request: '0' }, supported_parameters: ['structured_outputs', 'tools', 'max_tokens'] },
      { tag: 'bad-negative', pricing: { prompt: '-1', completion: 0, request: 0 }, supported_parameters: ['structured_outputs', 'tools'] },
      { tag: 'bad-nan', pricing: { prompt: 'NaN', completion: 0, request: 0 }, supported_parameters: ['structured_outputs', 'tools'] },
      { tag: 'bad-infinity', pricing: { prompt: 'Infinity', completion: 0, request: 0 }, supported_parameters: ['structured_outputs', 'tools'] },
      { tag: 'bad-missing', pricing: { prompt: 0, request: 0 }, supported_parameters: ['structured_outputs', 'tools'] },
      { tag: 'bad-request-negative', pricing: { prompt: 0, completion: 0, request: '-1' }, supported_parameters: ['structured_outputs', 'tools'] },
    ];
    const gateway = await createGateway(options());
    await gateway.generate(input());
    expect(requests.at(-1)?.provider).toMatchObject({ order: ['a-free'] });
    pricing = { prompt: '', completion: 0, request: 0 };
    extraProviders = extraProviders.filter(item => item.tag.startsWith('bad-'));
    await expect(createGateway(options())).rejects.toThrow('No eligible ZDR provider');
    pricing = { prompt: '0.000001', completion: '0.000002', request: '0' };
    extraProviders = [];
  });
  it('treats an omitted request fee as zero for the estimate', async () => {
    extraProviders = [
      { tag: 'missing-request-fee', pricing: { prompt: 0, completion: 0 }, supported_parameters: ['structured_outputs', 'tools', 'max_tokens'] },
    ];
    const gateway = await createGateway(options());
    await gateway.generate(input());
    expect(requests.at(-1)?.provider).toMatchObject({ order: ['missing-request-fee'] });
    extraProviders = [];
  });
  it('includes the per-request charge in the provider cost estimate', async () => {
    extraProviders = [
      { tag: 'cheap-token-high-fee', pricing: { prompt: 0, completion: 0, request: '0.10' }, supported_parameters: ['structured_outputs', 'tools', 'max_tokens'] },
    ];
    const gateway = await createGateway(options());
    await gateway.generate(input());
    expect(requests.at(-1)?.provider).toMatchObject({ order: ['fixture'] });
    extraProviders = [];
  });
  it('breaks mathematically equal decimal estimates by tag', async () => {
    pricing = { prompt: '0.0003', completion: 0, request: 0 };
    extraProviders = [
      { tag: 'a-equal', pricing: { prompt: '0.0001', completion: '0.0002', request: 0 }, supported_parameters: ['structured_outputs', 'tools', 'max_tokens'] },
    ];
    const gateway = await createGateway(options());
    await gateway.generate(input());
    expect(requests.at(-1)?.provider).toMatchObject({ order: ['a-equal'] });
    pricing = { prompt: '0.000001', completion: '0.000002', request: '0' };
    extraProviders = [];
  });
  it('accepts slash-separated provider endpoint tags', async () => {
    providerTag = 'google-vertex/global';
    await expect(createGateway(options())).resolves.toBeDefined();
    providerTag = 'fixture';
  });
  it('omits temperature when the selected ZDR endpoint lacks it and records the omission', async () => {
    zdrParameters = ['structured_outputs', 'tools', 'max_tokens'];
    mode = 'good'; attempts = 0;
    const gateway = await createGateway(options());
    expect(await gateway.generate(input())).toEqual({ answer: 'ok' });
    expect(requests.at(-1)).not.toHaveProperty('temperature');
    const calls = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId));
    expect(calls.at(-1)?.params).not.toHaveProperty('temperature');
    zdrParameters = ['structured_outputs', 'tools', 'temperature', 'max_tokens'];
  });
  it('selects the supported output cap and refuses to silently omit it', async () => {
    zdrParameters = ['structured_outputs', 'tools', 'max_completion_tokens'];
    mode = 'good'; attempts = 0;
    let gateway = await createGateway(options());
    await gateway.generate(input());
    expect(requests.at(-1)?.max_completion_tokens).toBe(32);
    expect(requests.at(-1)).not.toHaveProperty('max_tokens');
    zdrParameters = ['structured_outputs', 'tools'];
    gateway = await createGateway(options());
    attempts = 0;
    await expect(gateway.generate(input())).rejects.toThrow('lacks a supported output token limit');
    expect(attempts).toBe(0);
    zdrParameters = ['structured_outputs', 'tools', 'temperature', 'max_tokens'];
  });
  it('sends pinned privacy settings and persists provider, usage, and output', async () => {
    mode = 'good'; attempts = 0;
    const gateway = await createGateway(options());
    expect(await gateway.generate(input())).toEqual({ answer: 'ok' });
    const request = requests.at(-1);
    expect(request?.max_tokens).toBe(32);
    expect(request?.temperature).toBe(0);
    expect(request?.provider).toEqual({ order: ['fixture'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true });
    expect(request?.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    const records = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId));
    const call = records.at(-1);
    expect(call).toMatchObject({ role: 'designer', promptVersion: 'v1', model: 'test/model', provider: 'fixture', inputEvidenceIds: ['evidence:1'], cachedTokens: 2, cost: '0.001' });
    expect(call?.response).toMatchObject({ model: 'test/model', provider: 'fixture' });
  });
  it('logs invalid output and repairs it once', async () => {
    mode = 'repair'; attempts = 0;
    const gateway = await createGateway(options());
    const before = (await db.select().from(llmCalls).where(eq(llmCalls.runId, runId))).length;
    expect(await gateway.generate(input())).toEqual({ answer: 'ok' });
    expect(attempts).toBe(2);
    const calls = (await db.select().from(llmCalls).where(eq(llmCalls.runId, runId))).slice(before);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.error).toBeTruthy();
    expect(calls[1]?.error).toBeNull();
  });
  it('stops after one repair, and retries transient transport errors once', async () => {
    const gateway = await createGateway(options());
    mode = 'bad'; attempts = 0;
    await expect(gateway.generate(input())).rejects.toThrow('Model call failed');
    expect(attempts).toBe(2);
    mode = 'transport'; attempts = 0;
    await expect(gateway.generate(input())).rejects.toThrow('Model call failed');
    expect(attempts).toBe(2);
    const records = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId));
    expect(records.at(-1)?.error).toBeTruthy();
  });

  it('caches a full request and misses on changed inputs', async () => {
    mode = 'good'; attempts = 0;
    const gateway = await createGateway(options());
    const request = input();
    expect(await gateway.generate(request)).toEqual({ answer: 'ok' });
    expect(await gateway.generate(request)).toEqual({ answer: 'ok' });
    expect(attempts).toBe(1);
    await gateway.generate({ ...request, inputEvidenceIds: ['other'] });
    await gateway.generate({ ...request, promptVersion: 'v2' });
    await gateway.generate({ ...request, user: `${brief}-changed` });
    expect(attempts).toBe(4);
  });

  it('bounds concurrent upstream calls', async () => {
    mode = 'good'; attempts = 0; maxActive = 0;
    const gateway = await createGateway({ ...options(), concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => gateway.generate({ ...input(), user: `${brief}-${i}` })));
    expect(attempts).toBe(6);
    expect(maxActive).toBe(2);
  });
  it('runs and records a tool call through the gateway and enforces limits', async () => {
    mode = 'agent'; attempts = 0;
    const gateway = await createGateway(options());
    const agent = { db, gateway, runId, role: 'designer', promptVersion: 'v1', system: 'system', user: brief, inputEvidenceIds: [],
      tools: [{ name: 'lookup', input: z.object({ id: z.string() }), execute: async ({ id }: { id: string }) => ({ result: id, resultIds: [id] }) }],
      output: z.object({ answer: z.string() }), maxTurns: 2, maxToolCalls: 1, outputTokenBudget: 192, maxOutputTokens: 32 };
    expect(await runAgent(agent)).toEqual({ answer: 'ok' });
    const calls = await db.select().from(toolCalls).innerJoin(llmCalls, eq(toolCalls.llmCallId, llmCalls.id)).where(eq(llmCalls.runId, runId));
    expect(calls.at(-1)?.tool_calls).toMatchObject({ tool: 'lookup', args: { id: 'one' }, resultIds: ['one'] });
    attempts = 0;
    await expect(runAgent({ ...agent, user: `${brief}-tool-limit`, maxToolCalls: 0 })).rejects.toThrow('Tool call limit');
    attempts = 0;
    await expect(runAgent({ ...agent, user: `${brief}-turn-limit`, maxTurns: 1 })).rejects.toThrow('Turn limit');
    attempts = 0;
    await expect(runAgent({ ...agent, user: `${brief}-budget`, outputTokenBudget: 96 })).rejects.toThrow('Budget limit');
    expect(attempts).toBe(1);
  });

  it('deduplicates simultaneous identical requests within one gateway', async () => {
    mode = 'good'; attempts = 0;
    const gateway = await createGateway(options());
    const request = input();
    const results = await Promise.all(Array.from({ length: 6 }, () => gateway.generate(request)));
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ answer: 'ok' })));
    expect(attempts).toBe(1);
  });
  it('measures 100 persistent cache hits', async () => {
    mode = 'good'; attempts = 0;
    const gateway = await createGateway(options());
    const request = input();
    await gateway.generate(request);
    const timings: number[] = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      for (let i = 0; i < 100; i++) expect(await gateway.generate(request)).toEqual({ answer: 'ok' });
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    console.info(`100 cache hits in milliseconds, sorted: ${timings.map(n => n.toFixed(1)).join(', ')}`);
    expect(timings[1]).toBeLessThan(5000);
    expect(attempts).toBe(1);
  });
  it('records a tool execution failure', async () => {
    mode = 'agent'; attempts = 0;
    const gateway = await createGateway(options());
    await expect(runAgent({ db, gateway, runId, role: 'designer', promptVersion: 'v1', system: 'system', user: brief, inputEvidenceIds: [],
      tools: [{ name: 'lookup', input: z.object({ id: z.string() }), execute: async () => { throw new Error('lookup failed'); } }],
      output: z.object({ answer: z.string() }), maxTurns: 2, maxToolCalls: 1, outputTokenBudget: 192, maxOutputTokens: 32 })).rejects.toThrow('lookup failed');
    const calls = await db.select().from(toolCalls).innerJoin(llmCalls, eq(toolCalls.llmCallId, llmCalls.id)).where(eq(llmCalls.runId, runId));
    expect(calls.at(-1)?.tool_calls.error).toEqual({ message: 'lookup failed' });
  });

});
