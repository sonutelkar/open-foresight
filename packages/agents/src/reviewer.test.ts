import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReviewerInput } from '@open-foresight/core';
import { llmCalls, reviews } from '@open-foresight/db';
import { createGateway } from '@open-foresight/llm';
import type { StructuredGenerator } from './designer.js';
import { reviewerRoute, reviewScore, sampledForReview } from './reviewer.js';

const fixture = JSON.parse(readFileSync(new URL('../../evals/fixtures/reviewer-100.json', import.meta.url), 'utf8')) as { calls: Record<string, { input: ReviewerInput; response: string }> };
const reviewerModel = 'deepseek/deepseek-v4.1-flash-1017';
const runId = '00000000-0000-4000-8000-000000000001';
const scoreId = '00000000-0000-4000-8000-000000000002';

describe('sampling for review', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  it('always samples level 2 and above, and confidence below 0.6', () => {
    for (const id of ids(500)) {
      for (const level of ['2', '3', '4'] as const) expect(sampledForReview('seed', { id, level, confidence: 1 })).toBe(true);
      for (const level of ['0', '1', 'unknown'] as const) expect(sampledForReview('seed', { id, level, confidence: 0.59 })).toBe(true);
    }
  });
  it('samples about 10% of the rest, the same ones on every call, and other ones under another seed', () => {
    const rest = ids(10_000).map(id => ({ id, level: '1' as const, confidence: 0.6 }));
    const picked = rest.filter(s => sampledForReview('run-a', s)).map(s => s.id);
    expect(picked.length / rest.length).toBeGreaterThan(0.09);
    expect(picked.length / rest.length).toBeLessThan(0.11);
    expect(rest.filter(s => sampledForReview('run-a', s)).map(s => s.id)).toEqual(picked);
    expect(rest.filter(s => sampledForReview('run-b', s)).map(s => s.id)).not.toEqual(picked);
  });
  // Pinned from shasum -a 256 of "phase2\n<id>": the first four bytes over 2^32 are below 0.1 for exactly these ids.
  it('makes the same choice in a new process, because it depends only on the seed and the score id', () => {
    const picked = ids(60).filter(id => sampledForReview('phase2', { id, level: '0', confidence: 0.9 })).map(id => Number(id.slice(-12)));
    expect(picked).toEqual([5, 15, 25, 33]);
  });
});

describe('Reviewer vendor', () => {
  const scorers = [
    { role: 'designer', model: 'anthropic/claude-opus-5.5' }, { role: 'analyst', model: 'openai/gpt-6-luna' },
    { role: 'labeller', model: 'google/gemini-3.1-pro-preview' }, { role: 'jev-evaluation', model: 'typesafe/jev-1.14' },
  ];
  it('rejects a Reviewer from the vendor of any scoring route', () => {
    for (const model of ['anthropic/claude-haiku-5.5', 'openai/gpt-6-mini', 'google/gemini-3-flash', 'typesafe/jev-1.14', 'OpenAI/gpt-6-luna']) {
      expect(() => reviewerRoute([...scorers, { role: 'reviewer', model }])).toThrow('shares the vendor');
    }
    expect(() => reviewerRoute(scorers)).toThrow('No reviewer route');
  });
  it('accepts the configured Reviewer, exactly the decided model', async () => {
    const config = await import(new URL('../../../config/models.ts', import.meta.url).href) as { models: Array<{ role: string; model: string; zdr?: string }>; decisionModels: ReadonlyArray<{ role: string; model: string }> };
    expect(reviewerRoute([...config.models, ...config.decisionModels])).toEqual({ role: 'reviewer', model: reviewerModel, zdr: 'warn' });
  });
});

describe('reviewScore', () => {
  let response = '';
  let requests: Array<{ provider: unknown; messages: Array<{ role: string; content: string }> }> = [];
  let baseURL = '';
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: reviewerModel }] }));
    if (req.url === '/v1/endpoints/zdr') return res.end(JSON.stringify({ data: [] }));
    if (req.url === `/v1/models/${reviewerModel}/endpoints`) return res.end(JSON.stringify({ data: { id: reviewerModel, endpoints: [{ tag: 'deepinfra/fp8', supported_parameters: ['structured_outputs', 'tools', 'temperature', 'max_tokens'] }] } }));
    let body = '';
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: `${reviewerModel}-served`, provider: 'DeepInfra', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: response } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 } }));
  });
  beforeAll(async () => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });
  afterAll(() => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))));

  /** Stands in for Postgres. It keeps what the gateway and the Reviewer insert, and answers the Reviewer's audit lookup with the latest call. */
  function store() {
    const calls: Array<Record<string, unknown>> = [], saved: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({ from: (table: unknown) => ({ where: async () => (table === llmCalls ? calls.slice(-1) : []) }) }),
      insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
        const rows = table === llmCalls ? calls : table === reviews ? saved : [];
        const row = { ...value, id: `${table === reviews ? 'review' : 'call'}-${rows.length + 1}` };
        rows.push(row);
        return { returning: async () => [{ id: row.id }], onConflictDoNothing: async () => undefined };
      } }),
    } as unknown as PostgresJsDatabase;
    return { db, calls, saved };
  }
  async function review(recordId: string) {
    const s = store();
    requests = [];
    response = fixture.calls[recordId]!.response;
    const gateway = await createGateway({ apiKey: 'fixture', models: [{ role: 'reviewer', model: reviewerModel, zdr: 'warn' }], db: s.db, baseURL, warn: () => {} });
    const run = reviewScore({ db: s.db, gateway, runId, cache: false }, scoreId, fixture.calls[recordId]!.input);
    return { ...s, run };
  }

  it('saves an accepted clean score with the served model and provider, linked to the score attempt', async () => {
    const r = await review('rvf-80');
    const outcome = await r.run;
    expect(outcome).toMatchObject({ review: { verdict: 'accept', issue: 'none' }, model: `${reviewerModel}-served`, provider: 'DeepInfra', llmCallId: 'call-1', reviewId: 'review-1' });
    expect(outcome.review).not.toHaveProperty('suggestedLevel');
    expect(r.saved).toEqual([expect.objectContaining({ runId, scoreId, llmCallId: 'call-1', model: `${reviewerModel}-served`, provider: 'DeepInfra', verdict: 'accept', issue: 'none', suggestedLevel: null })]);
    expect(r.saved[0]?.promptVersion).toMatch(/^reviewer@v1:[0-9a-f]{12}$/);
    expect(r.calls[0]).toMatchObject({ role: 'reviewer', inputEvidenceIds: ['chunk-80'] });
  });

  it('flags a score whose passage is about another company, and escalates it', async () => {
    const r = await review('rvf-0');
    expect((await r.run).review).toMatchObject({ verdict: 'escalate', issue: 'wrong_entity' });
    expect(r.saved[0]).toMatchObject({ verdict: 'escalate', issue: 'wrong_entity' });
  });

  it('sends a stale score back for a retry with a suggested level', async () => {
    const r = await review('rvf-10');
    expect((await r.run).review).toEqual({ verdict: 'retry', issue: 'stale_evidence', note: expect.stringContaining('2019'), suggestedLevel: 'unknown' });
    expect(r.saved[0]).toMatchObject({ verdict: 'retry', issue: 'stale_evidence', suggestedLevel: 'unknown' });
  });

  it('sends the level, rubric and cited passages, unpinned, and nothing of the Analyst', async () => {
    const r = await review('rvf-1');
    await r.run;
    const input = fixture.calls['rvf-1']!.input;
    const user = requests[0]!.messages.find(m => m.role === 'user')!.content;
    expect(user).toContain(`Level given: ${input.score.level}`);
    expect(user).toContain(input.kpi.rubric.levels[3]);
    expect(user).toContain(`[e1] issuer ${input.passages[0]!.issuer} | available 2019-02-15`);
    expect(user).toContain(input.passages[0]!.text);
    expect(requests[0]!.provider).toEqual({ allow_fallbacks: true, require_parameters: true, data_collection: 'deny' });
  });

  it('saves no review for an output that stays invalid after the one repair', async () => {
    for (const id of ['rvf-19', 'rvf-79']) {
      const r = await review(id);
      await expect(r.run).rejects.toThrow('Model call failed');
      expect(r.saved).toEqual([]);
      expect(r.calls).toHaveLength(2);
      expect(r.calls.every(c => c.error !== null && c.provider === 'DeepInfra')).toBe(true);
    }
  });

  it('rejects any input beyond the score, rubric and cited passages before calling the model', async () => {
    const input = fixture.calls['rvf-80']!.input;
    const leaks: unknown[] = [
      { ...input, rationale: 'The Analyst thought level 2 because...' },
      { ...input, score: { ...input.score, rationale: 'hidden' } },
      { ...input, score: { ...input.score, reasoning: 'hidden' } },
      { ...input, kpi: { ...input.kpi, conflicts: [] } },
      { ...input, passages: [{ ...input.passages[0]!, quote: 'copied by the Analyst' }] },
    ];
    let generated = 0;
    const gateway: StructuredGenerator = { async generate() { generated++; throw new Error('unreachable'); } };
    const s = store();
    for (const leak of leaks) await expect(reviewScore({ db: s.db, gateway, runId }, scoreId, leak as ReviewerInput)).rejects.toThrow(/Unrecognized key/);
    expect(generated).toBe(0);
    expect(s.saved).toEqual([]);
  });
});
