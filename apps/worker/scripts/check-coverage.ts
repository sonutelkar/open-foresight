// Shows, for each symbol, the issuers linked to its security, the filings and chunks stored for them, and what the Jev exposure check says about its business passages.
// It writes nothing except the audit rows of the Jev calls. Usage: DATABASE_URL=... OPENROUTER_API_KEY=... SYMBOLS=XOM.US,SAP.XETRA,NOKIA.HE bun scripts/check-coverage.ts
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { checkExposure } from '@open-foresight/agents';
import { createEmbedder, createGateway } from '@open-foresight/llm';
import { createRetriever, issuerKeysForSecurity } from '@open-foresight/retrieval';
import { createSnapshot, documentChunks, exchangeListings, runs } from '@open-foresight/db';
import { models } from '../../../config/models.js';

const url = process.env.DATABASE_URL, apiKey = process.env.OPENROUTER_API_KEY, symbols = (process.env.SYMBOLS ?? '').split(',').filter(Boolean);
if (!url || !apiKey || symbols.length === 0) throw new Error('Set DATABASE_URL, OPENROUTER_API_KEY and SYMBOLS');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);
const gateway = await createGateway({ apiKey, models: models.filter(m => m.role === 'analyst'), db });
const retriever = createRetriever({ db, embedder: await createEmbedder({ db, apiKey }) });
const [run] = await db.select({ id: runs.id }).from(runs).limit(1);
const asOf = new Date().toISOString().slice(0, 10);
// A snapshot freezes which filings a search may see, so a fresh one is needed to see filings ingested after the run's snapshot.
const snapshot = await createSnapshot({ db });
for (const l of await db.select().from(exchangeListings).where(inArray(exchangeListings.symbol, symbols))) {
  if (!l.securityId) { console.log(`${l.symbol}: no security`); continue; }
  const keys = await issuerKeysForSecurity(db, l.securityId);
  const chunks = keys.length ? (await db.select({ k: documentChunks.issuerKey }).from(documentChunks).where(inArray(documentChunks.issuerKey, keys))).length : 0;
  const r = await checkExposure({ db, gateway, retriever, judge: gateway, runId: run!.id, frameworkDraftId: '', snapshotId: snapshot.id, asOf, security: { id: l.securityId, name: l.name, symbol: l.symbol, ciks: [], issuerKeys: keys } },
    'Smart energy: companies that make the electricity system more efficient, flexible and digital, including grid equipment and automation, energy efficiency products, demand response, storage and inverters.');
  console.log(`${l.symbol.padEnd(10)} issuers ${JSON.stringify(keys)} chunks ${chunks} -> ${r.verdict} ${r.answer ? `${r.answer.choice} ${JSON.stringify(r.answer.probabilities)}` : r.failure ?? 'no passages'}`);
}
await sql.end();
