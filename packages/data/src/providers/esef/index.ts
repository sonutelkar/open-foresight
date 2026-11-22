import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { esefDocuments, esefFilings, leiIsins } from '@open-foresight/db';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';

export type EsefSyncInput = { /** Issuers by LEI. */ leis?: string[]; /** Issuers found through GLEIF from an ISIN. */ isins?: string[]; /** Newest filings to read per issuer. Default 1. */ perLei?: number };
export type EsefSyncReport = {
  source: 'esef'; leis: number; filings: number; inserted: number;
  unresolvedIsins: string[]; noFilings: string[]; tooLarge: string[];
  /** Filings whose index entry has no published date, so the date the index added them is used. */
  availableFromDateAdded: number; bytes: number; ingestedAt: Date;
};

const lei = z.string().regex(/^[A-Z0-9]{18}[0-9]{2}$/);
const isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/);
const inputSchema = z.object({ leis: z.array(lei).max(2000).optional(), isins: z.array(isin).max(2000).optional(), perLei: z.number().int().min(1).max(10).optional() }).refine(v => (v.leis?.length ?? 0) + (v.isins?.length ?? 0) > 0, 'Give at least one LEI or ISIN');
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/);
const indexResponse = z.object({
  data: z.array(z.object({ attributes: z.object({ fxo_id: z.string().min(1), period_end: z.string().date(), country: z.string().min(2), published: stamp.nullish(), date_added: stamp, sha256: z.string().min(1), report_url: z.string().startsWith('/') }).passthrough(), relationships: z.object({ entity: z.object({ data: z.object({ id: z.string() }) }) }) })),
  included: z.array(z.object({ id: z.string(), attributes: z.object({ name: z.string().nullish(), identifier: z.string().nullish() }).passthrough() })).default([]),
});
const gleifPage = z.object({ data: z.array(z.object({ id: z.string(), attributes: z.object({ isin: z.string().optional() }).passthrough().optional() })), meta: z.object({ pagination: z.object({ currentPage: z.number(), lastPage: z.number() }) }).optional() });
const utc = (value: string) => new Date(`${value.replace(' ', 'T')}Z`);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const maxBodyBytes = 64 * 1024 * 1024;

/**
 * Reads ESEF annual reports from the filings.xbrl.org index, and the ISINs GLEIF lists for each issuer.
 * Free and keyless. The index has no filings for Germany or Switzerland.
 */
export function createEsefProvider(options: { db: PostgresJsDatabase; fetch?: typeof fetch; indexUrl?: string; gleifUrl?: string; now?: () => Date }): DataProvider<EsefSyncInput, EsefSyncReport> {
  const fetcher = options.fetch ?? fetch;
  const index = (options.indexUrl ?? 'https://filings.xbrl.org').replace(/\/$/, '');
  const gleif = (options.gleifUrl ?? 'https://api.gleif.org').replace(/\/$/, '');
  const now = options.now ?? (() => new Date());

  async function get(url: string, label: string): Promise<string | 'missing'> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try { response = await fetcher(url, { headers: { 'user-agent': 'open-foresight-educational' }, signal: AbortSignal.timeout(120_000) }); }
      catch (error) {
        if (attempt === 2 || (error instanceof Error && error.name === 'AbortError')) throw new Error(`${label} request failed`);
        await sleep(1000 * (attempt + 1)); continue;
      }
      if (response.status === 404) return 'missing';
      if (response.ok) {
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBodyBytes) throw new Error(`${label} is larger than ${maxBodyBytes} bytes`);
        return response.text();
      }
      if ((response.status !== 429 && response.status < 500) || attempt === 2) throw new Error(`${label} returned HTTP ${response.status}`);
      await sleep(1000 * (attempt + 1));
    }
    throw new Error(`${label} request failed`);
  }
  async function getJson<S extends z.ZodTypeAny>(url: string, label: string, schema: S): Promise<z.infer<S> | 'missing'> {
    const text = await get(url, label);
    return text === 'missing' ? 'missing' : schema.parse(JSON.parse(text));
  }

  return {
    id: 'esef', capabilities: ['filings'] as const,
    async sync(input) {
      const parsed = inputSchema.parse(input);
      const perLei = parsed.perLei ?? 1;
      const ingestedAt = now();
      const observed: Array<{ lei: string; isin: string }> = [];
      const unresolvedIsins: string[] = [];
      const leis = new Set(parsed.leis ?? []);
      for (const code of new Set(parsed.isins ?? [])) {
        const found = await getJson(`${gleif}/api/v1/lei-records?${new URLSearchParams({ 'filter[isin]': code, 'page[size]': '5' })}`, 'GLEIF ISIN lookup', gleifPage);
        const ids = found === 'missing' ? [] : found.data.map(d => d.id).filter(id => lei.safeParse(id).success);
        if (ids.length === 0) unresolvedIsins.push(code);
        for (const id of ids) { leis.add(id); observed.push({ lei: id, isin: code }); }
      }
      const filings: Array<{ fxoId: string; lei: string; entityName: string; country: string; periodEnd: string; published: Date | null; dateAdded: Date; reportUrl: string; packageSha256: string; body: string }> = [];
      const noFilings: string[] = [], tooLarge: string[] = [];
      let bytes = 0;
      for (const id of [...leis].sort()) {
        for (let page = 1; ; page++) {
          const found = await getJson(`${gleif}/api/v1/lei-records/${id}/isins?${new URLSearchParams({ 'page[size]': '100', 'page[number]': String(page) })}`, 'GLEIF ISIN list', gleifPage);
          if (found === 'missing') break;
          for (const row of found.data) if (row.attributes?.isin && isin.safeParse(row.attributes.isin).success) observed.push({ lei: id, isin: row.attributes.isin });
          if (!found.meta || found.meta.pagination.currentPage >= found.meta.pagination.lastPage) break;
        }
        const list = await getJson(`${index}/api/filings?${new URLSearchParams({ 'filter[entity.identifier]': id, sort: '-period_end', 'page[size]': String(perLei), include: 'entity' })}`, 'ESEF index', indexResponse);
        if (list === 'missing' || list.data.length === 0) { noFilings.push(id); continue; }
        const names = new Map(list.included.map(e => [e.id, e.attributes.name ?? id]));
        for (const item of list.data) {
          const a = item.attributes;
          let body: string | 'missing';
          try { body = await get(`${index}${a.report_url}`, 'ESEF report'); }
          catch (error) { if (error instanceof Error && error.message.includes('larger than')) { tooLarge.push(a.fxo_id); continue; } throw error; }
          if (body === 'missing') throw new Error(`ESEF report for ${a.fxo_id} was not found`);
          if (Buffer.byteLength(body) > maxBodyBytes) { tooLarge.push(a.fxo_id); continue; }
          bytes += Buffer.byteLength(body);
          filings.push({ fxoId: a.fxo_id, lei: id, entityName: names.get(item.relationships.entity.data.id) ?? id, country: a.country, periodEnd: a.period_end, published: a.published ? utc(a.published) : null, dateAdded: utc(a.date_added), reportUrl: a.report_url, packageSha256: a.sha256, body });
        }
      }
      const unique = [...new Map(observed.map(o => [`${o.lei}/${o.isin}`, o])).values()];
      const inserted = await options.db.transaction(async tx => {
        for (let i = 0; i < unique.length; i += 1000) {
          await tx.insert(leiIsins).values(unique.slice(i, i + 1000).map(o => ({ lei: o.lei, isin: o.isin, source: 'gleif', observedAt: ingestedAt })))
            .onConflictDoUpdate({ target: [leiIsins.lei, leiIsins.isin, leiIsins.source], set: { observedAt: ingestedAt } });
        }
        let count = 0;
        for (const f of filings) {
          const availableAt = f.published ?? f.dateAdded;
          const [saved] = await tx.insert(esefFilings).values({ fxoId: f.fxoId, lei: f.lei, entityName: f.entityName, country: f.country, periodEnd: f.periodEnd, availableOn: availableAt.toISOString().slice(0, 10), availableSource: f.published ? 'published' : 'date_added', publishedAt: f.published, dateAddedAt: f.dateAdded, reportUrl: f.reportUrl, packageSha256: f.packageSha256, ingestedAt })
            .onConflictDoNothing().returning({ id: esefFilings.id });
          if (!saved) continue;
          await tx.insert(esefDocuments).values({ filingId: saved.id, sha256: digest(f.body), body: f.body, fetchedAt: ingestedAt });
          count++;
        }
        return count;
      });
      return { source: 'esef', leis: leis.size, filings: filings.length, inserted, unresolvedIsins, noFilings, tooLarge, availableFromDateAdded: filings.filter(f => !f.published).length, bytes, ingestedAt };
    },
  };
}

export async function findEsefFiling(db: PostgresJsDatabase, fxoId: string) {
  const [found] = await db.select().from(esefFilings).where(eq(esefFilings.fxoId, fxoId));
  return found;
}
