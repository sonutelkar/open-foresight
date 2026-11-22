import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { exchangeListings } from '@open-foresight/db';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';
import { mapOpenFigi, requestJson, resolveIsin, upsertSecurity, type Candidate } from '../../openfigi.js';

export type EodhdListingsInput = { exchanges: string[]; /** Full symbols such as `SAP.XETRA`. Limits the sync to these. */ only?: string[] };
export type EodhdListingsReport = { source: 'eodhd'; observedAt: Date; listings: number; resolved: number; ambiguous: number; unmatched: number; noIsin: number };

const exchangeCode = z.string().regex(/^[A-Za-z0-9]{1,8}$/);
const inputSchema = z.object({ exchanges: z.array(exchangeCode).min(1).max(50), only: z.array(z.string().min(3)).optional() });
const row = z.object({ Code: z.string().min(1), Name: z.string().min(1), Exchange: z.string().min(1), Type: z.string(), Currency: z.string().nullish(), Isin: z.string().nullish() }).passthrough();
const isin = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/**
 * Links EODHD common-stock listings to securities through OpenFIGI.
 * The ISIN maps to one share class. Every venue listing of that class shares one security.
 * Returns undefined without an EODHD key.
 */
export function createEodhdListingsProvider(options: {
  db: PostgresJsDatabase; apiKey?: string; openFigiApiKey?: string;
  fetch?: typeof fetch; baseUrl?: string; openFigiUrl?: string; now?: () => Date;
}): DataProvider<EodhdListingsInput, EodhdListingsReport> | undefined {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return undefined;
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://eodhd.com').replace(/\/$/, '');
  return {
    id: 'eodhd_listings', capabilities: ['securities'] as const,
    async sync(input) {
      const parsed = inputSchema.parse(input);
      const only = parsed.only ? new Set(parsed.only) : undefined;
      const listings: Array<{ symbol: string; exchange: string; name: string; type: string; currency: string | null; isin: string | null }> = [];
      for (const exchange of [...new Set(parsed.exchanges)]) {
        const url = `${base}/api/exchange-symbol-list/${exchange}?${new URLSearchParams({ api_token: apiKey, fmt: 'json' })}`;
        let body: unknown;
        try { body = await requestJson(fetcher, url, { signal: AbortSignal.timeout(60_000) }); }
        catch (error) { throw new Error(`EODHD symbol list for ${exchange} failed: ${error instanceof Error ? error.message.replace(apiKey, '') : 'error'}`); }
        for (const item of z.array(row).parse(body)) {
          if (item.Type !== 'Common Stock') continue;
          const symbol = `${item.Code}.${exchange}`;
          if (only && !only.has(symbol)) continue;
          const code = item.Isin?.trim().toUpperCase() ?? '';
          listings.push({ symbol, exchange, name: item.Name, type: item.Type, currency: item.Currency ?? null, isin: isin.test(code) ? code : null });
        }
      }
      const withIsin = listings.filter(l => l.isin);
      const isins = [...new Set(withIsin.map(l => l.isin as string))];
      const mapped = await mapOpenFigi({ fetcher, url: options.openFigiUrl, apiKey: options.openFigiApiKey, jobs: isins.map(idValue => ({ idType: 'ID_ISIN' as const, idValue, marketSecDes: 'Equity' })) });
      const byIsin = new Map<string, Candidate[]>(isins.map((value, i) => [value, mapped[i] ?? []]));
      const observedAt = (options.now ?? (() => new Date()))();
      const counts = { resolved: 0, ambiguous: 0, unmatched: 0, noIsin: 0 };
      await options.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(746352, 7)`);
        for (const listing of listings) {
          let status: 'resolved' | 'ambiguous' | 'unmatched' | 'no_isin' = 'no_isin';
          let securityId: string | null = null;
          let shareClasses: unknown[] = [];
          if (listing.isin) {
            const candidates = byIsin.get(listing.isin) ?? [];
            const resolution = resolveIsin(candidates);
            status = resolution.status;
            shareClasses = resolution.classes;
            if (resolution.status === 'resolved') {
              const first = candidates.find(c => c.shareClassFIGI === resolution.shareClassFigi);
              if (!first) throw new Error('Resolved share class has no candidate');
              securityId = await upsertSecurity(tx, { figi: first.figi, name: resolution.name, shareClassFIGI: resolution.shareClassFigi });
            }
          }
          if (status === 'resolved') counts.resolved++; else if (status === 'ambiguous') counts.ambiguous++; else if (status === 'unmatched') counts.unmatched++; else counts.noIsin++;
          await tx.insert(exchangeListings).values({ source: 'eodhd', ...listing, status, securityId, shareClasses, observedAt })
            .onConflictDoUpdate({ target: [exchangeListings.source, exchangeListings.symbol], set: { exchange: listing.exchange, name: listing.name, type: listing.type, isin: listing.isin, currency: listing.currency, status, securityId, shareClasses, observedAt } });
        }
      });
      return { source: 'eodhd', observedAt, listings: listings.length, ...counts };
    },
  };
}

export async function findListing(db: PostgresJsDatabase, symbol: string) {
  const [found] = await db.select().from(exchangeListings).where(eq(exchangeListings.symbol, symbol));
  return found;
}
