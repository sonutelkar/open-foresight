import { eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { figiMappings, secListings, securities } from '@open-foresight/db';
import { z } from 'zod';
import { candidate, mapOpenFigi, requestJson, upsertSecurity } from './openfigi.js';

type Fetch = typeof fetch;

export type Capability = 'securities' | 'prices' | 'fundamentals' | 'segments' | 'filings' | 'news' | 'transcripts' | 'patents' | 'papers' | 'policy';
export type SyncReport = { source: string; observedAt: Date; records: number; resolved: number; ambiguous: number; unmatched: number; reclassified: number };
export interface DataProvider<TInput = void, TReport = SyncReport> {
  readonly id: string;
  readonly capabilities: readonly Capability[];
  sync(input: TInput): Promise<TReport>;
}

const secResponse = z.object({
  fields: z.tuple([z.literal('cik'), z.literal('name'), z.literal('ticker'), z.literal('exchange')]),
  data: z.array(z.tuple([z.number().int().positive().max(9999999999), z.string().min(1), z.string().min(1), z.string().nullable()])).min(1),
});
export function parseSecListings(raw: unknown) {
  const rows = secResponse.parse(raw).data;
  const unique = new Map<string, { cik: string; name: string; ticker: string; exchange: string }>();
  for (const [cik, name, ticker, exchange] of rows) {
    const row = { cik: String(cik).padStart(10, '0'), name, ticker, exchange: exchange || 'UNKNOWN' };
    unique.set(JSON.stringify([row.cik, row.ticker, row.exchange]), row);
  }
  return [...unique.values()];
}

export function createSecSecurityProvider(options: {
  db: PostgresJsDatabase;
  userAgent: string;
  fetch?: Fetch;
  openFigiApiKey?: string;
  secUrl?: string;
  openFigiUrl?: string;
  now?: () => Date;
}): DataProvider {
  if (!options.userAgent.trim()) throw new Error('SEC user agent is required');
  const fetcher = options.fetch ?? fetch;
  return {
    id: 'sec_openfigi', capabilities: ['securities'],
    async sync() {
      const raw = await requestJson(fetcher, options.secUrl ?? 'https://www.sec.gov/files/company_tickers_exchange.json', { headers: { 'User-Agent': options.userAgent, accept: 'application/json' } });
      const listings = parseSecListings(raw);
      const tickerIssuers = new Map<string, Set<string>>();
      for (const listing of listings) {
        const issuers = tickerIssuers.get(listing.ticker) ?? new Set<string>();
        issuers.add(listing.cik);
        tickerIssuers.set(listing.ticker, issuers);
      }
      const gathered: Array<{ listing: typeof listings[number]; candidates: z.infer<typeof candidate>[] }> = [];
      const results = await mapOpenFigi({ fetcher, url: options.openFigiUrl, apiKey: options.openFigiApiKey, jobs: listings.map(row => ({ idType: 'TICKER' as const, idValue: row.ticker, exchCode: 'US' })) });
      listings.forEach((listing, index) => gathered.push({ listing, candidates: results[index] ?? [] }));
      const figiIssuers = new Map<string, Set<string>>();
      for (const { listing, candidates } of gathered) {
        const unique = [...new Map(candidates.map(item => [item.figi, item])).values()];
        const item = unique[0];
        if (unique.length === 1 && item && item.ticker === listing.ticker && item.exchCode === 'US') {
          const issuers = figiIssuers.get(item.figi) ?? new Set<string>();
          issuers.add(listing.cik);
          figiIssuers.set(item.figi, issuers);
        }
      }
      const observedAt = (options.now ?? (() => new Date()))();
      const counts = await options.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(746352, 7)`);
        const existing = await tx.select({ mappingId: figiMappings.id, cik: secListings.cik, ticker: secListings.ticker, candidates: figiMappings.candidates, securityId: figiMappings.securityId })
          .from(figiMappings).innerJoin(secListings, eq(figiMappings.listingId, secListings.id));
        const existingCandidates = existing.map(row => {
          const parsed = z.array(candidate).parse(row.candidates);
          const unique = [...new Map(parsed.map(item => [item.figi, item])).values()];
          const sole = unique[0];
          return { ...row, claim: unique.length === 1 && sole?.ticker === row.ticker && sole.exchCode === 'US' ? sole : undefined };
        });
        for (const row of existingCandidates) {
          if (row.claim) figiIssuers.get(row.claim.figi)?.add(row.cik);
        }
        const conflicts = existingCandidates.filter(row => row.securityId !== null && row.claim && (figiIssuers.get(row.claim.figi)?.size ?? 0) > 1).map(row => row.mappingId);
        for (let offset = 0; offset < conflicts.length; offset += 1000) {
          await tx.update(figiMappings).set({ securityId: null, observedAt }).where(inArray(figiMappings.id, conflicts.slice(offset, offset + 1000)));
        }
        let resolved = 0, ambiguous = 0, unmatched = 0;
        for (const { listing, candidates } of gathered) {
          const unique = [...new Map(candidates.map(item => [item.figi, item])).values()];
          const issuerConflict = (tickerIssuers.get(listing.ticker)?.size ?? 0) > 1 || unique.some(item => (figiIssuers.get(item.figi)?.size ?? 0) > 1);
          const sole = unique[0];
          const mismatched = sole !== undefined && (sole.ticker !== listing.ticker || sole.exchCode !== 'US');
          const isAmbiguous = issuerConflict || unique.length > 1 || mismatched;
          const [saved] = await tx.insert(secListings).values({ ...listing, observedAt }).onConflictDoUpdate({ target: [secListings.cik, secListings.ticker, secListings.exchange], set: { name: listing.name, observedAt } }).returning();
          if (!saved) throw new Error('Could not save SEC listing');
          let securityId: string | null = null;
          if (!isAmbiguous && sole) {
            securityId = await upsertSecurity(tx, sole);
          }
          await tx.insert(figiMappings).values({ listingId: saved.id, securityId, candidates, observedAt }).onConflictDoUpdate({ target: figiMappings.listingId, set: { securityId, candidates, observedAt } });
          if (isAmbiguous) ambiguous++; else if (sole) resolved++; else unmatched++;
        }
        return { resolved, ambiguous, unmatched, reclassified: conflicts.length };
      });
      return { source: 'sec_openfigi', observedAt, records: listings.length, ...counts };
    },
  };
}

export async function findSecurityMapping(db: PostgresJsDatabase, listingId: string) {
  const [mapping] = await db.select().from(figiMappings).where(eq(figiMappings.listingId, listingId));
  return mapping;
}

export * from "./providers/sec-edgar/index.js";
export * from './providers/eodhd/index.js';
export * from './universe.js';
export * from './providers/ecb/index.js';
export * from './fx.js';
export * from './openfigi.js';
export * from './providers/eodhd/listings.js';
export * from './providers/apify/index.js';
export * from './providers/yahoo/index.js';
