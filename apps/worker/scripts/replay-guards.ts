// Replays a finished run's stored scores through the evidence guards, read-only: the definition-term cap and the known-weight floor.
// It writes nothing, because a saved basket never changes. Usage: DATABASE_URL=... RUN_ID=... bun scripts/replay-guards.ts
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { capUnsupportedLevel, defaultMinKnownWeight, packageBasket, unknownModeFor, type BasketCandidate, type Brief, type Framework, type ResolvedCitation, type ScoreLevel } from '@open-foresight/core';
import { kpiFrameworkVersions, kpiScores, runUniverse, runs } from '@open-foresight/db';

const url = process.env.DATABASE_URL, runId = process.env.RUN_ID;
if (!url || !runId) throw new Error('Set DATABASE_URL and RUN_ID');
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);
const [run] = await db.select().from(runs).where(eq(runs.id, runId));
const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId));
if (!run || !version) throw new Error('No such run or no approved framework');
const brief = run.settings as Brief, framework = version.framework as Framework;
const kpis = framework.kpis.map(k => ({ id: k.id, weight: k.weightPercent / 100, isGate: k.isGate }));
const universe = (await db.select().from(runUniverse).where(and(eq(runUniverse.runId, runId), eq(runUniverse.included, true)))).filter(u => u.securityId);
const rows = await db.select().from(kpiScores).where(and(eq(kpiScores.runId, runId), eq(kpiScores.valid, true)));
const best = new Map<string, (typeof rows)[number]>();
for (const r of rows) { const key = `${r.securityId}|${r.kpiId}`; const have = best.get(key); if (!have || r.attempt > have.attempt) best.set(key, r); }

let lowered = 0;
const candidates = (guard: boolean): BasketCandidate[] => universe.map(u => ({
  securityId: u.securityId!, symbol: u.symbol, name: u.name ?? u.symbol, marketCapUsd: Number(u.marketCapUsd ?? 0), advUsd: Number(u.advUsd ?? 0),
  scores: Object.fromEntries(framework.kpis.flatMap(k => {
    const r = best.get(`${u.securityId}|${k.id}`); if (!r) return [];
    let level = r.level as ScoreLevel;
    if (guard) { const c = capUnsupportedLevel({ kpi: k, level, citations: r.citations as ResolvedCitation[] }); if (c.adjustment) { lowered++; console.log(`  lowered ${u.symbol} ${k.id}: ${c.adjustment.from} -> ${c.adjustment.to}`); } level = c.level; }
    return [[k.id, { level, confidence: Number(r.confidence) }]];
  })),
}));
const rules = { size: brief.basketSize, weightCapPercent: brief.weightCapPercent, weighting: brief.weighting, unknownMode: unknownModeFor(brief.exposureStyle) };
const before = packageBasket({ candidates: candidates(false), kpis, rules });
const after = packageBasket({ candidates: candidates(true), kpis, rules: { ...rules, minKnownWeight: defaultMinKnownWeight } });
const show = (label: string, b: typeof before) => { console.log(`\n${label}: ${b.members.length} selected, funnel ${JSON.stringify(b.funnel)}`); b.members.forEach(m => console.log(`  ${String(m.rank).padStart(2)} ${m.symbol.padEnd(9)} score ${m.score.toFixed(3)} unknown ${Math.round(m.unknownWeight * 100)}% weight ${m.weightPercent.toFixed(2)}`)); };
show('Stored rules', before); show('With the guards', after);
console.log(`\n${lowered} KPI score(s) lowered by the definition-term cap. Dropped for thin evidence: ${after.excluded.filter(e => e.reason === 'thin_evidence').map(e => e.symbol).join(', ') || 'none'}`);
await sql.end();
