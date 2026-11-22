import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { marketCapObservations } from '@open-foresight/db';
import { yahooSymbol } from '@open-foresight/core';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';

export type ApifyMarketCapInput = { symbols: string[] };
export type ApifyMarketCapReport = {
  source: 'apify_yahoo'; requested: number; observed: number;
  /** Symbols with no market cap in the output, or no Yahoo mapping. */
  missing: string[]; unsupported: string[]; batches: number; observedAt: Date;
};

const symbolSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z]{1,6}$/);
const inputSchema = z.object({ symbols: z.array(symbolSchema).min(1).max(5000) });
const item = z.object({
  ticker: z.string().min(1),
  /** The actor writes the string "N/A" for a value Yahoo did not return. */
  stock_info: z.object({ market_cap: z.union([z.number(), z.string()]).nullish(), current_price: z.union([z.number(), z.string()]).nullish() }).passthrough().nullish(),
}).passthrough();
const defaultActor = 'architjn~yahoo-finance';

/**
 * Reads current market caps through an Apify actor that scrapes Yahoo Finance.
 * Off without a token. Yahoo's terms bar automated collection, so this is for personal, educational use.
 * Each batch has a hard spend cap, and the actor charges per result.
 */
export function createApifyMarketCapProvider(options: {
  db: PostgresJsDatabase; token?: string; fetch?: typeof fetch; baseUrl?: string; actor?: string;
  batchSize?: number; maxChargeUsdPerBatch?: number; now?: () => Date;
}): DataProvider<ApifyMarketCapInput, ApifyMarketCapReport> | undefined {
  const token = options.token?.trim();
  if (!token) return undefined;
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://api.apify.com').replace(/\/$/, '');
  const actor = options.actor ?? defaultActor;
  const batchSize = options.batchSize ?? 25;
  const cap = options.maxChargeUsdPerBatch ?? 0.25;
  if (!(batchSize >= 1) || !(cap > 0)) throw new Error('Apify batch size and spend cap must be positive');
  const day = 86_400_000;

  return {
    id: 'apify_yahoo', capabilities: ['prices'] as const,
    async sync(input) {
      const parsed = inputSchema.parse(input);
      const wanted = new Map<string, string>();
      const unsupported: string[] = [];
      for (const symbol of new Set(parsed.symbols)) {
        const yahoo = yahooSymbol(symbol);
        if (yahoo) wanted.set(symbol, yahoo); else unsupported.push(symbol);
      }
      const rows: Array<typeof marketCapObservations.$inferInsert> = [];
      const missing: string[] = [];
      const entries = [...wanted];
      let batches = 0;
      for (let offset = 0; offset < entries.length; offset += batchSize) {
        const batch = entries.slice(offset, offset + batchSize);
        const today = (options.now ?? (() => new Date()))();
        const url = `${base}/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?${new URLSearchParams({ maxTotalChargeUsd: String(cap), timeout: '240', format: 'json' })}`;
        let response: Response;
        try {
          response = await fetcher(url, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ tickers: batch.map(([, yahoo]) => yahoo), start_date: new Date(today.getTime() - 5 * day).toISOString().slice(0, 10), end_date: today.toISOString().slice(0, 10) }),
            signal: AbortSignal.timeout(290_000),
          });
        } catch { throw new Error('Apify request failed'); }
        if (!response.ok) throw new Error(`Apify returned HTTP ${response.status}`);
        const items = z.array(item).parse(await response.json());
        batches++;
        const byTicker = new Map(items.map(i => [i.ticker, i]));
        const observedAt = (options.now ?? (() => new Date()))();
        for (const [symbol, yahoo] of batch) {
          const found = byTicker.get(yahoo)?.stock_info;
          const marketCap = found?.market_cap;
          if (typeof marketCap !== 'number' || !Number.isFinite(marketCap) || !(marketCap > 0)) { missing.push(symbol); continue; }
          const price = found?.current_price;
          rows.push({ source: 'apify_yahoo', symbol, sourceSymbol: yahoo, marketCap: String(marketCap), price: typeof price === 'number' && Number.isFinite(price) ? String(price) : null, observedAt });
        }
      }
      const observedAt = (options.now ?? (() => new Date()))();
      if (rows.length) await options.db.insert(marketCapObservations).values(rows);
      return { source: 'apify_yahoo', requested: parsed.symbols.length, observed: rows.length, missing, unsupported, batches, observedAt };
    },
  };
}
