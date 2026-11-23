import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { webDocuments } from '@open-foresight/db';
import { yahooSymbol } from '@open-foresight/core';
import type { DataProvider } from '../../index.js';
import { uvRunner, type YahooRunner } from './index.js';

/** The content type that marks a stored company profile. The indexer gives these chunks the `company_profile` kind, which only the exposure check reads. */
export const profileContentType = 'text/x-company-profile';
const minSummaryChars = 200;

export type ProfileInput = { items: Array<{ symbol: string; issuerKey: string; entityName: string }> };
export type ProfileReport = { stored: string[]; unchanged: string[]; missing: string[]; unsupported: string[]; rateLimited: boolean };

const line = z.object({ symbol: z.string(), yahoo: z.string(), name: z.string().nullish(), sector: z.string().nullish(), industry: z.string().nullish(), summary: z.string().nullish(), error: z.string().optional() });
const itemSchema = z.object({ symbol: z.string().min(1), issuerKey: z.string().regex(/^(lei|cik):[A-Z0-9]+$/), entityName: z.string().trim().min(1) });

/** The stored text: what the company is called and does, in Yahoo's words. */
export const profileText = (p: { name?: string | null; sector?: string | null; industry?: string | null; summary: string }) =>
  [p.name, [p.sector && `Sector: ${p.sector}`, p.industry && `Industry: ${p.industry}`].filter(Boolean).join('. ')].filter(Boolean).join('\n') + `\n\n${p.summary.trim()}`;

/**
 * Stores Yahoo Finance business summaries for companies that have no filing in the store, so the Jev exposure check can judge them.
 * A profile is a short description from a third party, not a filing, so it is stored as its own kind and never offered to the Analyst as evidence for a KPI.
 * Yahoo's terms bar automated collection, so this is for personal, educational use. It never retries a rate limit. The row is dated by its fetch day.
 */
export function createYahooProfileProvider(options: { db: PostgresJsDatabase; run?: YahooRunner; now?: () => Date }): DataProvider<ProfileInput, ProfileReport> {
  const run = options.run ?? uvRunner({ script: 'profile.py' });
  return {
    id: 'yahoo_profile', capabilities: ['filings'] as const,
    async sync(input) {
      const items = z.array(itemSchema).min(1).max(500).parse(input.items);
      const send: Array<{ symbol: string; yahoo: string }> = [];
      const unsupported: string[] = [];
      for (const item of items) { const yahoo = yahooSymbol(item.symbol); if (yahoo) send.push({ symbol: item.symbol, yahoo }); else unsupported.push(item.symbol); }
      const result = send.length ? await run(send) : { lines: [], exitCode: 0, stderr: '' };
      if (result.exitCode !== 0 && result.exitCode !== 3) throw new Error(`Yahoo profile reader failed with exit code ${result.exitCode}: ${result.stderr.slice(-200)}`);
      const report: ProfileReport = { stored: [], unchanged: [], missing: [], unsupported, rateLimited: result.exitCode === 3 };
      const now = (options.now ?? (() => new Date()))();
      for (const text of result.lines) {
        const l = line.parse(JSON.parse(text));
        if (l.error === 'rate_limited') { report.rateLimited = true; continue; }
        const item = items.find(i => i.symbol === l.symbol);
        if (!item || l.error || !l.summary || l.summary.trim().length < minSummaryChars) { report.missing.push(l.symbol); continue; }
        const body = profileText({ name: l.name, sector: l.sector, industry: l.industry, summary: l.summary });
        const url = `yahoo-finance://profile/${l.yahoo}`;
        const [row] = await options.db.insert(webDocuments).values({
          url, finalUrl: url, contentType: profileContentType, byteSize: Buffer.byteLength(body), rawSha256: createHash('sha256').update(body).digest('hex'),
          text: body, headings: [{ offset: 0, level: 1, title: 'Company profile' }], extractor: 'yahoo-yfinance',
          issuerKey: item.issuerKey, entityName: item.entityName, fetchedAt: now, availableOn: now.toISOString().slice(0, 10),
        }).onConflictDoNothing().returning({ id: webDocuments.id });
        (row ? report.stored : report.unchanged).push(l.symbol);
      }
      return report;
    },
  };
}
