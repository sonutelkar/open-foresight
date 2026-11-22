import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { embeddingBatches, EMBEDDING_DIMENSIONS } from '@open-foresight/db';
import { createEmbedder } from './embed.js';

const MODEL = 'openai/text-embedding-3-small';
const vec = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed + i));

type Handler = (body: { model: string; input: string[]; provider: Record<string, unknown> }) => Response;
function fakeFetch(options: { providers?: Array<[string, string]>; zdr?: Array<[string, string]>; onEmbed?: Handler } = {}) {
  const posts: Array<{ model: string; input: string[]; provider: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/endpoints/zdr')) return Response.json({ data: (options.zdr ?? [[MODEL, 'azure']]).map(([model_id, tag]) => ({ model_id, tag })) });
    if (url.includes('/endpoints')) return Response.json({ data: { id: MODEL, endpoints: (options.providers ?? [['Azure', 'azure'], ['OpenAI', 'openai']]).map(([provider_name, tag]) => ({ provider_name, tag })) } });
    const body = JSON.parse(String(init?.body));
    posts.push(body);
    return (options.onEmbed ?? (b => Response.json({ provider: 'Azure', data: b.input.map((_, index) => ({ index, embedding: vec(index) })), usage: { prompt_tokens: b.input.length * 10, cost: b.input.length * 1e-6 } })))(body);
  };
  return { posts, fetcher };
}

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('embedder', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 1 });
  const db = drizzle(client);
  const make = (f: ReturnType<typeof fakeFetch>, extra: { batchSize?: number } = {}) => createEmbedder({ db, apiKey: 'secret-key', fetch: f.fetcher, baseURL: 'https://or.fixture/api/v1', ...extra });

  it('refuses to start unless the pinned provider serves the model and is ZDR', async () => {
    await expect(make(fakeFetch({ providers: [['OpenAI', 'openai']] }))).rejects.toThrow('not served by provider azure');
    await expect(make(fakeFetch({ zdr: [[MODEL, 'openai']] }))).rejects.toThrow('not a ZDR endpoint');
    await expect(createEmbedder({ db, apiKey: ' ' })).rejects.toThrow('API key');
    await expect(createEmbedder({ db, apiKey: 'k', batchSize: 0 })).rejects.toThrow();
  });

  it('pins the provider, splits batches, keeps order and audits each batch', async () => {
    const f = fakeFetch();
    const embedder = await make(f, { batchSize: 64 });
    const texts = Array.from({ length: 130 }, (_, i) => `passage ${i}`);
    const before = (await db.select().from(embeddingBatches)).length;
    const result = await embedder.embed(texts, 'test-index');
    expect(f.posts.map(p => p.input.length)).toEqual([64, 64, 2]);
    expect(f.posts[0]?.provider).toEqual({ order: ['azure'], allow_fallbacks: false, require_parameters: true, zdr: true, data_collection: 'deny' });
    expect(f.posts[0]?.model).toBe(MODEL);
    expect(result.vectors).toHaveLength(130);
    expect(result.vectors[65]).toEqual(vec(1));
    expect(result.tokens).toBe(1300);
    expect(result.costUsd).toBeCloseTo(130e-6, 10);
    const rows = (await db.select().from(embeddingBatches)).slice(before);
    expect(rows.map(r => r.inputCount)).toEqual([64, 64, 2]);
    expect(rows.every(r => r.provider === 'Azure' && r.purpose === 'test-index' && r.error === null && r.inputHash.length === 64)).toBe(true);
    await expect(client.unsafe('DELETE FROM embedding_batches')).rejects.toThrow('append-only');
  });

  it('retries a server error once, then succeeds', async () => {
    let calls = 0;
    const f = fakeFetch({ onEmbed: b => ++calls === 1 ? new Response('{}', { status: 503 }) : Response.json({ provider: 'Azure', data: b.input.map((_, index) => ({ index, embedding: vec(index) })) }) });
    const out = await (await make(f)).embed(['a'], 'retry');
    expect(calls).toBe(2);
    expect(out.vectors).toHaveLength(1);
  }, 20_000);

  it('audits a failure without leaking the key, and rejects a wrong provider, wrong size or bad input', async () => {
    const before = (await db.select().from(embeddingBatches)).length;
    const denied = await make(fakeFetch({ onEmbed: () => new Response(JSON.stringify({ error: { message: 'bad key secret-key' } }), { status: 401 }) }));
    const error = await denied.embed(['a'], 'fail').catch(e => e as Error);
    expect((error as Error).message).toContain('Embedding batch failed');
    expect((error as Error).message).not.toContain('secret-key');
    const failed = (await db.select().from(embeddingBatches)).slice(before);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toBeTruthy();
    expect(JSON.stringify(failed[0]?.error)).not.toContain('secret-key');

    const other = await make(fakeFetch({ onEmbed: b => Response.json({ provider: 'OpenAI', data: b.input.map((_, index) => ({ index, embedding: vec(index) })) }) }));
    await expect(other.embed(['a'], 'p')).rejects.toThrow('not Azure');
    const short = await make(fakeFetch({ onEmbed: b => Response.json({ provider: 'Azure', data: b.input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }) }));
    await expect(short.embed(['a'], 'p')).rejects.toThrow('dimensions');
    const ok = await make(fakeFetch());
    await expect(ok.embed([' '], 'p')).rejects.toThrow('empty');
    await expect(ok.embed(['x'.repeat(30_001)], 'p')).rejects.toThrow('too long');
    await expect(ok.embed(['a'], ' ')).rejects.toThrow('purpose');
  });
});
