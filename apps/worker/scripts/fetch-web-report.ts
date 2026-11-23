// Fetches one public annual report into web_documents and prints what the store holds for it. A second run reports the URL as unchanged.
// MENTION and ALLOW take comma-separated lists. PERIOD_END (YYYY-MM-DD) is optional.
// Usage: DATABASE_URL=... ISSUER_KEY=lei:W38RGI023J3WT1HWRP32 ENTITY="Siemens AG" MENTION=Siemens URL=... ALLOW=siemens.com bun scripts/fetch-web-report.ts
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Heading } from '@open-foresight/core';
import { createWebReportsProvider } from '@open-foresight/data';
import { webDocuments } from '@open-foresight/db';

const { DATABASE_URL: databaseUrl, ISSUER_KEY: issuerKey, ENTITY: entityName, URL: url, PERIOD_END: periodEnd } = process.env;
const list = (value?: string) => (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
const mustMention = list(process.env.MENTION), allowedDomains = list(process.env.ALLOW);
if (!databaseUrl || !issuerKey || !entityName || !url || mustMention.length === 0 || allowedDomains.length === 0) throw new Error('Set DATABASE_URL, ISSUER_KEY, ENTITY, MENTION, URL and ALLOW');
const sql = postgres(databaseUrl, { max: 2 });
const db = drizzle(sql);
const provider = createWebReportsProvider({ db, userAgent: 'open-foresight-educational', allowedDomains });
const started = performance.now();
const report = await provider.sync({ issuerKey, entityName, mustMention, urls: [url], periodEnd });
console.log('report', JSON.stringify({ ...report, ms: Math.round(performance.now() - started) }));
const [row] = await db.select().from(webDocuments).where(eq(webDocuments.url, new URL(url).href)).orderBy(desc(webDocuments.fetchedAt)).limit(1);
if (row) {
  const { text, headings, ...stored } = row;
  const pages = headings as Heading[];
  console.log('row', JSON.stringify({ ...stored, chars: text.length, headings: pages.length }));
  const third = pages[2];
  if (third) console.log('page 3', JSON.stringify(text.slice(third.offset, pages[3]?.offset ?? text.length).slice(0, 300)));
}
await sql.end();
