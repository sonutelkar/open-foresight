// Finds annual reports on company sites for the issuers in core's `reportSources` that have none in the store, and stores them as web reports.
// A cheap model with OpenRouter's web search tool proposes URLs. Code filters them to the company's allow-list, checks robots.txt, fetches, extracts and verifies them.
// This is ingestion. The worker and the agents never fetch. A company is skipped when it has a stored report or was tried in the last COOLDOWN_DAYS days (default 7).
// Usage: DATABASE_URL=... OPENROUTER_API_KEY=... [ONLY=lei:...] [COOLDOWN_DAYS=7] bun scripts/discover-reports.ts   then   PHASES=index bun scripts/seed-pilot.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { reportSources } from '@open-foresight/core';
import { discoverReport } from '@open-foresight/agents';
import { createWebReportsProvider } from '@open-foresight/data';
import { createDiscoverer } from '@open-foresight/llm';

const env = (name: string) => { const v = process.env[name]; if (!v?.trim()) throw new Error(`Set ${name}`); return v; };
const sql = postgres(env('DATABASE_URL'), { max: 2 });
const db = drizzle(sql);
const discoverer = createDiscoverer({ apiKey: env('OPENROUTER_API_KEY'), warn: m => console.warn(`WARNING ${m}`) });
// A generic client name, so no personal detail goes to a company site. The provider obeys robots.txt and spaces requests per host.
const userAgent = process.env.WEB_USER_AGENT ?? 'open-foresight-educational';
const only = process.env.ONLY?.split(',').filter(Boolean);

for (const source of reportSources.filter(s => !only || only.includes(s.issuerKey))) {
  const fetcher = createWebReportsProvider({ db, userAgent, allowedDomains: [...source.domains] });
  const r = await discoverReport({ db, discoverer, fetcher, source, cooldownDays: Number(process.env.COOLDOWN_DAYS ?? 7) });
  console.log(`${source.entityName.padEnd(12)} ${r.outcome}${r.stored ? ` (${r.stored} stored)` : ''}${r.detail ? `  ${r.detail.slice(0, 200)}` : ''}`);
}
await sql.end();
