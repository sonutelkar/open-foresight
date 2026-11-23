// Records the citations of a finished run, with the stored text they point at, as a fixture for the citation evaluator tests.
// It reads the database and writes packages/evals/fixtures/pilot-citations.json. Real filing text goes into the fixture, so the file is a recording and not a hand edit.
// Usage: DATABASE_URL=... RUN_ID=... bun scripts/record-pilot-citations.ts
import { writeFile } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { citationCaseSchema } from '@open-foresight/evals';
import { documentChunks, kpiScores, runUniverse, runs } from '@open-foresight/db';

const url = process.env.DATABASE_URL, runId = process.env.RUN_ID;
if (!url || !runId) throw new Error('Set DATABASE_URL and RUN_ID');
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);
const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
if (run?.status !== 'done') throw new Error(`Run ${runId} is not done`);
const universe = await db.select({ symbol: runUniverse.symbol, issuerKeys: runUniverse.issuerKeys }).from(runUniverse).where(eq(runUniverse.runId, runId));
const issuerKeys = new Map(universe.map(u => [u.symbol, u.issuerKeys ?? []]));
const latest = new Map<string, typeof kpiScores.$inferSelect>();
for (const r of await db.select().from(kpiScores).where(and(eq(kpiScores.runId, runId), eq(kpiScores.valid, true)))) {
  const key = `${r.securityId}|${r.kpiId}`, have = latest.get(key);
  if (!have || r.attempt > have.attempt) latest.set(key, r);
}
const cases = [...latest.values()].filter(r => (r.citations as unknown[]).length > 0).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.kpiId.localeCompare(b.kpiId))
  .map(r => citationCaseSchema.parse({ scoreId: r.id, symbol: r.symbol, kpiId: r.kpiId, method: r.method, asOf: r.asOf, allowedIssuerKeys: issuerKeys.get(r.symbol) ?? [], offered: r.evidence, citations: r.citations }));
const ids = [...new Set(cases.flatMap(c => c.citations.map(x => x.chunkId)))];
const chunks = await db.select({ id: documentChunks.id, issuerKey: documentChunks.issuerKey, availableOn: documentChunks.availableOn, docKind: documentChunks.docKind, text: documentChunks.text }).from(documentChunks).where(inArray(documentChunks.id, ids));
const out = new URL('../../../packages/evals/fixtures/pilot-citations.json', import.meta.url);
await writeFile(out, `${JSON.stringify({ schemaVersion: 1, source: `recorded from run ${runId}`, cases, chunks }, null, 1)}\n`);
console.log(`${cases.length} scores with citations, ${cases.reduce((s, c) => s + c.citations.length, 0)} citations, ${chunks.length} stored chunks -> ${out.pathname}`);
await sql.end();
