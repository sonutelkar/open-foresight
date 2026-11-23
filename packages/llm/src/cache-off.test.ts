import { createServer } from 'node:http';
import { once } from 'node:events';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { llmCache, llmCalls } from '@open-foresight/db';
import { createGateway } from './index.js';

it('answers from the cache by default, and with cache off reaches the model and leaves the cache alone', async () => {
  let upstream = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const supported_parameters = ['structured_outputs', 'tools', 'temperature', 'max_tokens'];
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test/model' }] }));
    if (req.url === '/v1/endpoints/zdr') return res.end(JSON.stringify({ data: [{ model_id: 'test/model', tag: 'provider', supported_parameters, pricing: { prompt: '0', completion: '0' } }] }));
    if (req.url === '/v1/models/test/model/endpoints') return res.end(JSON.stringify({ data: { id: 'test/model', endpoints: [{ tag: 'provider', supported_parameters }] } }));
    for await (const _ of req);
    upstream++;
    return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'test/model', provider: 'provider', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answer: 'fresh' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  // A store that already holds a cached answer for every request.
  const reads = vi.fn(async () => [{ requestHash: 'h', response: { answer: 'cached' } }]);
  const inserts: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: reads }) }),
    insert: (table: unknown) => { inserts.push(table); return { values: () => ({ returning: async () => [{ id: 'audit' }], onConflictDoNothing: async () => undefined }) }; },
  } as unknown as PostgresJsDatabase;
  try {
    const gateway = await createGateway({ apiKey: 'fixture', models: [{ role: 'analyst', model: 'test/model' }], db, baseURL: `http://127.0.0.1:${address.port}/v1` });
    const request = { runId: '00000000-0000-4000-8000-000000000001', role: 'analyst', promptVersion: 'v1', system: 's', user: 'u', schemaName: 'answer', schema: z.object({ answer: z.string() }).strict(), inputEvidenceIds: ['c1'] };
    expect(await gateway.generate(request)).toEqual({ answer: 'cached' });
    expect(upstream).toBe(0);
    expect(reads).toHaveBeenCalledOnce();
    inserts.length = 0;
    expect(await gateway.generate({ ...request, cache: false })).toEqual({ answer: 'fresh' });
    expect(await gateway.generate({ ...request, cache: false })).toEqual({ answer: 'fresh' });
    expect(upstream).toBe(2);
    expect(reads).toHaveBeenCalledOnce();
    expect(inserts).toEqual([llmCalls, llmCalls]);
    expect(inserts).not.toContain(llmCache);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
