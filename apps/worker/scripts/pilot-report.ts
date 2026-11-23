// Writes the pilot report of a finished run and checks the pilot gates: machine time under 30 minutes, every cited evidence ID real,
// and at least 98% of quotes verbatim. Each citation of the latest valid score per security and KPI is checked again, independently,
// against the stored passage. The connection is read-only. The report goes to <OUT>/pilot-<runId>.json and never overwrites a file.
// Embedding cost is the query embeddings made between the run's start and done. Embeddings carry no run ID, so a run at the same time would be counted too.
// Exits 1 when a gate fails.
// Usage: DATABASE_URL=... RUN_ID=... [OUT=docs/pilot] bun scripts/pilot-report.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, asc, between, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { briefSchema } from '@open-foresight/core';
import { basketMembers, baskets, documentChunks, embeddingBatches, humanDecisions, kpiScores, llmCalls, runStatusHistory, runUniverse, runs } from '@open-foresight/db';
import { buildPilotReport, citationCaseSchema, evaluateCitations } from '@open-foresight/evals';

const url = process.env.DATABASE_URL, runId = process.env.RUN_ID;
if (!url || !runId) throw new Error('Set DATABASE_URL and RUN_ID');
const outDir = process.env.OUT ? resolve(process.env.OUT) : new URL('../../../docs/pilot/', import.meta.url).pathname;
const sql = postgres(url, { max: 1, connection: { default_transaction_read_only: true } });
const db = drizzle(sql);

const [run] = await db.select().from(runs).where(eq(runs.id, runId));
if (!run) throw new Error(`No run ${runId}`);
if (run.status !== 'done') throw new Error(`Run ${runId} is ${run.status}, not done`);
if (!run.snapshotId) throw new Error(`Run ${runId} has no snapshot`);
const settings = briefSchema.pick({ brief: true, asOf: true }).strip().parse(run.settings);
const history = await db.select({ status: runStatusHistory.status, at: runStatusHistory.createdAt }).from(runStatusHistory).where(eq(runStatusHistory.runId, runId)).orderBy(asc(runStatusHistory.sequence));
const doneAt = history.filter(h => h.status === 'done').at(-1)?.at;
if (!doneAt) throw new Error(`Run ${runId} has no done status`);
const [approval] = await db.select().from(humanDecisions)
  .where(and(eq(humanDecisions.runId, runId), eq(humanDecisions.stage, 'awaiting_kpi_approval'), eq(humanDecisions.action, 'approve')))
  .orderBy(desc(humanDecisions.createdAt)).limit(1);
if (!approval) throw new Error(`Run ${runId} has no approval`);
const calls = await db.select({ role: llmCalls.role, model: llmCalls.model, provider: llmCalls.provider, cost: llmCalls.cost, latencyMs: llmCalls.latencyMs }).from(llmCalls).where(eq(llmCalls.runId, runId));
const embeddings = await db.select({ cost: embeddingBatches.cost }).from(embeddingBatches)
  .where(and(eq(embeddingBatches.purpose, 'query'), between(embeddingBatches.createdAt, run.createdAt, doneAt)));
const [basket] = await db.select({ funnel: baskets.funnel }).from(baskets).where(eq(baskets.runId, runId));
const universe = await db.select({ symbol: runUniverse.symbol, issuerKeys: runUniverse.issuerKeys }).from(runUniverse).where(eq(runUniverse.runId, runId));

// The latest valid attempt per security and KPI is the score the basket used.
const latest = new Map<string, typeof kpiScores.$inferSelect>();
for (const r of await db.select().from(kpiScores).where(and(eq(kpiScores.runId, runId), eq(kpiScores.valid, true)))) {
  const key = `${r.securityId}|${r.kpiId}`, have = latest.get(key);
  if (!have || r.attempt > have.attempt) latest.set(key, r);
}
const scores = [...latest.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.kpiId.localeCompare(b.kpiId));
const issuerKeys = new Map(universe.map(u => [u.symbol, u.issuerKeys ?? []]));
const cases = scores.map(r => citationCaseSchema.parse({
  scoreId: r.id, symbol: r.symbol, kpiId: r.kpiId, method: r.method, asOf: r.asOf,
  allowedIssuerKeys: issuerKeys.get(r.symbol) ?? [], offered: r.evidence, citations: r.citations,
}));
const chunkIds = [...new Set(cases.flatMap(c => c.citations.map(x => x.chunkId)))];
const chunks = chunkIds.length === 0 ? [] : await db.select({ id: documentChunks.id, issuerKey: documentChunks.issuerKey, availableOn: documentChunks.availableOn, docKind: documentChunks.docKind, text: documentChunks.text })
  .from(documentChunks).where(inArray(documentChunks.id, chunkIds));
// The phase gate asks about the basket, so the same checks also run on the citations behind its members.
const memberSymbols = new Set((await db.select({ symbol: basketMembers.symbol }).from(basketMembers).innerJoin(baskets, eq(baskets.id, basketMembers.basketId)).where(eq(baskets.runId, runId))).map(m => m.symbol));
await sql.end();

const report = buildPilotReport({
  runId, brief: settings.brief, asOf: settings.asOf, snapshotId: run.snapshotId, createdAt: run.createdAt,
  statusHistory: history,
  approval: { decisionId: approval.id, analyst: approval.userId, at: approval.createdAt },
  llmCalls: calls.map(c => ({ role: c.role, model: c.model, provider: c.provider, costUsd: c.cost === null ? null : Number(c.cost), latencyMs: c.latencyMs })),
  embeddingCostsUsd: embeddings.map(e => e.cost === null ? null : Number(e.cost)),
  funnel: (basket?.funnel as Record<string, number> | undefined) ?? null,
  scores: scores.map(r => ({ method: r.method, level: r.level, adjustmentCodes: (r.adjustments as Array<{ code: string }>).map(a => a.code) })),
  citations: evaluateCitations({ cases, chunks: new Map(chunks.map(c => [c.id, c])) }),
  basketCitations: memberSymbols.size > 0 ? evaluateCitations({ cases: cases.filter(c => memberSymbols.has(c.symbol)), chunks: new Map(chunks.map(c => [c.id, c])) }) : undefined,
});

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `pilot-${runId}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });

const verdict = (passed: boolean) => (passed ? 'PASS' : 'FAIL');
const percent = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(2)}%`);
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const { gates, citations: c, timestamps: t } = report;
console.log(`Pilot report for run ${runId}, as of ${report.asOf}, snapshot ${report.snapshotId}`);
console.log(`Wrote ${outFile}`);
console.log(`${verdict(gates.basket.passed)}  basket        ${gates.basket.actual} selected, at least ${gates.basket.required} required`);
console.log(`${verdict(gates.elapsed.passed)}  elapsed       machine ${minutes(t.machineMs)} under ${minutes(gates.elapsed.required)} (run ${minutes(t.elapsedMs)}, approval wait ${minutes(t.gateWaitMs)})`);
console.log(`${verdict(gates.citationIds.passed)}  citation IDs  ${c.checks.id.passed}/${c.checks.id.total} = ${percent(c.checks.id.rate)}, required ${percent(gates.citationIds.required)}`);
console.log(`${verdict(gates.verbatim.passed)}  verbatim      ${c.checks.verbatim.passed}/${c.checks.verbatim.total} = ${percent(c.checks.verbatim.rate)}, required ${percent(gates.verbatim.required)}`);
console.log(`      point in time ${c.checks.point_in_time.passed}/${c.checks.point_in_time.total}, issuer ${c.checks.issuer.passed}/${c.checks.issuer.total}`);
console.log(`      ${c.totals.citations} citations on ${c.totals.scoresWithCitations} of ${c.totals.scores} scores. Cost ${report.totalCostUsd.toFixed(4)} USD, embeddings ${report.embeddingCostUsd.toFixed(6)} USD.`);
if (report.basketCitations) { const b = report.basketCitations; console.log(`      basket members only: ${b.totals.citations} citations on ${b.totals.scoresWithCitations} scores, IDs ${b.checks.id.passed}/${b.checks.id.total}, verbatim ${b.checks.verbatim.passed}/${b.checks.verbatim.total}, point in time ${b.checks.point_in_time.passed}/${b.checks.point_in_time.total}, issuer ${b.checks.issuer.passed}/${b.checks.issuer.total}`); }
const { weightedKappa, stability } = report.releaseGates;
console.log(`      Release gates: weighted kappa ${weightedKappa.required} and stability ${percent(stability.required)} NOT satisfied. ${weightedKappa.reason}`);
for (const f of c.failures) console.log(`FAIL  ${f.check} ${f.symbol} ${f.kpiId} ${f.evidenceId} score ${f.scoreId}: ${f.detail}`);
console.log(gates.passed ? 'PILOT GATES PASSED' : 'PILOT GATES FAILED');
process.exitCode = gates.passed ? 0 : 1;
