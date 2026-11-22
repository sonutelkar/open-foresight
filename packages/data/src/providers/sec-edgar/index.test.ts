import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { secFacts, secFilings, secSourceDocuments } from '@open-foresight/db';
import { createSecEdgarProvider } from './index.js';

const fixture = new URL('../../../fixtures/sec-edgar/', import.meta.url);
const submissions = await readFile(new URL('submissions.json', fixture), 'utf8');
const companyFacts = await readFile(new URL('companyfacts.json', fixture), 'utf8');
const original = await readFile(new URL('d10k.txt', fixture), 'utf8');
const amendment = await readFile(new URL('d10ka.txt', fixture), 'utf8');
const accessions = ['0001193125-09-214859', '0001193125-10-012091'];
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration('SEC EDGAR fixture server and Postgres', () => {
  it('stores original and amended observations with dates, source bodies, and stable identities', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      if (requests === 1) { response.writeHead(429, { 'retry-after': '0' }).end(); return; }
      const path = request.url?.replace(/^\/mirror/, '');
      if (path === '/submissions/CIK0000320193.json') return response.end(submissions);
      if (path === '/api/xbrl/companyfacts/CIK0000320193.json') return response.end(companyFacts);
      if (request.url?.endsWith('/d10k.htm')) return response.end(original);
      if (request.url?.endsWith('/d10ka.htm')) return response.end(amendment);
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local port');
    const base = `http://127.0.0.1:${address.port}`;
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    try {
      const provider = createSecEdgarProvider({ db, userAgent: 'fixture contact@example.com', dataBaseUrl: base, archivesBaseUrl: `${base}/Archives/edgar/data` });
      const first = await provider.sync({ cik: '320193', accessions });
      const sourceUrl = 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json';
      const transportUrl = `${base}/api/xbrl/companyfacts/CIK0000320193.json`;
      const before = (await db.select().from(secFacts).innerJoin(secSourceDocuments, eq(secFacts.sourceId, secSourceDocuments.id)).where(eq(secFacts.cik, '0000320193'))).filter(row => row.sec_source_documents.url === sourceUrl && row.sec_source_documents.transportUrl === transportUrl);
      const second = await provider.sync({ cik: '320193', accessions });
      const after = (await db.select().from(secFacts).innerJoin(secSourceDocuments, eq(secFacts.sourceId, secSourceDocuments.id)).where(eq(secFacts.cik, '0000320193'))).filter(row => row.sec_source_documents.url === sourceUrl && row.sec_source_documents.transportUrl === transportUrl);
      const filings = await db.select().from(secFilings).innerJoin(secSourceDocuments, eq(secFilings.documentSourceId, secSourceDocuments.id)).where(eq(secFilings.cik, '0000320193'));
      const sources = await db.select().from(secSourceDocuments).where(eq(secSourceDocuments.transportUrl, `${base}/submissions/CIK0000320193.json`));
      const sourceIds = new Set(sources.map(source => source.id));
      const local = filings.filter(item => item.sec_source_documents.transportUrl.startsWith(`${base}/Archives/`) && sourceIds.has(item.sec_filings.submissionSourceId));
      expect(first).toMatchObject({ filings: 2, facts: 2 });
      expect(second).toMatchObject({ filings: 2, facts: 2 });
      expect(after.map(row => row.sec_facts.id).sort()).toEqual(before.map(row => row.sec_facts.id).sort());
      expect(after).toHaveLength(2);
      expect(local).toHaveLength(2);
      expect(local.find(row => row.sec_filings.form === '10-K/A')).toMatchObject({ sec_filings: { filedAt: '2010-01-25' }, sec_source_documents: { body: amendment, url: 'https://www.sec.gov/Archives/edgar/data/320193/000119312510012091/d10ka.htm', transportUrl: `${base}/Archives/edgar/data/320193/000119312510012091/d10ka.htm` } });
      const amended = after.find(row => row.sec_facts.form === '10-K/A');
      expect(amended).toMatchObject({ sec_facts: { filedAt: '2010-01-25', periodEnd: '2009-10-16', accession: accessions[1], sourcePointer: '/facts/dei/EntityCommonStockSharesOutstanding/units/shares/1' } });
      expect(JSON.parse(amended?.sec_source_documents.body ?? '{}').facts.dei.EntityCommonStockSharesOutstanding.units.shares[1].accn).toBe(accessions[1]);
      expect(amended?.sec_source_documents.transportUrl).toBe(`${base}/api/xbrl/companyfacts/CIK0000320193.json`);
      expect(requests).toBe(9);
      const mirror = createSecEdgarProvider({ db, userAgent: 'fixture contact@example.com', dataBaseUrl: `${base}/mirror`, archivesBaseUrl: `${base}/Archives/edgar/data` });
      await mirror.sync({ cik: '320193', accessions });
      const mirrored = await db.select().from(secSourceDocuments).where(eq(secSourceDocuments.url, sourceUrl));
      expect(mirrored.some(row => row.transportUrl === `${base}/mirror/api/xbrl/companyfacts/CIK0000320193.json`)).toBe(true);
      expect(mirrored.find(row => row.transportUrl === `${base}/mirror/api/xbrl/companyfacts/CIK0000320193.json`)?.id).not.toBe(amended?.sec_source_documents.id);
      expect(requests).toBe(13);
      process.stdout.write(`${JSON.stringify({ filings: local.map(row => ({ accession: row.sec_filings.accession, filedAt: row.sec_filings.filedAt, url: row.sec_source_documents.url, transportUrl: row.sec_source_documents.transportUrl })), facts: after.map(row => ({ accession: row.sec_facts.accession, filedAt: row.sec_facts.filedAt, periodEnd: row.sec_facts.periodEnd, source: row.sec_source_documents.url, transportUrl: row.sec_source_documents.transportUrl, pointer: row.sec_facts.sourcePointer })), requests })}\n`);
    } finally {
      await sql.end();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);
  it('rejects missing filing dates before persisting records', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    const broken: unknown = JSON.parse(submissions);
    const brokenResponse = JSON.stringify({ ...Object(broken), filings: { recent: { ...Object(Object(Object(broken).filings).recent), filingDate: ['', '2010-01-25'] }, files: [] } });
    const fixtureFetch: typeof fetch = async () => new Response(brokenResponse);
    try {
      const provider = createSecEdgarProvider({ db, userAgent: 'fixture contact@example.com', fetch: fixtureFetch });
      await expect(provider.sync({ cik: '320193', accessions })).rejects.toThrow();
    } finally { await sql.end(); }
  });
  it('retains both values for a constructed changed amendment after repeat sync', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    const origin = `http://constructed-amendment-${Date.now()}.invalid`;
    const changed = JSON.parse(companyFacts);
    changed.facts.dei.EntityCommonStockSharesOutstanding.units.shares[1].val = 900678474;
    const changedBody = JSON.stringify(changed);
    const fixtureFetch: typeof fetch = async input => {
      if (String(input).includes('submissions')) return new Response(submissions);
      if (String(input).includes('companyfacts')) return new Response(changedBody);
      if (String(input).endsWith('/d10k.htm')) return new Response(original);
      if (String(input).endsWith('/d10ka.htm')) return new Response(amendment);
      return new Response('not found', { status: 404 });
    };
    try {
      const provider = createSecEdgarProvider({ db, userAgent: 'fixture contact@example.com', fetch: fixtureFetch, dataBaseUrl: origin, archivesBaseUrl: `${origin}/Archives/edgar/data` });
      await provider.sync({ cik: '320193', accessions });
      await provider.sync({ cik: '320193', accessions });
      const rows = (await db.select().from(secFacts).innerJoin(secSourceDocuments, eq(secFacts.sourceId, secSourceDocuments.id)).where(eq(secFacts.cik, '0000320193')))
        .filter(row => row.sec_source_documents.transportUrl === `${origin}/api/xbrl/companyfacts/CIK0000320193.json`);
      expect(rows).toHaveLength(2);
      expect(rows.map(row => [row.sec_facts.accession, row.sec_facts.value]).sort()).toEqual([
        ['0001193125-09-214859', '900678473'], ['0001193125-10-012091', '900678474'],
      ]);
      for (const row of rows) {
        expect(row.sec_source_documents.url).toBe('https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json');
        expect(row.sec_source_documents.body).toBe(changedBody);
        expect(row.sec_facts.sourcePointer).toMatch(/^\/facts\/dei\/EntityCommonStockSharesOutstanding\/units\/shares\/[01]$/);
      }
    } finally { await sql.end(); }
  });
  it('rejects an unavailable fact date and leaves no source documents on failure', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    const origin = `http://sec-missing-date-${Date.now()}.invalid`;
    const altered = JSON.parse(companyFacts);
    delete altered.facts.dei.EntityCommonStockSharesOutstanding.units.shares[1].filed;
    const fixtureFetch: typeof fetch = async input => String(input).includes('companyfacts') ? Response.json(altered) : new Response(submissions);
    try {
      const url = 'https://data.sec.gov/submissions/CIK0000320193.json';
      const before = await db.select().from(secSourceDocuments).where(eq(secSourceDocuments.url, url));
      const provider = createSecEdgarProvider({ db, userAgent: 'fixture contact@example.com', fetch: fixtureFetch, dataBaseUrl: origin });
      await expect(provider.sync({ cik: '320193', accessions })).rejects.toThrow();
      expect(await db.select().from(secSourceDocuments).where(eq(secSourceDocuments.url, url))).toHaveLength(before.length);
    } finally { await sql.end(); }
  });
  it('does not persist partial records when a filing download fails', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    const origin = `http://sec-failure-${Date.now()}.invalid`;
    const fixtureFetch: typeof fetch = async input => {
      if (String(input).includes('submissions')) return new Response(submissions);
      if (String(input).includes('companyfacts')) return new Response(companyFacts);
      if (String(input).endsWith('/d10k.htm')) return new Response(original);
      return new Response('not found', { status: 404 });
    };
    try {
      const url = 'https://data.sec.gov/submissions/CIK0000320193.json';
      const before = await db.select().from(secSourceDocuments).where(eq(secSourceDocuments.url, url));
      const provider = createSecEdgarProvider({ db, userAgent: 'fixture contact@example.com', fetch: fixtureFetch, dataBaseUrl: origin, archivesBaseUrl: `${origin}/Archives/edgar/data` });
      await expect(provider.sync({ cik: '320193', accessions })).rejects.toThrow('HTTP 404');
      expect(await db.select().from(secSourceDocuments).where(eq(secSourceDocuments.url, url))).toHaveLength(before.length);
    } finally { await sql.end(); }
  });
});
