// Live check: maps four real EODHD listings through real OpenFIGI into the database in TEST_DATABASE_URL, twice.
// Usage: EODHD_API_KEY=... TEST_DATABASE_URL=postgres://... bun scripts/listings-live.ts
// Costs one EODHD call per exchange list (4). OpenFIGI runs without a key.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { exchangeListings, securities } from '@open-foresight/db';
import { createEodhdListingsProvider } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL');
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);
const provider = createEodhdListingsProvider({ db, apiKey: process.env.EODHD_API_KEY });
if (!provider) throw new Error('Set EODHD_API_KEY');
const input = { exchanges: ['US', 'XETRA', 'SW', 'LSE'], only: ['AAPL.US', 'SAP.XETRA', 'NESN.SW', 'VOD.LSE'] };
console.log('first ', JSON.stringify(await provider.sync(input)));
const before = await db.select().from(securities);
console.log('second', JSON.stringify(await provider.sync(input)));
const after = await db.select().from(securities);
console.log(`securities before/after repeat: ${before.length}/${after.length}`);
const byId = new Map(after.map(s => [s.id, s]));
for (const l of await db.select().from(exchangeListings)) console.log(l.symbol.padEnd(10), l.status.padEnd(9), l.isin, l.currency, byId.get(l.securityId ?? '')?.shareClassFigi, JSON.stringify(l.shareClasses));
await sql.end();
