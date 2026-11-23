// Live check of the Jev exposure check against a finished run, read-only. For every included name it retrieves the stored business passages, asks real Jev
// which of core, partial, none or cannot_tell describes the company's exposure to the brief's theme, and prints the verdict next to what the Analyst
// gave the gate KPI. It writes no scores. Every call is audited in llm_calls under the run. It sends public filing text and the brief to the pinned TypeSafe provider.
// Usage: DATABASE_URL=... OPENROUTER_API_KEY=... RUN_ID=... bun scripts/jev-exposure-check.ts
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Brief, Framework } from '@open-foresight/core';
import { checkExposure } from '@open-foresight/agents';
import { createEmbedder, createGateway } from '@open-foresight/llm';
import { createRetriever } from '@open-foresight/retrieval';
import { kpiFrameworkVersions, kpiScores, runUniverse, runs } from '@open-foresight/db';
import { models } from '../../../config/models.js';

const url = process.env.DATABASE_URL, runId = process.env.RUN_ID, apiKey = process.env.OPENROUTER_API_KEY;
if (!url || !runId || !apiKey) throw new Error('Set DATABASE_URL, OPENROUTER_API_KEY and RUN_ID');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);
const gateway = await createGateway({ apiKey, models: models.filter(m => m.role === 'analyst'), db });
const retriever = createRetriever({ db, embedder: await createEmbedder({ db, apiKey }) });
const [run] = await db.select().from(runs).where(eq(runs.id, runId));
const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId));
const brief = run!.settings as Brief, framework = version!.framework as Framework;
const gate = framework.kpis.find(k => k.isGate)!;
const universe = await db.select().from(runUniverse).where(and(eq(runUniverse.runId, runId), eq(runUniverse.included, true)));
const gateScores = await db.select().from(kpiScores).where(and(eq(kpiScores.runId, runId), eq(kpiScores.kpiId, gate.id), eq(kpiScores.valid, true)));

console.log(`gate KPI ${gate.id} (${gate.method}), ${universe.length} names\n`);
const tally: Record<string, number> = {};
for (const u of universe) {
  const r = await checkExposure({ db, gateway, retriever, judge: gateway, runId, frameworkDraftId: version!.sourceDraftId, snapshotId: run!.snapshotId!, asOf: brief.asOf, security: { id: u.securityId!, name: u.name ?? u.symbol, symbol: u.symbol, ciks: (u.ciks as string[] | null) ?? [], issuerKeys: (u.issuerKeys as string[] | null) ?? [] } }, brief.brief);
  const analyst = gateScores.find(g => g.securityId === u.securityId)?.level ?? 'none';
  const probs = r.answer ? Object.entries(r.answer.probabilities).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ') : r.failure ?? 'no passages';
  tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  console.log(`${u.symbol.padEnd(9)} ${(u.name ?? '').slice(0, 26).padEnd(27)} analyst gate ${String(analyst).padEnd(7)} -> ${r.verdict.padEnd(7)} ${r.answer?.choice ?? ''}  ${probs}`);
}
console.log(`\n${JSON.stringify(tally)}`);
await sql.end();
