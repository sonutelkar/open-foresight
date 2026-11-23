import { z } from 'zod';

/** The model that proposes where to look. It is cheap and only suggests URLs. Code fetches and checks every one. */
export const discoveryModel = 'anthropic/claude-haiku-5.5';

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable(), annotations: z.array(z.object({ type: z.string(), url_citation: z.object({ url: z.string() }).optional() }).passthrough()).optional() }) })).min(1),
  provider: z.string().optional(), model: z.string().optional(),
  usage: z.object({ cost: z.number().optional() }).passthrough().optional(),
}).passthrough();

export type DiscoveryResult = {
  text: string;
  /** URLs the web search cited, in order. */
  citedUrls: string[];
  model: string; provider: string | null;
  /** False when the provider could not honor zero data retention and the call went ahead without it. */
  zdr: boolean;
  cost: number | null; usage: unknown; latencyMs: number;
  /** The request body without the prompt, for the audit row. */
  params: Record<string, unknown>;
};

/** A provider that cannot serve a request under the zero data retention filter answers with an error naming the data policy or the missing endpoints. */
const zdrUnavailable = (status: number, body: string) => (status === 400 || status === 404) && /zdr|zero.data|data policy|no endpoints/i.test(body);

/**
 * Asks a cheap model with OpenRouter's web search tool for URLs. It never fetches a page and never scores anything.
 * The request asks for zero data retention and no data collection. If no provider can serve it that way, the call is repeated without ZDR,
 * `warn` is called once, and the result says `zdr: false`, so the audit row shows it. Any other failure is thrown.
 */
export function createDiscoverer(options: { apiKey: string; model?: string; baseURL?: string; maxResults?: number; fetch?: typeof fetch; warn?: (message: string) => void; now?: () => number }) {
  if (!options.apiKey.trim()) throw new Error('OpenRouter API key is required');
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseURL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const model = options.model ?? discoveryModel;
  const now = options.now ?? (() => performance.now());
  async function post(prompt: string, zdr: boolean) {
    const params = { model, plugins: [{ id: 'web', max_results: options.maxResults ?? 5 }], provider: { ...(zdr ? { zdr: true } : {}), data_collection: 'deny', allow_fallbacks: false }, max_tokens: 800 };
    const response = await fetcher(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...params, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(90_000) });
    return { response, params, text: await response.text() };
  }
  return {
    model,
    async discover(prompt: string): Promise<DiscoveryResult> {
      if (!prompt.trim()) throw new Error('A discovery prompt is required');
      const started = now();
      let zdr = true;
      let attempt = await post(prompt, true);
      if (!attempt.response.ok && zdrUnavailable(attempt.response.status, attempt.text)) {
        options.warn?.(`No provider for ${model} honors zero data retention with web search, so the call continues without ZDR. Data collection is still denied.`);
        zdr = false;
        attempt = await post(prompt, false);
      }
      if (!attempt.response.ok) throw new Error(`Discovery call failed with HTTP ${attempt.response.status}: ${attempt.text.slice(0, 200)}`);
      const parsed = responseSchema.parse(JSON.parse(attempt.text));
      const message = parsed.choices[0]!.message;
      return {
        text: message.content ?? '', citedUrls: (message.annotations ?? []).flatMap(a => a.url_citation ? [a.url_citation.url] : []),
        model: parsed.model ?? model, provider: parsed.provider ?? null, zdr, cost: parsed.usage?.cost ?? null, usage: parsed.usage ?? null,
        latencyMs: Math.round(now() - started), params: attempt.params,
      };
    },
  };
}
