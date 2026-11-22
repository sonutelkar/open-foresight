import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { securities } from '@open-foresight/db';
import { z } from 'zod';

export const candidate = z.object({
  figi: z.string().min(1), name: z.string().min(1),
  ticker: z.string().optional(), exchCode: z.string().optional(),
  securityType: z.string().optional(), securityType2: z.string().optional(),
  shareClassFIGI: z.string().min(1).nullish(), compositeFIGI: z.string().min(1).nullish(),
}).passthrough();
export type Candidate = z.infer<typeof candidate>;
const mappingResponse = z.array(z.union([
  z.object({ data: z.array(candidate).min(1) }),
  z.object({ warning: z.string().min(1) }),
  z.object({ error: z.string().min(1) }),
]));

type Fetch = typeof fetch;
export async function requestJson(fetcher: Fetch, url: string, init: RequestInit): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch (error) {
      if (attempt === 2 || (error instanceof Error && error.name === 'AbortError')) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500) throw new Error(`Provider returned HTTP ${response.status}`);
    if (attempt === 2) throw new Error(`Provider returned HTTP ${response.status} after retries`);
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 60) throw new Error(`Provider retry-after exceeds 60 seconds: ${seconds}`);
    await new Promise(resolve => setTimeout(resolve, Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : 1000 * (attempt + 1)));
  }
  throw new Error('Provider request failed');
}

export type OpenFigiJob = { idType: 'TICKER' | 'ID_ISIN'; idValue: string; exchCode?: string; marketSecDes?: string };

/** Maps jobs in OpenFIGI batches. Results align with `jobs`. A warning (no match) gives an empty list. */
export async function mapOpenFigi(input: { fetcher: Fetch; url?: string; apiKey?: string; jobs: OpenFigiJob[] }): Promise<Candidate[][]> {
  const batchSize = input.apiKey ? 100 : 10;
  const out: Candidate[][] = [];
  for (let offset = 0; offset < input.jobs.length; offset += batchSize) {
    if (offset > 0) await new Promise(resolve => setTimeout(resolve, input.apiKey ? 250 : 2500));
    const batch = input.jobs.slice(offset, offset + batchSize);
    const raw = await requestJson(input.fetcher, input.url ?? 'https://api.openfigi.com/v3/mapping', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(input.apiKey ? { 'X-OPENFIGI-APIKEY': input.apiKey } : {}) }, body: JSON.stringify(batch),
    });
    const mappings = mappingResponse.parse(raw);
    if (mappings.length !== batch.length) throw new Error('OpenFIGI returned a mismatched result count');
    for (const mapping of mappings) {
      if ('error' in mapping) throw new Error(`OpenFIGI mapping error: ${mapping.error}`);
      out.push('data' in mapping ? mapping.data : []);
    }
  }
  return out;
}

export type IsinResolution =
  | { status: 'resolved'; shareClassFigi: string; name: string; classes: Array<{ shareClassFigi: string; name: string; venues: number }> }
  | { status: 'ambiguous' | 'unmatched'; classes: Array<{ shareClassFigi: string; name: string; venues: number }> };

/** An ISIN names one share class. OpenFIGI returns one candidate per venue, all with the same shareClassFIGI. */
export function resolveIsin(candidates: Candidate[]): IsinResolution {
  const classes = new Map<string, { shareClassFigi: string; name: string; venues: number }>();
  for (const item of candidates) {
    if (!item.shareClassFIGI) continue;
    const seen = classes.get(item.shareClassFIGI);
    if (seen) seen.venues++; else classes.set(item.shareClassFIGI, { shareClassFigi: item.shareClassFIGI, name: item.name, venues: 1 });
  }
  const list = [...classes.values()];
  const [only] = list;
  if (list.length === 1 && only) return { status: 'resolved', shareClassFigi: only.shareClassFigi, name: only.name, classes: list };
  return { status: list.length === 0 ? 'unmatched' : 'ambiguous', classes: list };
}

/** A security is one share class. Candidates without a shareClassFIGI are keyed by their listing FIGI. */
export async function upsertSecurity(tx: PostgresJsDatabase, item: Pick<Candidate, 'figi' | 'name' | 'shareClassFIGI'>): Promise<string> {
  const [existing] = await tx.select({ id: securities.id }).from(securities).where(item.shareClassFIGI ? eq(securities.shareClassFigi, item.shareClassFIGI) : eq(securities.figi, item.figi));
  if (existing) {
    await tx.update(securities).set({ name: item.name }).where(eq(securities.id, existing.id));
    return existing.id;
  }
  const [created] = await tx.insert(securities).values({ figi: item.figi, shareClassFigi: item.shareClassFIGI ?? null, name: item.name }).returning({ id: securities.id });
  if (!created) throw new Error('Could not save security');
  return created.id;
}

