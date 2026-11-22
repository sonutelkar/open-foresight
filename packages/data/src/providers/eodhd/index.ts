import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { priceBars } from '@open-foresight/db';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';

export type EodhdSyncInput = { symbols: string[]; from: string; to: string };
export type EodhdSyncReport = {
  source: 'eodhd'; symbols: number; fetched: number; inserted: number;
  /** Symbols EODHD answered with an empty list. */
  empty: string[];
  /** Symbols EODHD does not know (HTTP 404). */
  unknown: string[];
  /** Rows dropped because they had no close price. */
  skippedRows: number;
  ingestedAt: Date;
};

const symbolSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z]{1,6}$/);
const dateSchema = z.string().date();
const inputSchema = z.object({ symbols: z.array(symbolSchema).min(1).max(5000), from: dateSchema, to: dateSchema });
const num = z.number().finite().nullable();
const rowSchema = z.object({ date: dateSchema, open: num.optional(), high: num.optional(), low: num.optional(), close: num, adjusted_close: num.optional(), volume: num.optional() }).passthrough();
const responseSchema = z.array(z.unknown());
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Returns undefined without an API key, so the open-data path never depends on EODHD. */
export function createEodhdProvider(options: {
  db: PostgresJsDatabase;
  apiKey?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => Date;
}): DataProvider<EodhdSyncInput, EodhdSyncReport> | undefined {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return undefined;
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://eodhd.com').replace(/\/$/, '');

  async function load(symbol: string, from: string, to: string): Promise<unknown[] | 'unknown'> {
    const url = `${base}/api/eod/${encodeURIComponent(symbol)}?${new URLSearchParams({ api_token: apiKey!, fmt: 'json', from, to })}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try { response = await fetcher(url, { signal: AbortSignal.timeout(30_000) }); }
      catch (error) {
        if (attempt === 2 || (error instanceof Error && error.name === 'AbortError')) throw new Error(`EODHD request for ${symbol} failed`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (response.ok) return responseSchema.parse(await response.json());
      if (response.status === 404) return 'unknown';
      if ((response.status !== 429 && response.status < 500) || attempt === 2) throw new Error(`EODHD returned HTTP ${response.status} for ${symbol}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 60) throw new Error('EODHD retry-after exceeds 60 seconds');
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));
    }
    throw new Error(`EODHD request for ${symbol} failed`);
  }

  return {
    id: 'eodhd', capabilities: ['prices'] as const,
    async sync(input) {
      const parsed = inputSchema.parse(input);
      if (parsed.from > parsed.to) throw new Error('EODHD from date is after to date');
      const symbols = [...new Set(parsed.symbols)];
      const rows: Array<typeof priceBars.$inferInsert> = [];
      const empty: string[] = [], unknown: string[] = [];
      let skippedRows = 0;
      const ingestedAt = (options.now ?? (() => new Date()))();
      for (const symbol of symbols) {
        const body = await load(symbol, parsed.from, parsed.to);
        if (body === 'unknown') { unknown.push(symbol); continue; }
        if (body.length === 0) { empty.push(symbol); continue; }
        for (const item of body) {
          const row = rowSchema.parse(item);
          if (row.close === null) { skippedRows++; continue; }
          const text = (value: number | null | undefined) => value === null || value === undefined ? null : String(value);
          rows.push({ source: 'eodhd', symbol, date: row.date, open: text(row.open), high: text(row.high), low: text(row.low), close: String(row.close), adjustedClose: text(row.adjusted_close), volume: text(row.volume), contentHash: digest(JSON.stringify(row)), raw: row, ingestedAt });
        }
      }
      const inserted = await options.db.transaction(async tx => {
        let count = 0;
        for (let i = 0; i < rows.length; i += 1000) count += (await tx.insert(priceBars).values(rows.slice(i, i + 1000)).onConflictDoNothing().returning({ id: priceBars.id })).length;
        return count;
      });
      return { source: 'eodhd', symbols: symbols.length, fetched: rows.length, inserted, empty, unknown, skippedRows, ingestedAt };
    },
  };
}
