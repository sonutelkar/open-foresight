import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { secFacts, secFilings, secSourceDocuments } from '@open-foresight/db';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';

export type SecEdgarSyncInput = { cik: string; accessions: string[] };
export type SecEdgarSyncReport = { cik: string; filings: number; facts: number; ingestedAt: Date };

const date = z.string().date();
const accession = z.string().regex(/^\d{10}-\d{2}-\d{6}$/);
const primaryDocument = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const cikInput = z.string().regex(/^\d{1,10}$/);
const columns = z.object({ accessionNumber: z.array(accession), filingDate: z.array(z.string()), form: z.array(z.string()), primaryDocument: z.array(z.string()) });
const submissionsSchema = z.object({ cik: z.union([z.string(), z.number().int()]), filings: z.object({ recent: columns, files: z.array(z.object({ name: z.string().regex(/^CIK\d{10}-submissions-\d{3}\.json$/) })).default([]) }) });
const factsSchema = z.object({ cik: z.union([z.string(), z.number().int()]), facts: z.record(z.record(z.object({ units: z.record(z.array(z.unknown())) }))) });
const factSchema = z.object({ accn: accession, filed: date, form: z.string().min(1), val: z.number().finite(), end: date, start: date.optional() }).passthrough();
const selectedRow = z.object({ accession: accession, filedAt: date, form: z.string().min(1), primaryDocument });
const optionsSchema = z.object({ cik: cikInput, accessions: z.array(accession).min(1) });
const normalizeCik = (value: string | number) => String(value).padStart(10, '0');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pointerEscape = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

type Source = { url: string; transportUrl: string; body: string; sha256: string; fetchedAt: Date };
type Filing = z.infer<typeof selectedRow> & { submission: Source; document: Source };
type Fact = { taxonomy: string; concept: string; unit: string; raw: z.infer<typeof factSchema>; pointer: string; key: string };
let secQueue = Promise.resolve();
let lastSecStart = 0;
async function paceSecRequest() {
  const turn = secQueue.then(async () => {
    const delay = Math.max(0, lastSecStart + 150 - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastSecStart = Date.now();
  });
  secQueue = turn.catch(() => {});
  await turn;
}

function extractRows(raw: z.infer<typeof columns>, wanted: Set<string>, source: Source): Array<Omit<Filing, 'document'>> {
  const { accessionNumber, filingDate, form, primaryDocument } = raw;
  if ([filingDate.length, form.length, primaryDocument.length].some(length => length !== accessionNumber.length)) throw new Error('SEC submission columns have different lengths');
  return accessionNumber.flatMap((number, i) => wanted.has(number) ? [{ ...selectedRow.parse({ accession: number, filedAt: filingDate[i], form: form[i], primaryDocument: primaryDocument[i] }), submission: source }] : []);
}

export function createSecEdgarProvider(options: {
  db: PostgresJsDatabase;
  userAgent: string;
  fetch?: typeof fetch;
  dataBaseUrl?: string;
  archivesBaseUrl?: string;
  now?: () => Date;
}): DataProvider<SecEdgarSyncInput, SecEdgarSyncReport> {
  if (!options.userAgent.trim()) throw new Error('SEC user agent is required');
  const fetcher = options.fetch ?? fetch;
  async function load(url: string, transportUrl = url): Promise<Source> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await paceSecRequest();
      let response: Response;
      try { response = await fetcher(transportUrl, { headers: { 'User-Agent': options.userAgent, accept: '*/*' }, signal: AbortSignal.timeout(30_000) }); }
      catch (error) {
        if (attempt === 2 || (error instanceof Error && error.name === 'AbortError')) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (response.ok) {
        const body = await response.text();
        return { url, transportUrl, body, sha256: digest(body), fetchedAt: (options.now ?? (() => new Date()))() };
      }
      if ((response.status !== 429 && response.status < 500) || attempt === 2) throw new Error(`SEC returned HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 60) throw new Error('SEC retry-after exceeds 60 seconds');
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1)));
    }
    throw new Error('SEC request failed');
  }
  return {
    id: 'sec_edgar', capabilities: ['filings', 'fundamentals'] as const,
    async sync(input: { cik: string; accessions: string[] }) {
      const parsed = optionsSchema.parse(input);
      const cik = normalizeCik(parsed.cik);
      const wanted = new Set(parsed.accessions);
      const dataBase = (options.dataBaseUrl ?? 'https://data.sec.gov').replace(/\/$/, '');
      const archivesBase = (options.archivesBaseUrl ?? 'https://www.sec.gov/Archives/edgar/data').replace(/\/$/, '');
      const secData = 'https://data.sec.gov';
      const secArchives = 'https://www.sec.gov/Archives/edgar/data';
      const submissions = await load(`${secData}/submissions/CIK${cik}.json`, `${dataBase}/submissions/CIK${cik}.json`);
      const metadata = submissionsSchema.parse(JSON.parse(submissions.body));
      if (normalizeCik(metadata.cik) !== cik) throw new Error('SEC submissions CIK mismatch');
      const rows = extractRows(metadata.filings.recent, wanted, submissions);
      for (const file of metadata.filings.files) {
        if (new Set(rows.map(row => row.accession)).size === wanted.size) break;
        if (!file.name.startsWith(`CIK${cik}-`)) throw new Error('SEC submissions file CIK mismatch');
        const source = await load(`${secData}/submissions/${file.name}`, `${dataBase}/submissions/${file.name}`);
        rows.push(...extractRows(columns.parse(JSON.parse(source.body)), wanted, source));
      }
      if (rows.length !== wanted.size || new Set(rows.map(row => row.accession)).size !== wanted.size) throw new Error('Requested SEC accession is missing or duplicated');
      const factSource = await load(`${secData}/api/xbrl/companyfacts/CIK${cik}.json`, `${dataBase}/api/xbrl/companyfacts/CIK${cik}.json`);
      const companyFacts = factsSchema.parse(JSON.parse(factSource.body));
      if (normalizeCik(companyFacts.cik) !== cik) throw new Error('SEC facts CIK mismatch');
      const facts: Fact[] = [];
      for (const [taxonomy, concepts] of Object.entries(companyFacts.facts)) for (const [concept, data] of Object.entries(concepts)) for (const [unit, values] of Object.entries(data.units)) {
        values.forEach((value, index) => {
          const candidate = z.object({ accn: z.string().optional() }).passthrough().parse(value);
          if (!candidate.accn || !wanted.has(candidate.accn)) return;
          const raw = factSchema.parse(value);
          const row = rows.find(item => item.accession === raw.accn);
          if (!row || row.filedAt !== raw.filed || row.form !== raw.form) throw new Error('SEC fact filing metadata mismatch');
          const pointer = `/facts/${pointerEscape(taxonomy)}/${pointerEscape(concept)}/units/${pointerEscape(unit)}/${index}`;
          facts.push({ taxonomy, concept, unit, raw, pointer, key: digest(JSON.stringify([cik, taxonomy, concept, unit, raw, factSource.url, factSource.transportUrl, factSource.sha256])) });
        });
      }
      const filings: Filing[] = [];
      for (const row of rows) {
        const path = `/${Number(cik)}/${row.accession.replaceAll('-', '')}/${row.primaryDocument}`;
        filings.push({ ...row, document: await load(`${secArchives}${path}`, `${archivesBase}${path}`) });
      }
      const ingestedAt = (options.now ?? (() => new Date()))();
      return options.db.transaction(async tx => {
        const ids = new Map<string, string>();
        for (const source of [submissions, ...rows.map(row => row.submission), factSource, ...filings.map(row => row.document)]) {
          const key = JSON.stringify([source.url, source.transportUrl, source.sha256]);
          if (ids.has(key)) continue;
          await tx.insert(secSourceDocuments).values(source).onConflictDoNothing();
          const [saved] = await tx.select({ id: secSourceDocuments.id }).from(secSourceDocuments).where(and(eq(secSourceDocuments.url, source.url), eq(secSourceDocuments.transportUrl, source.transportUrl), eq(secSourceDocuments.sha256, source.sha256)));
          if (!saved) throw new Error('SEC source version was not saved');
          ids.set(key, saved.id);
        }
        const sourceId = (source: Source) => { const id = ids.get(JSON.stringify([source.url, source.transportUrl, source.sha256])); if (!id) throw new Error('Missing SEC source'); return id; };
        for (const filing of filings) await tx.insert(secFilings).values({ cik, accession: filing.accession, form: filing.form, filedAt: filing.filedAt, primaryDocument: filing.primaryDocument, submissionSourceId: sourceId(filing.submission), documentSourceId: sourceId(filing.document), ingestedAt }).onConflictDoNothing();
        for (const fact of facts) await tx.insert(secFacts).values({ key: fact.key, cik, accession: fact.raw.accn, taxonomy: fact.taxonomy, concept: fact.concept, unit: fact.unit, value: String(fact.raw.val), periodStart: fact.raw.start ?? null, periodEnd: fact.raw.end, filedAt: fact.raw.filed, form: fact.raw.form, raw: fact.raw, sourceId: sourceId(factSource), sourcePointer: fact.pointer, ingestedAt }).onConflictDoNothing();
        return { cik, filings: filings.length, facts: facts.length, ingestedAt };
      });
    },
  };
}
