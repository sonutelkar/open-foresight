// Live check of the Jev span check against a finished run. For each stored judgement score the Analyst gave at level 3 or 4, it reads the cited spans back
// from the store, asks real Jev whether they support the claimed level, and prints the verdict next to the original level. It writes no scores.
// Every call is audited in llm_calls under the run. It sends public filing text and the KPI definition to the pinned TypeSafe provider (ZDR, no data collection).
// Usage: DATABASE_URL=... OPENROUTER_API_KEY=... RUN_ID=... bun scripts/jev-span-check.ts
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Framework, ResolvedCitation, ScoreLevel } from '@open-foresight/core';
import { verifyClaim } from '@open-foresight/agents';
import { createGateway } from '@open-foresight/llm';
import { kpiFrameworkVersions, kpiScores, runUniverse } from '@open-foresight/db';
import { models } from '../../../config/models.js';

const url = process.env.DATABASE_URL, runId = process.env.RUN_ID, apiKey = process.env.OPENROUTER_API_KEY;
if (!url || !runId || !apiKey) throw new Error('Set DATABASE_URL, OPENROUTER_API_KEY and RUN_ID');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);
const gateway = await createGateway({ apiKey, models: models.filter(m => m.role === 'analyst'), db });
const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId));
const framework = version!.framework as Framework;
const rows = await db.select().from(kpiScores).where(and(eq(kpiScores.runId, runId), eq(kpiScores.valid, true), eq(kpiScores.method, 'judgement')));
const universe = await db.select().from(runUniverse).where(eq(runUniverse.runId, runId));
const asOf = rows[0]?.asOf ?? '';
const latest = new Map<string, (typeof rows)[number]>();
for (const r of rows) { const key = `${r.securityId}|${r.kpiId}`; if ((latest.get(key)?.attempt ?? 0) < r.attempt) latest.set(key, r); }

let n = 0, lowered = 0, kept = 0;
for (const r of latest.values()) {
  const level = ((r.raw as { level?: ScoreLevel } | null)?.level ?? r.level) as ScoreLevel;
  if (level !== '3' && level !== '4') continue;
  const kpi = framework.kpis.find(k => k.id === r.kpiId)!;
  const u = universe.find(x => x.securityId === r.securityId);
  const issuerKeys = (u?.issuerKeys as string[] | null) ?? [];
  const d = await verifyClaim({ db, judge: gateway, runId, asOf, security: { name: u?.name ?? r.symbol, issuerKeys } }, kpi, level, r.citations as ResolvedCitation[]);
  n++; d.level === level ? kept++ : lowered++;
  console.log(`${r.symbol.padEnd(9)} ${r.kpiId.padEnd(34)} analyst ${level} -> ${d.level} ${d.adjustment ? `[${d.adjustment.code}] ${JSON.stringify((d.adjustment.detail as { level: string; probability: number }[] | undefined)?.map?.(p => `${p.level}:${p.probability.toFixed(2)}`) ?? d.adjustment.detail)}` : '[supported]'}`);
}
console.log(`\n${n} level 3 or 4 score(s) checked: ${kept} kept, ${lowered} lowered.`);
await sql.end();
