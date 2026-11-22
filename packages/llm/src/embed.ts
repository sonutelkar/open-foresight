import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { EMBEDDING_DIMENSIONS, embeddingBatches } from '@open-foresight/db';

export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_PROVIDER = 'azure';

const endpointsSchema = z.object({ data: z.object({ id: z.string(), endpoints: z.array(z.object({ tag: z.string(), provider_name: z.string() })) }) });
const zdrSchema = z.object({ data: z.array(z.object({ model_id: z.string(), tag: z.string() }).passthrough()) });
const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })).min(1),
  provider: z.string().optional(),
  usage: z.object({ prompt_tokens: z.number().optional(), total_tokens: z.number().optional(), cost: z.number().optional() }).passthrough().optional(),
});
const maxInputChars = 30_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type Embedder = {
  readonly model: string;
  readonly provider: string;
  readonly dimensions: number;
  /** Embeds texts in order. Each request is audited in `embedding_batches`, including failures. */
  embed(texts: string[], purpose: string): Promise<{ vectors: number[][]; tokens: number; costUsd: number }>;
};

/**
 * Embeds text through OpenRouter, pinned to one provider with fallbacks off, ZDR required and data collection denied.
 * Startup fails unless the pinned provider serves the model and is on OpenRouter's ZDR list.
 * Index time embeddings have no run, so they are audited in `embedding_batches` and not in `llm_calls`.
 */
export async function createEmbedder(options: {
  db: PostgresJsDatabase; apiKey: string; model?: string; provider?: string; baseURL?: string; batchSize?: number; fetch?: typeof fetch;
}): Promise<Embedder> {
  if (!options.apiKey.trim()) throw new Error('OpenRouter API key is required');
  const model = options.model ?? EMBEDDING_MODEL;
  const provider = options.provider ?? EMBEDDING_PROVIDER;
  const batchSize = options.batchSize ?? 64;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error('Invalid embedding batch size');
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL ?? 'https://openrouter.ai/api/v1', maxRetries: 0, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const separator = model.indexOf('/');
  if (separator < 1) throw new Error(`Invalid model: ${model}`);
  const endpoints = endpointsSchema.parse(await client.get(`/models/${encodeURIComponent(model.slice(0, separator))}/${encodeURIComponent(model.slice(separator + 1))}/endpoints`));
  const endpoint = endpoints.data.endpoints.find(e => e.tag === provider);
  if (!endpoint) throw new Error(`${model} is not served by provider ${provider}`);
  const zdr = zdrSchema.parse(await client.get('/endpoints/zdr'));
  if (!zdr.data.some(e => e.model_id === model && e.tag === provider)) throw new Error(`${provider} is not a ZDR endpoint for ${model}`);

  async function request(inputs: string[]) {
    const body = { model, input: inputs, encoding_format: 'float', provider: { order: [provider], allow_fallbacks: false, require_parameters: true, zdr: true, data_collection: 'deny' } };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const parsed = responseSchema.parse(await client.post('/embeddings', { body }));
        if (parsed.provider && parsed.provider.toLowerCase() !== endpoint!.provider_name.toLowerCase()) throw new Error(`Embeddings were served by ${parsed.provider}, not ${endpoint!.provider_name}`);
        if (parsed.data.length !== inputs.length) throw new Error('Embedding count does not match input count');
        const vectors: number[][] = Array.from({ length: inputs.length }, () => []);
        for (const row of parsed.data) {
          if (row.index >= inputs.length || vectors[row.index]!.length > 0) throw new Error('Embedding indexes are invalid');
          if (row.embedding.length !== EMBEDDING_DIMENSIONS) throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${row.embedding.length}`);
          vectors[row.index] = row.embedding;
        }
        return { vectors, tokens: parsed.usage?.prompt_tokens ?? parsed.usage?.total_tokens ?? 0, cost: parsed.usage?.cost ?? 0, provider: parsed.provider ?? endpoint!.provider_name };
      } catch (error) {
        const status = error instanceof OpenAI.APIError ? error.status : undefined;
        const retryable = status === 429 || (status !== undefined && status >= 500) || (error instanceof Error && error.name === 'APIConnectionError');
        if (!retryable || attempt === 2) throw error;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw new Error('Embedding request failed');
  }

  return {
    model, provider, dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts, purpose) {
      if (!purpose.trim()) throw new Error('Embedding purpose is required');
      for (const text of texts) {
        if (!text.trim()) throw new Error('Cannot embed empty text');
        if (text.length > maxInputChars) throw new Error('Text is too long to embed');
      }
      const vectors: number[][] = [];
      let tokens = 0, costUsd = 0;
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const inputs = texts.slice(offset, offset + batchSize);
        const inputHash = createHash('sha256').update(JSON.stringify([model, provider, inputs])).digest('hex');
        const started = performance.now();
        try {
          const result = await request(inputs);
          vectors.push(...result.vectors); tokens += result.tokens; costUsd += result.cost;
          await options.db.insert(embeddingBatches).values({ model, provider: result.provider, purpose, inputCount: inputs.length, inputHash, tokens: result.tokens, cost: String(result.cost), latencyMs: Math.round(performance.now() - started) });
        } catch (error) {
          const message = error instanceof Error ? error.message.replace(options.apiKey, '[redacted]') : 'Unknown embedding error';
          await options.db.insert(embeddingBatches).values({ model, provider, purpose, inputCount: inputs.length, inputHash, latencyMs: Math.round(performance.now() - started), error: { message } });
          throw new Error(`Embedding batch failed: ${message}`);
        }
      }
      return { vectors, tokens, costUsd };
    },
  };
}
