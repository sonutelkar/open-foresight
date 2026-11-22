// Live check of evidence retrieval on real services.
//   sec  : real Apple 10-K filings from SEC EDGAR, real OpenRouter embeddings (Azure, ZDR), real Postgres.
//   esef : the real ESEF reports already in the database (run packages/data/scripts/esef-live.ts first).
// Usage: SEC_USER_AGENT=... OPENROUTER_API_KEY=... TEST_DATABASE_URL=postgres://... bun scripts/live.ts sec|esef
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, embeddingBatches, esefFilings, exchangeListings, figiMappings, secFilings, secListings, securities } from '@open-foresight/db';
import { createEmbedder } from '@open-foresight/llm';
import { createSecEdgarProvider, createSecSecurityProvider } from '@open-foresight/data';
import { createRetriever, extractedTextFor, indexDocuments, issuerKeysForSecurity } from '../src/index.js';

const mode = process.argv[2];
const url = process.env.TEST_DATABASE_URL;
if (!url || (mode !== 'sec' && mode !== 'esef')) throw new Error('Usage: bun scripts/live.ts sec|esef with TEST_DATABASE_URL set');
const apiKey = process.env.OPENROUTER_API_KEY ?? '';
const sql = postgres(url, { max: 3 });
const db = drizzle(sql);
const embedder = await createEmbedder({ db, apiKey });
console.log(`embedder ${embedder.model} via ${embedder.provider}, ${embedder.dimensions} dimensions`);
const squash = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

if (mode === 'sec') {
  const ua = process.env.SEC_USER_AGENT ?? '';
  if (!ua) throw new Error('Set SEC_USER_AGENT');
  const cik = '0000320193';
  const submissions = await (await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'user-agent': ua } })).json() as { filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[] } } };
  const recent = submissions.filings.recent;
  const tenKs = recent.form.flatMap((form, i) => form === '10-K' ? [{ accession: recent.accessionNumber[i]!, filedAt: recent.filingDate[i]! }] : []).slice(0, 2).reverse();
  const [older, newer] = tenKs;
  if (!older || !newer) throw new Error('Need two 10-K filings');
  console.log('10-K filings', JSON.stringify(tenKs));
  console.log('security', JSON.stringify(await createSecSecurityProvider({ db, userAgent: ua }).sync({ tickers: ['AAPL'] })));
  console.log('filings', JSON.stringify(await createSecEdgarProvider({ db, userAgent: ua }).sync({ cik, accessions: [older.accession, newer.accession] })));
  const [link] = await db.select({ securityId: figiMappings.securityId, name: securities.name }).from(secListings).innerJoin(figiMappings, eq(figiMappings.listingId, secListings.id)).innerJoin(securities, eq(securities.id, figiMappings.securityId)).where(eq(secListings.ticker, 'AAPL'));
  if (!link?.securityId) throw new Error('AAPL did not resolve to a security');
  console.log('AAPL security', link.securityId, link.name, 'issuers', JSON.stringify(await issuerKeysForSecurity(db, link.securityId)));
  const snapshot = await createSnapshot({ db });
  const indexed = await indexDocuments({ db, embedder, kinds: ['sec_filing'] });
  console.log('indexed', JSON.stringify(indexed));
  const retriever = createRetriever({ db, embedder });
  const filings = await db.select({ id: secFilings.id, accession: secFilings.accession, filedAt: secFilings.filedAt }).from(secFilings).where(inArray(secFilings.accession, [older.accession, newer.accession]));
  const idOf = (accession: string) => filings.find(f => f.accession === accession)?.id;
  const query = 'What does Apple design, manufacture and market? smartphones, personal computers, tablets, wearables and accessories';
  const hits = await retriever.search({ snapshotId: snapshot.id, asOf: newer.filedAt, securityId: link.securityId, query, limit: 5 });
  const top = hits[0];
  console.log(`known quote search as of ${newer.filedAt}: ${hits.length} hits`);
  for (const h of hits.slice(0, 3)) console.log(`  [${h.docId === idOf(newer.accession) ? 'newer' : 'older'} 10-K ${h.availableOn}] ${h.section.slice(0, 40)} offsets ${h.startOffset}-${h.endOffset} ranks text=${h.ranks.text} vector=${h.ranks.vector} :: ${h.text.slice(0, 110).replace(/\n/g, ' ')}`);
  const quoteFound = squash(top?.text ?? '').includes('designs, manufactures and markets smartphones');
  const sourceText = top ? await extractedTextFor(db, top.docKind, top.docId) : undefined;
  const provenance = !!top && sourceText?.slice(top.startOffset, top.endOffset) === top.text;
  console.log('top hit contains the known quote:', quoteFound, '| offsets reproduce the stored source text:', provenance);
  const before = await retriever.search({ snapshotId: snapshot.id, asOf: addDays(newer.filedAt, -1), securityId: link.securityId, query, limit: 20 });
  const futureAbsent = !before.some(h => h.docId === idOf(newer.accession));
  const olderPresent = before.some(h => h.docId === idOf(older.accession));
  const onDay = await retriever.search({ snapshotId: snapshot.id, asOf: newer.filedAt, securityId: link.securityId, query, limit: 20 });
  const veryEarly = await retriever.search({ snapshotId: snapshot.id, asOf: addDays(older.filedAt, -1), securityId: link.securityId, query, limit: 20 });
  console.log(`as of ${addDays(newer.filedAt, -1)}: newer 10-K absent=${futureAbsent}, older 10-K present=${olderPresent} | as of ${newer.filedAt}: newer present=${onDay.some(h => h.docId === idOf(newer.accession))} | as of ${addDays(older.filedAt, -1)}: hits=${veryEarly.length}`);
  const audit = await db.select().from(embeddingBatches);
  console.log(`embedding batches audited: ${audit.length}, providers: ${[...new Set(audit.map(a => a.provider))].join(',')}, total tokens ${audit.reduce((s, a) => s + (a.tokens ?? 0), 0)}, total cost $${audit.reduce((s, a) => s + Number(a.cost ?? 0), 0).toFixed(5)}`);
  if (!quoteFound || !provenance || !futureAbsent || !olderPresent || veryEarly.length !== 0) { console.error('LIVE CHECK FAILED'); process.exitCode = 1; }
} else {
  const filings = await db.select().from(esefFilings);
  const snapshot = await createSnapshot({ db });
  const indexed = await indexDocuments({ db, embedder, kinds: ['esef_filing'] });
  console.log('indexed', JSON.stringify(indexed));
  const retriever = createRetriever({ db, embedder });
  const owners = (await db.select().from(exchangeListings).where(eq(exchangeListings.status, 'resolved'))).filter(l => l.securityId);
  let failures = 0;
  for (const f of filings) {
    let securityId: string | undefined;
    for (const l of owners) {
      if (l.securityId && (await issuerKeysForSecurity(db, l.securityId)).includes(`lei:${f.lei}`)) { securityId = l.securityId; break; }
    }
    if (!securityId) { console.log(f.entityName, 'no security'); failures++; continue; }
    const hits = await retriever.search({ snapshotId: snapshot.id, asOf: f.availableOn, securityId, query: `${f.entityName} revenue operating profit outlook`, limit: 3 });
    const top = hits[0];
    const text = top ? await extractedTextFor(db, top.docKind, top.docId) : undefined;
    const issuerOnly = hits.every(h => h.issuerKey === `lei:${f.lei}`);
    const provenance = !!top && text?.slice(top.startOffset, top.endOffset) === top.text;
    const early = await retriever.search({ snapshotId: snapshot.id, asOf: addDays(f.availableOn, -1), securityId, query: 'revenue', limit: 3 });
    if (hits.length === 0 || !issuerOnly || !provenance || early.length !== 0) failures++;
    console.log(`${f.country} ${f.entityName.slice(0, 24).padEnd(24)} hits=${hits.length} issuerOnly=${issuerOnly} provenance=${provenance} dayBefore=${early.length} :: ${(top?.text ?? '').slice(0, 90).replace(/\n/g, ' ')}`);
  }
  if (failures) { console.error('LIVE CHECK FAILED'); process.exitCode = 1; }
}
await sql.end();
