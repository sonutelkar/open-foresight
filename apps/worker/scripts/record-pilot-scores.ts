// Records the real scores of a finished run as fixtures/pilot-50-scores.json, so the packaging performance test replays real levels and confidences.
// It keeps levels, confidences, methods and market metrics, and no filing text.
// Usage: DATABASE_URL=... RUN_ID=<uuid> bun scripts/record-pilot-scores.ts
import { writeFile } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { unknownModeFor, type Framework } from '@open-foresight/core';
import { baskets, kpiFrameworkVersions, kpiScores, runUniverse, runs } from '@open-foresight/db';

const url = process.env.DATABASE_URL, runId = process.env.RUN_ID;
if (!url || !runId) throw new Error('Set DATABASE_URL and RUN_ID');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);
const [run] = await db.select().from(runs).where(eq(runs.id, runId));
if (!run || run.status !== 'done') throw new Error('The run must be done');
const settings = run.settings as { asOf: string; exposureStyle: string };
const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.id, run.frameworkVersion ?? ''));
const framework = version!.framework as Framework;
const [basket] = await db.select({ id: baskets.id }).from(baskets).where(eq(baskets.runId, runId));
const universe = await db.select().from(runUniverse).where(and(eq(runUniverse.runId, runId), eq(runUniverse.included, true)));
const scores = await db.select().from(kpiScores).where(eq(kpiScores.runId, runId)).orderBy(desc(kpiScores.attempt));
const names = universe.map(u => {
  const mine: Record<string, { level: string; confidence: number; method: string }> = {};
  for (const s of scores) if (s.securityId === u.securityId && s.valid && !mine[s.kpiId]) mine[s.kpiId] = { level: s.level, confidence: Number(s.confidence), method: s.method };
  return { symbol: u.symbol, name: u.name ?? u.symbol, marketCapUsd: Number(u.marketCapUsd ?? 0), advUsd: Number(u.advUsd ?? 0), coverage: u.coverage, scores: mine };
});
const out = {
  note: 'Recorded from a real run. Levels and confidences are the real Analyst output on real filings. Names are real listings. No filing text is stored.',
  runId, basketId: basket?.id, asOf: settings.asOf, unknownMode: unknownModeFor(settings.exposureStyle),
  kpis: framework.kpis.map(k => ({ id: k.id, weight: k.weightPercent / 100, isGate: k.isGate })), names,
};
const path = new URL('../fixtures/pilot-50-scores.json', import.meta.url);
await writeFile(path, `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${names.length} names and ${scores.filter(s => s.valid).length} valid scores to ${path.pathname}`);
await sql.end();
