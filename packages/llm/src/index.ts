import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { llmCalls, llmCache } from '@open-foresight/db';
import { eq } from 'drizzle-orm';
export * from './loop.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

const registrySchema = z.array(z.object({
  role: z.string().min(1),
  model: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
}).strict()).min(1).superRefine((items, ctx) => {
  const names = new Set<string>();
  for (const item of items) {
    if (names.has(item.role)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate role: ${item.role}` });
    names.add(item.role);
  }
});
export type ModelConfig = z.infer<typeof registrySchema>[number];
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const endpointsSchema = z.object({ data: z.object({ id: z.string(), endpoints: z.array(z.object({
  tag: z.string(), supported_parameters: z.array(z.string()),
})) }) });
const zdrSchema = z.object({ data: z.array(z.unknown()) });
const zdrEndpointSchema = z.object({ model_id: z.string(), tag: z.string(), supported_parameters: z.array(z.string()), pricing: z.unknown().optional() });
const pricingSchema = z.object({ prompt: z.union([z.string(), z.number()]), completion: z.union([z.string(), z.number()]), request: z.union([z.string(), z.number()]).optional() });
const providerTag = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
type Fraction = { numerator: bigint; denominator: bigint };
function parsePrice(value: string | number): Fraction | undefined {
  const text = String(value);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
  const price = Number(text);
  if (!Number.isFinite(price) || price < 0) return undefined;
  const [mantissa = '', exponentText = '0'] = text.toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const numerator = BigInt((whole || '0') + fraction);
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  if (price === 0) return undefined;
  const exponent = Number(exponentText) - fraction.length;
  return exponent >= 0
    ? { numerator: numerator * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator, denominator: 10n ** BigInt(-exponent) };
}
function addPrices(a: Fraction, b: Fraction): Fraction {
  return { numerator: a.numerator * b.denominator + b.numerator * a.denominator, denominator: a.denominator * b.denominator };
}
function comparePrices(a: Fraction, b: Fraction): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

const requestSchema = z.object({ runId: z.string().uuid(), role: z.string().min(1), promptVersion: z.string().min(1), system: z.string().min(1), user: z.string().min(1), schemaName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), inputEvidenceIds: z.array(z.string().min(1)), seed: z.number().int().optional(), maxOutputTokens: z.number().int().positive().optional() });
const completionSchema = z.object({
  model: z.string(), provider: z.string().min(1),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), total_tokens: z.number().optional(),
    cost: z.number().nonnegative().optional(), prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

type GatewayOptions = { apiKey: string; models: ModelConfig[]; db: PostgresJsDatabase; baseURL?: string; concurrency?: number };
type StructuredRequest<T extends ZodTypeAny> = {
  runId: string; role: string; promptVersion: string; system: string; user: string;
  schemaName: string; schema: T; inputEvidenceIds: string[]; seed?: number; maxOutputTokens?: number; onAudit?: (id: string) => void;
  /** False neither reads nor writes the cache, so a repeat of a recorded request reaches the model. The call is audited as usual. */
  cache?: boolean;
};

const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: z.string().min(1) }).strict(),
  z.object({ type: z.literal('choice'), instructions: z.string().min(1), criteria: z.record(z.string().min(1)).refine(v => Object.keys(v).length >= 2) }).strict(),
  z.object({ type: z.literal('score'), instructions: z.string().min(1), criteria: z.array(z.string().min(1)).min(2) }).strict(),
]);
export type DecisionQuestion = z.infer<typeof questionSchema>;
const decisionRequestSchema = z.object({ runId: z.string().uuid(), role: z.string().min(1), promptVersion: z.string().min(1), model: z.literal('typesafe/jev-1.14'), state: z.string().min(1), questions: z.record(questionSchema).refine(v => Object.keys(v).length > 0), inputEvidenceIds: z.array(z.string().min(1)) }).strict();
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
const probability = z.number().finite().min(0).max(1);
const decisionResponseSchema = z.object({ id: z.string().min(1), model: z.string().min(1), provider: z.string().min(1), answers: z.record(z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities: z.record(probability), confidence: probability }),
  z.object({ type: z.literal('score'), score: z.number().finite(), legend: z.record(z.string()), probabilities: z.record(probability), confidence: probability }),
])), usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), cost: z.number().finite().nonnegative() }).passthrough() }).passthrough();
export type DecisionResult = z.infer<typeof decisionResponseSchema> & { longContext: boolean };

function requestHash(params: unknown): string {
  return createHash('sha256').update(JSON.stringify(params)).digest('hex');
}

async function writeAudit(db: PostgresJsDatabase, values: typeof llmCalls.$inferInsert): Promise<string> {
  const [record] = await db.insert(llmCalls).values(values).returning({ id: llmCalls.id });
  if (!record) throw new Error('Could not record model call');
  return record.id;
}

/** Select one eligible provider for each configured model before accepting requests. */
export async function createGateway(options: GatewayOptions) {
  const registry = registrySchema.parse(options.models);
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency limit');
  let active = 0;
  const waiting: Array<() => void> = [];
  const inFlight = new Map<string, Promise<void>>();
  async function serializeKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = inFlight.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    inFlight.set(key, current);
    if (previous) await previous;
    try { return await fn(); } finally {
      release();
      if (inFlight.get(key) === current) inFlight.delete(key);
    }
  }
  async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  }
  if (!options.apiKey.trim()) throw new Error('OpenRouter API key is required');
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL ?? 'https://openrouter.ai/api/v1', maxRetries: 0 });
  const decisionsClient = new OpenAI({ apiKey: options.apiKey, baseURL: (options.baseURL ?? 'https://openrouter.ai/api/v1').replace(/\/v1\/?$/, ''), maxRetries: 0 });
  const available = modelsSchema.parse(await client.get('/models'));
  const zdr = zdrSchema.parse(await client.get('/endpoints/zdr'));
  const selectedProviders = new Map<string, { tag: string; temperature: boolean; outputCap?: 'max_tokens' | 'max_completion_tokens' }>();
  for (const config of registry) {
    if (!available.data.some(model => model.id === config.model)) throw new Error(`Unknown model: ${config.model}`);
    const separator = config.model.indexOf('/');
    const author = config.model.slice(0, separator);
    const slug = config.model.slice(separator + 1);
    const endpoints = endpointsSchema.parse(await client.get(`/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`));
    if (endpoints.data.id !== config.model) throw new Error(`Endpoint model mismatch: ${config.model}`);
    const requiredParameters = ['structured_outputs', 'tools'];
    const candidates = zdr.data.flatMap(raw => {
      const parsed = zdrEndpointSchema.safeParse(raw);
      if (!parsed.success) return [];
      const item = parsed.data;
      if (item.model_id !== config.model || !providerTag.test(item.tag) || !requiredParameters.every(parameter => item.supported_parameters.includes(parameter))) return [];
      if (!endpoints.data.endpoints.some(endpoint => endpoint.tag === item.tag && requiredParameters.every(parameter => endpoint.supported_parameters.includes(parameter)))) return [];
      const pricing = pricingSchema.safeParse(item.pricing);
      if (!pricing.success) return [];
      const prompt = parsePrice(pricing.data.prompt);
      const completion = parsePrice(pricing.data.completion);
      const request = pricing.data.request === undefined ? { numerator: 0n, denominator: 1n } : parsePrice(pricing.data.request);
      if (prompt === undefined || completion === undefined || request === undefined) return [];
      const tokenCost = addPrices(prompt, completion);
      const estimatedCost = addPrices({ numerator: 1000n * tokenCost.numerator, denominator: tokenCost.denominator }, request);
      return [{ tag: item.tag, estimatedCost, temperature: item.supported_parameters.includes('temperature'),
        outputCap: item.supported_parameters.includes('max_completion_tokens') ? 'max_completion_tokens' as const :
          item.supported_parameters.includes('max_tokens') ? 'max_tokens' as const : undefined }];
    });
    candidates.sort((a, b) => comparePrices(a.estimatedCost, b.estimatedCost) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    const selected = candidates[0];
    if (!selected) throw new Error(`No eligible ZDR provider with valid pricing and required parameters for ${config.model}`);
    selectedProviders.set(config.role, selected);

  }

  return {
    async decide(input: DecisionRequest): Promise<DecisionResult> {
      const parsed = decisionRequestSchema.parse(input);
      if (!zdr.data.some(raw => { const item = zdrEndpointSchema.safeParse(raw); return item.success && item.data.model_id === parsed.model && item.data.tag === 'typesafe'; })) throw new Error('No verified ZDR provider for decision model');
      const params = { model: parsed.model, state: parsed.state, questions: parsed.questions, provider: { order: ['typesafe'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true } };
      const hash = requestHash({ capability: 'decide', endpoint: '/alpha/decisions', ...params });
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = performance.now();
        let raw: unknown;
        let response: z.infer<typeof decisionResponseSchema> | undefined;
        let failure: unknown;
        try {
          raw = await limited(() => decisionsClient.post('/alpha/decisions', { body: params }));
          response = decisionResponseSchema.parse(raw);
          for (const [name, question] of Object.entries(parsed.questions)) {
            const answer = response.answers[name];
            if (!answer || answer.type !== question.type) throw new Error(`Missing or mismatched answer: ${name}`);
            if (question.type === 'choice' && answer.type === 'choice' && (!Object.hasOwn(question.criteria, answer.choice) || Object.keys(question.criteria).some(key => !Object.hasOwn(answer.probabilities, key)))) throw new Error(`Missing choice probabilities: ${name}`);
            if (question.type === 'score' && answer.type === 'score' && question.criteria.some((_, i) => !Object.hasOwn(answer.probabilities, String(i)))) throw new Error(`Missing score probabilities: ${name}`);
          }
        } catch (error) { failure = error; }
        await writeAudit(options.db, { runId: parsed.runId, role: parsed.role, promptVersion: parsed.promptVersion, model: response?.model ?? parsed.model, provider: response?.provider ?? null, params, requestHash: hash, inputEvidenceIds: parsed.inputEvidenceIds, response: raw ?? null, error: failure ? { message: failure instanceof Error ? failure.message : 'Unknown decision error' } : null, tokens: response?.usage ?? null, cost: response ? String(response.usage.cost) : null, latencyMs: Math.round(performance.now() - started) });
        if (!failure && response) return { ...response, longContext: Buffer.byteLength(parsed.state, 'utf8') > 32000 };
        if (!(failure instanceof OpenAI.APIError && (failure.status === 429 || (failure.status !== undefined && failure.status >= 500)) && attempt === 0)) throw new Error(`Decision call failed: ${failure instanceof Error ? failure.message : 'Unknown error'}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Decision call failed');
    },
    async generate<T extends ZodTypeAny>(input: StructuredRequest<T>): Promise<z.infer<T>> {
      requestSchema.parse(input);
      const config = registry.find(item => item.role === input.role);
      if (!config) throw new Error(`Unknown model role: ${input.role}`);
      const selected = selectedProviders.get(config.role);
      if (!selected) throw new Error(`No provider selected for ${config.role}`);
      if (input.maxOutputTokens !== undefined && !selected.outputCap) throw new Error(`Provider ${selected.tag} lacks a supported output token limit for ${config.model}`);
      const tokenLimit = input.maxOutputTokens === undefined ? {} : selected.outputCap === 'max_completion_tokens'
        ? { max_completion_tokens: input.maxOutputTokens }
        : { max_tokens: input.maxOutputTokens };
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: input.system }, { role: 'user', content: input.user },
      ];
      const schema = zodToJsonSchema(input.schema, { $refStrategy: 'none' });
      const cacheKey = requestHash({ capability: 'generate', role: input.role, promptVersion: input.promptVersion, inputEvidenceIds: input.inputEvidenceIds, model: config.model, provider: selected.tag, temperature: selected.temperature ? 0 : null, seed: input.seed ?? null, tokenLimit, messages, schemaName: input.schemaName, schema });
      return serializeKey(cacheKey, async () => {
        const [cached] = input.cache === false ? [] : await options.db.select().from(llmCache).where(eq(llmCache.requestHash, cacheKey));
        if (cached) {
          const value = input.schema.parse(cached.response);
          const auditId = await writeAudit(options.db, { runId: input.runId, role: input.role, promptVersion: input.promptVersion, model: config.model, provider: selected.tag, params: { cacheHit: true }, requestHash: cacheKey, inputEvidenceIds: input.inputEvidenceIds, response: cached.response, cost: '0', latencyMs: 0 });
          input.onAudit?.(auditId);
          return value;
        }
        let repairs = 0;
        let retries = 0;
        for (;;) {
          const params = {
            model: config.model, ...(selected.temperature ? { temperature: 0 } : {}),
            ...(input.seed === undefined ? {} : { seed: input.seed }),
            ...tokenLimit, messages: [...messages],
            response_format: { type: 'json_schema' as const, json_schema: { name: input.schemaName, strict: true, schema } },
            provider: { order: [selected.tag], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true },
            usage: { include: true },
          };
          const hash = requestHash(params);
          const started = performance.now();
          let raw: unknown;
          let failure: string | undefined;
          let failureCause: unknown;
          let value: z.infer<T> | undefined;
          let cacheValue: unknown;
          try {
            raw = await limited(() => client.chat.completions.create(params));
            const response = completionSchema.parse(raw);
            const content = response.choices[0]?.message.content;
            if (content === null || content === undefined) throw new Error('Model returned no content');
            cacheValue = JSON.parse(content);
            value = input.schema.parse(cacheValue);
          } catch (error) {
            failureCause = error;
            failure = error instanceof Error ? error.message : 'Unknown model call error';
          }
          const latencyMs = Math.round(performance.now() - started);
          const parsed = completionSchema.safeParse(raw);
          const response = parsed.success ? parsed.data : undefined;
          const auditId = await writeAudit(options.db, {
            runId: input.runId, role: input.role, promptVersion: input.promptVersion,
            model: response?.model ?? config.model, provider: response?.provider ?? null,
            params, requestHash: hash, inputEvidenceIds: input.inputEvidenceIds,
            response: raw ?? null, error: failure ? { message: failure } : null,
            tokens: response?.usage ?? null, cachedTokens: response?.usage?.prompt_tokens_details?.cached_tokens ?? null,
            cost: response?.usage?.cost?.toString() ?? null, latencyMs,
          });
          input.onAudit?.(auditId);
          if (!failure) {
            if (input.cache !== false) await options.db.insert(llmCache).values({ requestHash: cacheKey, response: cacheValue }).onConflictDoNothing();
            return value;
          }
          if (!response && failureCause instanceof OpenAI.APIError && (failureCause.status === 429 || (failureCause.status !== undefined && failureCause.status >= 500)) && retries++ === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }
          if (!response || repairs++ >= 1) throw new Error(`Model call failed: ${failure}`);
          messages.push({ role: 'assistant', content: response.choices[0]?.message.content ?? '' });
          messages.push({ role: 'user', content: `Your previous response was invalid. Return corrected JSON matching the schema. Validation error: ${failure}` });
        }
      });
    },
  };
}
export * from './embed.js';
export * from './discover.js';
