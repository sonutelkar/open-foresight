// Fetches Yahoo Finance business summaries for universe names that have no filing or report passages in the store, so the Jev exposure check can judge them.
// A profile is a third party description, not a filing. It is stored as its own kind, and only the exposure check reads it. KPIs are never scored from it.
// Yahoo's terms bar automated collection, so this is for personal, educational use. Run it after discover-reports.ts, then PHASES=index bun scripts/seed-pilot.ts.
// Usage: DATABASE_URL=... [ONLY=EOAN.XETRA,RWE.XETRA] bun scripts/fetch-profiles.ts
import { desc, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createYahooProfileProvider } from '@open-foresight/data';
import { documentChunks, runUniverse, runs } from '@open-foresight/db';
import { issuerKeysForSecurity } from '@open-foresight/retrieval';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);
const only = process.env.ONLY?.split(',').filter(Boolean);

const [run] = await db.select({ id: runs.id }).from(runs).orderBy(desc(runs.createdAt)).limit(1);
if (!run) throw new Error('No run to take the universe from');
const names = (await db.select().from(runUniverse)).filter(u => u.runId === run.id && u.included && u.securityId && (!only || only.includes(u.symbol)));

const items: Array<{ symbol: string; issuerKey: string; entityName: string }> = [];
const skipped: string[] = [];
for (const u of names) {
  const keys = await issuerKeysForSecurity(db, u.securityId!);
  if (keys.length === 0) { skipped.push(`${u.symbol} (no issuer to attach a profile to)`); continue; }
  const have = await db.select({ id: documentChunks.id }).from(documentChunks).where(inArray(documentChunks.issuerKey, keys)).limit(1);
  if (have.length > 0) continue;
  items.push({ symbol: u.symbol, issuerKey: keys.find(k => k.startsWith('lei:')) ?? keys[0]!, entityName: u.name ?? u.symbol });
}
console.log(`${names.length} names in the run, ${items.length} with no passages${skipped.length ? `, skipped ${skipped.join(', ')}` : ''}`);
if (items.length) console.log(JSON.stringify(await createYahooProfileProvider({ db }).sync({ items })));
await sql.end();
