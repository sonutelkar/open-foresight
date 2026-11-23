import { createServer } from 'node:http';
import { once } from 'node:events';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { llmCalls } from '@open-foresight/db';
import { createGateway } from './index.js';

const reviewerModel = 'deepseek/deepseek-v4.1-flash-1017';
const params = ['structured_outputs', 'tools', 'temperature', 'max_tokens'];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

/** A fixture OpenRouter with a pinned ZDR analyst model and a Reviewer model served by two providers. */
async function fixture(options: { reviewerZdr?: boolean; reviewerEndpoints?: Array<{ tag: string; supported_parameters: string[] }> } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test/analyst' }, { id: reviewerModel }] }));
    if (req.url === '/v1/endpoints/zdr') return res.end(JSON.stringify({ data: [
      { model_id: 'test/analyst', tag: 'zdr-tag', supported_parameters: params, pricing: { prompt: '0', completion: '0' } },
      ...(options.reviewerZdr ? [{ model_id: reviewerModel, tag: 'deepinfra/fp8', supported_parameters: params, pricing: { prompt: '0', completion: '0' } }] : []),
    ] }));
    if (req.url === '/v1/models/test/analyst/endpoints') return res.end(JSON.stringify({ data: { id: 'test/analyst', endpoints: [{ tag: 'zdr-tag', supported_parameters: params }] } }));
    if (req.url === `/v1/models/${reviewerModel}/endpoints`) return res.end(JSON.stringify({ data: { id: reviewerModel, endpoints: options.reviewerEndpoints ?? [{ tag: 'deepinfra/fp8', supported_parameters: params }, { tag: 'novita', supported_parameters: params }] } }));
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body) as { model: string };
    requests.push(request);
    const served = request.model === reviewerModel ? { model: reviewerModel, provider: 'Novita' } : { model: 'test/analyst', provider: 'ZdrProvider' };
    return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, ...served, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answer: 'ok' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const audits: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
      if (table === llmCalls) audits.push(value);
      return { returning: async () => [{ id: `audit-${audits.length}` }], onConflictDoNothing: async () => undefined };
    } }),
  } as unknown as PostgresJsDatabase;
  const warn = vi.fn();
  const create = (models = [{ role: 'analyst', model: 'test/analyst' }, { role: 'reviewer', model: reviewerModel, zdr: 'warn' as const }]) =>
    createGateway({ apiKey: 'fixture', models, db, warn, baseURL: `http://127.0.0.1:${address.port}/v1` });
  return { requests, audits, warn, create };
}
const request = (role: string) => ({ runId: '00000000-0000-4000-8000-000000000001', role, promptVersion: 'v1', system: 's', user: `u-${role}`, schemaName: 'answer', schema: z.object({ answer: z.string() }).strict(), inputEvidenceIds: ['c1'], cache: false });

it('sends the Reviewer to any provider without ZDR, warns once, and records the provider that served it', async () => {
  const f = await fixture();
  const gateway = await f.create();
  expect(f.warn).toHaveBeenCalledOnce();
  expect(f.warn.mock.calls[0]?.[0]).toContain(`No ZDR endpoint for ${reviewerModel}`);
  expect(await gateway.generate(request('reviewer'))).toEqual({ answer: 'ok' });
  expect(f.requests[0]?.provider).toEqual({ allow_fallbacks: true, require_parameters: true, data_collection: 'deny' });
  expect(f.requests[0]?.temperature).toBe(0);
  expect(f.audits[0]).toMatchObject({ role: 'reviewer', model: reviewerModel, provider: 'Novita' });
  expect((f.audits[0]?.params as { provider: unknown }).provider).toEqual({ allow_fallbacks: true, require_parameters: true, data_collection: 'deny' });
});

it('keeps every scoring route pinned to its ZDR provider in the same gateway', async () => {
  const f = await fixture();
  const gateway = await f.create();
  await gateway.generate(request('analyst'));
  expect(f.requests[0]?.provider).toEqual({ order: ['zdr-tag'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true });
  expect(f.audits[0]).toMatchObject({ role: 'analyst', provider: 'ZdrProvider' });
});

it('does not warn when a ZDR endpoint exists, and still does not pin the Reviewer', async () => {
  const f = await fixture({ reviewerZdr: true });
  const gateway = await f.create();
  expect(f.warn).not.toHaveBeenCalled();
  await gateway.generate(request('reviewer'));
  expect(f.requests[0]?.provider).not.toHaveProperty('order');
  expect(f.requests[0]?.provider).not.toHaveProperty('zdr');
});

it('sends only parameters every eligible endpoint supports, so it never narrows the route', async () => {
  const f = await fixture({ reviewerEndpoints: [{ tag: 'a', supported_parameters: params }, { tag: 'b', supported_parameters: ['structured_outputs'] }, { tag: 'c', supported_parameters: ['temperature', 'max_tokens'] }] });
  const gateway = await f.create();
  await gateway.generate(request('reviewer'));
  expect(f.requests[0]).not.toHaveProperty('temperature');
  await expect(gateway.generate({ ...request('reviewer'), maxOutputTokens: 10 })).rejects.toThrow('lacks a supported output token limit');
});

it('refuses the ZDR exception for any role but the Reviewer, and a Reviewer model with no structured output', async () => {
  const f = await fixture();
  await expect(f.create([{ role: 'analyst', model: 'test/analyst', zdr: 'warn' }])).rejects.toThrow('Only the reviewer route may run without ZDR');
  const g = await fixture({ reviewerEndpoints: [{ tag: 'a', supported_parameters: ['tools'] }] });
  await expect(g.create()).rejects.toThrow(`No provider with structured outputs for ${reviewerModel}`);
  expect(f.requests).toHaveLength(0);
});
