// Live check: pulls the last 14 days of real ECB rates into the database in TEST_DATABASE_URL, twice, and prints the USD conversion.
// Usage: TEST_DATABASE_URL=postgres://... bun scripts/ecb-live.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot } from '@open-foresight/db';
import { createEcbFxProvider, fxToUsdAsOf } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL');
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const provider = createEcbFxProvider({ db });
const input = { currencies: ['USD', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK'], from: day(-14), to: day(0) };
console.log('first ', JSON.stringify(await provider.sync(input)));
console.log('second', JSON.stringify(await provider.sync(input)));
const snapshot = await createSnapshot({ db });
console.log(await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf: day(0), currencies: ['USD', 'EUR', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK'] }));
await sql.end();
