// Live check of the ESEF chain for a few real companies, security to ISIN to LEI to ESEF filing and back.
// Calls real EODHD (symbol lists, one call per exchange), OpenFIGI (no key), GLEIF and filings.xbrl.org.
// Downloads one full annual report per company, roughly 10 MB each.
// Usage: EODHD_API_KEY=... TEST_DATABASE_URL=postgres://... bun scripts/esef-live.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, esefDocuments, esefFilings, esefFilingsAsOf, exchangeListings, securityIdsForLeis } from '@open-foresight/db';
import { createEodhdListingsProvider, createEsefProvider } from '../src/index.js';
import { eq, inArray } from 'drizzle-orm';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);
const symbols = ['VWS.CO', 'SSE.LSE', 'IBE.MC', 'ALO.PA', 'VOLV-B.ST', 'NESN.SW'];
const listings = createEodhdListingsProvider({ db, apiKey: process.env.EODHD_API_KEY });
if (!listings) throw new Error('Set EODHD_API_KEY');
console.log('listings', JSON.stringify(await listings.sync({ exchanges: ['CO', 'LSE', 'MC', 'PA', 'ST', 'SW'], only: symbols })));
const rows = await db.select().from(exchangeListings).where(inArray(exchangeListings.symbol, symbols));
const isins = rows.flatMap(r => r.status === 'resolved' && r.isin ? [r.isin] : []);
const report = await createEsefProvider({ db }).sync({ isins, perLei: 1 });
console.log('esef', JSON.stringify({ ...report, bytes: `${(report.bytes / 1e6).toFixed(1)} MB` }));
const filings = await db.select().from(esefFilings);
const bySecurity = await securityIdsForLeis({ db, leis: filings.map(f => f.lei) });
const snapshot = await createSnapshot({ db });
for (const symbol of symbols) {
  const row = rows.find(r => r.symbol === symbol);
  const found = filings.filter(f => bySecurity.get(f.lei)?.includes(row?.securityId ?? ''));
  const f = found[0];
  if (!f) { console.log(symbol.padEnd(10), row?.status ?? 'no listing', 'no ESEF filing'); continue; }
  const [doc] = await db.select({ n: esefDocuments.sha256 }).from(esefDocuments).where(eq(esefDocuments.filingId, f.id));
  const before = await esefFilingsAsOf({ db, snapshotId: snapshot.id, asOf: f.availableOn.slice(0, 8) + '01', leis: [f.lei] });
  const onDay = await esefFilingsAsOf({ db, snapshotId: snapshot.id, asOf: f.availableOn, leis: [f.lei] });
  console.log(symbol.padEnd(10), f.country, f.entityName.slice(0, 26).padEnd(26), `period ${f.periodEnd}`, `available ${f.availableOn} (${f.availableSource})`, `lei ${f.lei}`, `doc ${doc?.n.slice(0, 8)}`, `visible on availableOn=${onDay.length === 1}`, `visible before=${before.some(x => x.id === f.id)}`);
}
await sql.end();
