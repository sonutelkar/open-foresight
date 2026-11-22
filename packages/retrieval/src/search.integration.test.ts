import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, esefDocuments, esefFilings, exchangeListings, figiMappings, leiIsins, secFilings, secListings, secSourceDocuments, securities } from '@open-foresight/db';
import { createRetriever, extractedTextFor, indexDocuments, indexVersionFor, search } from './index.js';
import { fakeEmbedder } from './test-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const esefHtml = await readFile(new URL('../../data/fixtures/esef/report-excerpt.xhtml', import.meta.url), 'utf8');

const filler = (topic: string) => Array.from({ length: 70 }, (_, i) => `${topic} operations continued during period ${i} with steady performance across regions and customers.`).join(' ');
const QUOTE = 'The Company designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories.';

integration('retrieval on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  const tag = Math.random().toString(36).slice(2, 8);
  const cikA = `91${Math.floor(Math.random() * 1e8)}`.padStart(10, '0'), cikB = `92${Math.floor(Math.random() * 1e8)}`.padStart(10, '0');
  const stamp = new Date('2024-01-01T00:00:00Z');

  async function secDoc(cik: string, accession: string, filedAt: string, body: string, ingestedAt = stamp) {
    const [source] = await db.insert(secSourceDocuments).values({ url: `t/${tag}/${accession}`, transportUrl: `t/${tag}/${accession}`, sha256: `${tag}${accession}`, body, fetchedAt: stamp }).returning({ id: secSourceDocuments.id });
    if (!source) throw new Error('no source');
    const [filing] = await db.insert(secFilings).values({ cik, accession, form: '10-K', filedAt, primaryDocument: 'd.htm', submissionSourceId: source.id, documentSourceId: source.id, ingestedAt }).returning({ id: secFilings.id });
    if (!filing) throw new Error('no filing');
    return filing.id;
  }
  async function linkCik(cik: string, name: string) {
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-${tag}-${cik}`, name }).returning({ id: securities.id });
    const [listing] = await db.insert(secListings).values({ cik, ticker: `T${cik.slice(-6)}`, exchange: 'Nasdaq', name, observedAt: stamp }).returning({ id: secListings.id });
    if (!security || !listing) throw new Error('no link');
    await db.insert(figiMappings).values({ listingId: listing.id, securityId: security.id, candidates: [], observedAt: stamp });
    return security.id;
  }

  it('indexes with exact provenance, finds a known quote and keeps securities, snapshots and dates apart', async () => {
    const embedder = fakeEmbedder();
    const secA = await linkCik(cikA, 'Alpha Inc');
    const secB = await linkCik(cikB, 'Beta Inc');
    const tenK = await secDoc(cikA, `${tag}-10K`, '2024-02-01', `<h2>Item 1. Business</h2><p>${QUOTE} ${filler('alpha')}</p><h2>Item 7. Management discussion</h2><p>${filler('alpha liquidity')}</p>`);
    const future = await secDoc(cikA, `${tag}-FUT`, '2099-01-01', `<p>Alpha will announce a revolutionary quantum product line. ${filler('alpha future')}</p>`);
    const q3 = await secDoc(cikA, `${tag}-10Q`, '2024-08-01', `<p>Alpha quarterly update mentions a new gigafactory. ${filler('alpha quarter')}</p>`);
    const otherCompany = await secDoc(cikB, `${tag}-B10K`, '2024-02-01', `<p>${QUOTE.replace('The Company', 'Beta')} Beta sells phones. ${filler('beta')}</p>`);
    // ESEF filing for a third security, using a real report excerpt.
    const lei = `${tag.toUpperCase().padEnd(6, 'X')}TESTLEI0000`.slice(0, 18) + '00';
    const [secC] = await db.insert(securities).values({ shareClassFigi: `SC-${tag}-C`, name: 'Gamma A/S' }).returning({ id: securities.id });
    if (!secC) throw new Error('no security');
    await db.insert(exchangeListings).values({ source: 'eodhd', symbol: `G${tag}.CO`, exchange: 'CO', name: 'Gamma', type: 'Common Stock', isin: `DK${tag.toUpperCase().padEnd(10, '0')}`.slice(0, 12), status: 'resolved', securityId: secC.id, shareClasses: [], observedAt: stamp });
    await db.insert(leiIsins).values({ lei, isin: `DK${tag.toUpperCase().padEnd(10, '0')}`.slice(0, 12), source: 'gleif', observedAt: stamp });
    const [ef] = await db.insert(esefFilings).values({ fxoId: `${tag}-ESEF`, lei, entityName: 'Gamma A/S', country: 'DK', periodEnd: '2026-09-30', availableOn: '2026-11-11', availableSource: 'date_added', dateAddedAt: stamp, reportUrl: '/x', packageSha256: tag, ingestedAt: stamp }).returning({ id: esefFilings.id });
    if (!ef) throw new Error('no esef');
    await db.insert(esefDocuments).values({ filingId: ef.id, sha256: tag, body: esefHtml, fetchedAt: stamp });

    const snapshot = await createSnapshot({ db });
    const mine = [`cik:${cikA}`, `cik:${cikB}`, `lei:${lei}`];
    const report = await indexDocuments({ db, embedder, issuerKeys: mine });
    expect(report.documents).toBe(5);
    expect(report.indexVersion).toBe(indexVersionFor(embedder));
    const again = await indexDocuments({ db, embedder, issuerKeys: mine });
    expect(again).toMatchObject({ documents: 0, chunks: 0 });
    expect(await indexDocuments({ db, embedder, issuerKeys: [] })).toMatchObject({ documents: 0 });

    const retriever = createRetriever({ db, embedder });
    const hits = await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secA, query: 'what does the company design and sell, smartphones and tablets', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top?.text).toContain(QUOTE);
    expect(top?.docId).toBe(tenK);
    expect(top?.section).toBe('Item 1. Business');
    expect(top?.ranks.text).not.toBeNull();
    expect(top?.ranks.vector).not.toBeNull();
    const text = await extractedTextFor(db, 'sec_filing', tenK);
    expect(text?.slice(top?.startOffset, top?.endOffset)).toBe(top?.text);

    // Isolation, snapshot membership, and dates.
    expect(hits.every(h => h.issuerKey === `cik:${cikA}`)).toBe(true);
    expect(hits.some(h => h.docId === otherCompany)).toBe(false);
    const bHits = await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secB, query: 'smartphones tablets', limit: 5 });
    expect(bHits.length).toBeGreaterThan(0);
    expect(bHits.every(h => h.docId === otherCompany)).toBe(true);
    const ids = async (asOf: string, query: string) => (await retriever.search({ snapshotId: snapshot.id, asOf, securityId: secA, query, limit: 20 })).map(h => h.docId);
    expect(await ids('2099-12-31', 'quantum product line')).toContain(future);
    expect(await ids('2024-12-31', 'quantum product line announce')).not.toContain(future);
    expect(await ids('2024-07-31', 'gigafactory quarterly')).not.toContain(q3);
    expect(await ids('2024-08-01', 'gigafactory quarterly')).toContain(q3);
    const late = await secDoc(cikA, `${tag}-LATE`, '2024-03-01', `<p>Alpha late arriving statement about hydrogen turbines. ${filler('alpha late')}</p>`, new Date());
    await indexDocuments({ db, embedder, issuerKeys: mine });
    expect((await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secA, query: 'hydrogen turbines late arriving', limit: 20 })).some(h => h.docId === late)).toBe(false);
    const newer = await createSnapshot({ db });
    expect((await retriever.search({ snapshotId: newer.id, asOf: '2024-12-31', securityId: secA, query: 'hydrogen turbines late arriving', limit: 20 })).some(h => h.docId === late)).toBe(true);

    // The lookback and document kind filters narrow the same eligible set.
    const since = await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secA, query: 'alpha quarterly gigafactory update', since: '2024-07-01', limit: 20 });
    expect(since.length).toBeGreaterThan(0);
    expect(since.every(h => h.availableOn >= '2024-07-01')).toBe(true);
    expect(await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secA, query: 'alpha', since: '2024-12-01' })).toEqual([]);
    expect(await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secA, query: 'alpha quarterly', docKinds: ['esef_filing'] })).toEqual([]);
    expect((await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secA, query: 'alpha quarterly', docKinds: ['sec_filing'] })).length).toBeGreaterThan(0);
    expect(await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: secA, query: 'alpha', docKinds: [] })).toEqual([]);

    // ESEF text is found through the security's LEI and its offsets reproduce the text.
    const esefSnapshot = await createSnapshot({ db });
    const gHits = await retriever.search({ snapshotId: esefSnapshot.id, asOf: '2026-12-31', securityId: secC.id, query: 'market environment review', limit: 5 });
    expect(gHits.length).toBeGreaterThan(0);
    expect(gHits.every(h => h.docKind === 'esef_filing' && h.issuerKey === `lei:${lei}`)).toBe(true);
    const gText = await extractedTextFor(db, 'esef_filing', gHits[0]?.docId ?? '');
    expect(gText?.slice(gHits[0]?.startOffset, gHits[0]?.endOffset)).toBe(gHits[0]?.text);
    expect((await retriever.search({ snapshotId: esefSnapshot.id, asOf: '2026-11-10', securityId: secC.id, query: 'market environment review' })).length).toBe(0);

    // Every stored chunk of every document reproduces its source text.
    for (const id of [tenK, q3]) {
      const t = await extractedTextFor(db, 'sec_filing', id);
      const rows = await client`select start_offset, end_offset, text from document_chunks where doc_id = ${id}`;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(t?.slice(r.start_offset, r.end_offset)).toBe(r.text);
    }
    await expect(client.unsafe('UPDATE document_chunks SET text = \'x\'')).rejects.toThrow('append-only');
  }, 120_000);

  it('separates index versions, supports text only and vector only, and rejects bad input', async () => {
    const embedder = fakeEmbedder('fake/model-one');
    const sec = await linkCik(`93${Math.floor(Math.random() * 1e8)}`.padStart(10, '0'), 'Delta Inc');
    const [row] = await client`select cik from sec_listings sl join figi_mappings fm on fm.listing_id = sl.id where fm.security_id = ${sec}`;
    const cik = row?.cik as string;
    await secDoc(cik, `${tag}-D1`, '2024-02-01', `<p>Delta builds turbines and sells maintenance contracts. ${filler('delta')}</p>`);
    const snapshot = await createSnapshot({ db });
    await indexDocuments({ db, embedder, issuerKeys: [`cik:${cik}`] });
    const retriever = createRetriever({ db, embedder });
    const base = { snapshotId: snapshot.id, asOf: '2024-12-31', securityId: sec };
    expect((await retriever.search({ ...base, query: 'turbines maintenance contracts' })).length).toBeGreaterThan(0);
    const textOnly = await retriever.search({ ...base, query: 'turbines maintenance contracts', vector: false });
    expect(textOnly.length).toBeGreaterThan(0);
    expect(textOnly.every(h => h.ranks.vector === null && h.ranks.text !== null)).toBe(true);
    const vectorOnly = await retriever.search({ ...base, query: '??? !!' });
    expect(vectorOnly.length).toBeGreaterThan(0);
    expect(vectorOnly.every(h => h.ranks.text === null && h.ranks.vector !== null)).toBe(true);

    const other = createRetriever({ db, embedder: fakeEmbedder('fake/model-two') });
    expect(await other.search({ ...base, query: 'turbines maintenance contracts' })).toEqual([]);
    await indexDocuments({ db, embedder: fakeEmbedder('fake/model-two'), issuerKeys: [`cik:${cik}`] });
    expect((await other.search({ ...base, query: 'turbines maintenance contracts' })).length).toBeGreaterThan(0);

    expect(await retriever.search({ snapshotId: snapshot.id, asOf: '2024-12-31', securityId: '00000000-0000-0000-0000-000000000000', query: 'turbines' })).toEqual([]);
    await expect(search({ db, ...base, query: 'x', indexVersion: 'v', asOf: '2024-13-45' })).rejects.toThrow('asOf');
    await expect(search({ db, ...base, query: 'x', indexVersion: 'v', limit: 0 })).rejects.toThrow('limits');
    // A query with injection style characters is just text.
    expect((await retriever.search({ ...base, query: "turbines'; drop table document_chunks; --" })).length).toBeGreaterThan(0);
    expect(Number((await client`select count(*) from document_chunks`)[0]?.count)).toBeGreaterThan(0);
  }, 120_000);
});
