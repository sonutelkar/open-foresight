import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { expect, it, vi } from 'vitest';
import { createGateway } from './index.js';

async function fixture(mode: 'ok' | 'retry' | 'missing' | 'no-zdr', kind: 'noul' | 'choice' | 'score' = 'noul') {
  const saved = JSON.parse(readFileSync(`fixtures/jev/${kind}.json`, 'utf8'));
  const calls: unknown[] = [];
  let attempts = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const supported_parameters = ['structured_outputs', 'tools'];
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test/model' }] }));
    if (req.url === '/v1/endpoints/zdr') return res.end(JSON.stringify({ data: [{ model_id: 'test/model', tag: 'provider', supported_parameters, pricing: { prompt: '0', completion: '0' } }, ...(mode === 'no-zdr' ? [] : [{ model_id: 'typesafe/jev-1.14', tag: 'typesafe', supported_parameters: [] }])] }));
    if (req.url === '/v1/models/test/model/endpoints') return res.end(JSON.stringify({ data: { id: 'test/model', endpoints: [{ tag: 'provider', supported_parameters }] } }));
    if (req.url !== '/alpha/decisions') { res.statusCode = 404; return res.end('{}'); }
    let body = ''; for await (const part of req) body += part;
    calls.push(JSON.parse(body)); attempts++;
    if (mode === 'retry' && attempts === 1) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'rate limited' } })); }
    const response = structuredClone(saved.response);
    if (mode === 'missing') delete response.answers[kind].probabilities;
    return res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const values = vi.fn((_value: { params: { provider: unknown }; requestHash: string }) => ({ returning: async () => [{ id: 'audit' }] }));
  const db = { insert: vi.fn(() => ({ values })) } as unknown as PostgresJsDatabase;
  const warn = vi.fn();
  const gateway = await createGateway({ apiKey: 'fixture', models: [{ role: 'designer', model: 'test/model' }], db, warn, baseURL: `http://127.0.0.1:${address.port}/v1` });
  const input = { runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'jev-evaluation', promptVersion: 'v1', model: 'typesafe/jev-1.14' as const, state: saved.request.state, questions: saved.request.questions, inputEvidenceIds: ['e1'] };
  const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return { gateway, input, calls, values, warn, close };
}

for (const kind of ['noul', 'choice', 'score'] as const) it(`validates and audits recorded ${kind} answers`, async () => {
  const f = await fixture('ok', kind);
  try {
    const result = await f.gateway.decide(f.input);
    expect(result.answers[kind]?.type).toBe(kind);
    expect(f.values).toHaveBeenCalledOnce();
    const record = f.values.mock.calls[0]?.[0];
    expect(record).toMatchObject({ model: 'typesafe/jev-1.14-20261014', provider: 'TypeSafe', error: null, inputEvidenceIds: ['e1'] });
    expect(record.params.provider).toMatchObject({ order: ['typesafe'], zdr: true, data_collection: 'deny', allow_fallbacks: false });
    expect(record.requestHash).toBe(createHash('sha256').update(JSON.stringify({ capability: 'decide', endpoint: '/alpha/decisions', ...record.params })).digest('hex'));
    expect(f.calls).toHaveLength(1);
  } finally { await f.close(); }
});

it('retries a transient error once and audits both attempts', async () => {
  const f = await fixture('retry');
  try { await f.gateway.decide(f.input); expect(f.calls).toHaveLength(2); expect(f.values).toHaveBeenCalledTimes(2); }
  finally { await f.close(); }
});

it('rejects missing probabilities without retrying', async () => {
  const f = await fixture('missing', 'choice');
  try { await expect(f.gateway.decide(f.input)).rejects.toThrow('Decision call failed'); expect(f.calls).toHaveLength(1); expect(f.values).toHaveBeenCalledOnce(); }
  finally { await f.close(); }
});

it('warns and continues with the pinned Jev provider when it is not in the ZDR catalog', async () => {
  const f = await fixture('no-zdr');
  try {
    await f.gateway.decide(f.input);
    expect(f.calls).toHaveLength(1);
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.values.mock.calls[0]?.[0].params.provider).toMatchObject({ order: ['typesafe'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny' });
    expect(f.values.mock.calls[0]?.[0].params.provider).not.toHaveProperty('zdr', true);
  }
  finally { await f.close(); }
});
