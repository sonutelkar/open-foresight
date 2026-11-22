// Live check of the whole universe path for the 50 fixture symbols, as of today.
// Calls real ECB, EODHD (50 EOD requests) and Yahoo through the Python yfinance package run with uv.
// Set CAPS=apify (and APIFY_TOKEN) to read market caps through Apify instead, about $0.05 for 50 names.
// Usage: EODHD_API_KEY=... TEST_DATABASE_URL=postgres://... bun scripts/universe-live.ts
import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot } from '@open-foresight/db';
import { buildUniverse, createApifyMarketCapProvider, createEcbFxProvider, createEodhdProvider, createYahooProvider, fxToUsdAsOf } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const asOf = day(0);
const universe = JSON.parse(await readFile(new URL('../fixtures/eodhd/universe-50.json', import.meta.url), 'utf8')) as { listings: Array<{ symbol: string }> };
const symbols = universe.listings.map(l => l.symbol);

const eodhd = createEodhdProvider({ db, apiKey: process.env.EODHD_API_KEY });
const caps = process.env.CAPS === 'apify' ? createApifyMarketCapProvider({ db, token: process.env.APIFY_TOKEN }) : createYahooProvider({ db });
if (!eodhd || !caps) throw new Error('Set EODHD_API_KEY (and APIFY_TOKEN when CAPS=apify)');
const currencies = ['USD', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK'];
console.log('fx    ', JSON.stringify(await createEcbFxProvider({ db }).sync({ currencies, from: day(-14), to: asOf })));
console.log('prices', JSON.stringify(await eodhd.sync({ symbols, from: day(-45), to: asOf })));
console.log('caps  ', JSON.stringify(await caps.sync({ symbols })));

const snapshot = await createSnapshot({ db });
const fx = await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf, currencies: ['USD', 'EUR', ...currencies] });
const decisions = await buildUniverse({ db, snapshotId: snapshot.id, asOf, listings: symbols.map(symbol => ({ symbol })), rules: { regions: ['US', 'EU', 'UK', 'CH'], minMarketCapUsd: 1e9, minAdvUsd: 5e6, maxStaleDays: 5, advWindow: 20, minAdvBars: 10, fxToUsd: fx, excluded: {} } });
console.log(`as of ${asOf}`);
for (const d of decisions) console.log(`${d.symbol.padEnd(11)} ${d.included ? 'IN ' : 'OUT'} ${(d.region ?? '-').padEnd(2)} cap=${d.marketCapUsd === null ? '-'.padEnd(9) : ((d.marketCapUsd / 1e9).toFixed(1) + 'bn').padEnd(9)} (${d.marketCapSource ?? '-'}) adv=${d.advUsd === null ? '-' : (d.advUsd / 1e6).toFixed(1) + 'm'} ${d.reasons.join(',')}`);
const byRegion = new Map<string, { total: number; included: number }>();
for (const d of decisions) { const r = d.region ?? 'none'; const e = byRegion.get(r) ?? { total: 0, included: 0 }; e.total++; if (d.included) e.included++; byRegion.set(r, e); }
console.log('by region', JSON.stringify(Object.fromEntries(byRegion)));
await sql.end();
