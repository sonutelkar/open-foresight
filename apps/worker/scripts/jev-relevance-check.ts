// Live comparison of the Jev passage relevance filter with PR 11 retrieval, on the scores of a finished run. Run it on a copy of the store,
// because every Jev call is audited in llm_calls under the run. For a spread of scores that cite passages, it repeats the Analyst's search
// as PR 11 runs it (top 10), then the filtered path (top 20 candidates, Jev keeps the relevant ones, top 10 of those). It checks that PR 11
// reproduces the passages the Analyst was offered, and measures how many of the passages the Analyst cited each path keeps, where they rank,
// and the latency. It writes the results to docs/pilot and the first case with kept and dropped passages to the retrieval test fixture.
// Usage: DATABASE_URL=... OPENROUTER_API_KEY=... RUN_ID=... [CASES=12] bun scripts/jev-relevance-check.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { and, eq, gte, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Brief, EvidenceItem, Framework, Kpi, ResolvedCitation } from '@open-foresight/core';
import { retrieveEvidence, type AnalystContext } from '@open-foresight/agents';
import { createEmbedder, createGateway, type DecisionRequest } from '@open-foresight/llm';
import { createRetriever, filterByRelevance, relevancePromptVersion, relevanceThreshold, type RelevanceJudge } from '@open-foresight/retrieval';
import { kpiFrameworkVersions, kpiScores, llmCalls, runUniverse, runs } from '@open-foresight/db';
import { models } from '../../../config/models.js';

const url = process.env.DATABASE_URL, runId = process.env.RUN_ID, apiKey = process.env.OPENROUTER_API_KEY, n = Number(process.env.CASES ?? 12);
if (!url || !runId || !apiKey) throw new Error('Set DATABASE_URL, OPENROUTER_API_KEY and RUN_ID');
const sql = postgres(url, { max: 4 });
const db = drizzle(sql);
const gateway = await createGateway({ apiKey, models: models.filter(m => m.role === 'analyst'), db });
const retriever = createRetriever({ db, embedder: await createEmbedder({ db, apiKey }) });
const [run] = await db.select().from(runs).where(eq(runs.id, runId));
const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, runId));
const brief = run!.settings as Brief, framework = version!.framework as Framework;
const universe = await db.select().from(runUniverse).where(eq(runUniverse.runId, runId));
const latest = new Map<string, typeof kpiScores.$inferSelect>();
for (const r of await db.select().from(kpiScores).where(and(eq(kpiScores.runId, runId), eq(kpiScores.valid, true), ne(kpiScores.method, 'quant')))) {
  const key = `${r.securityId}|${r.kpiId}`, have = latest.get(key);
  if (!have || r.attempt > have.attempt) latest.set(key, r);
}
const pool = [...latest.values()].filter(r => (r.citations as unknown[]).length > 0).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.kpiId.localeCompare(b.kpiId));
const picked = Array.from({ length: Math.min(n, pool.length) }, (_, i) => pool[Math.floor(i * pool.length / Math.min(n, pool.length))]!);

const calls: Array<{ input: DecisionRequest; answers: Record<string, unknown>; ms: number }> = [];
const judge: RelevanceJudge = { async decide(input) { const t = performance.now(); const r = await gateway.decide(input); calls.push({ input, answers: r.answers, ms: Math.round(performance.now() - t) }); return r; } };
const started = new Date();
const rankOf = (ids: string[], cited: Set<string>) => ids.flatMap((id, i) => cited.has(id) ? [i + 1] : []);
let fixture: unknown;
const compare = async (score: (typeof pool)[number]) => {
  const kpi = framework.kpis.find(k => k.id === score.kpiId) as Exclude<Kpi, { method: 'quant' }>;
  const u = universe.find(x => x.securityId === score.securityId)!;
  const security = { id: u.securityId!, name: u.name ?? u.symbol, symbol: u.symbol, ciks: (u.ciks as string[] | null) ?? [], issuerKeys: (u.issuerKeys as string[] | null) ?? [] };
  const ctx = (evidenceLimit: number): AnalystContext => ({ db, gateway, retriever, runId, frameworkDraftId: version!.sourceDraftId, snapshotId: run!.snapshotId!, asOf: brief.asOf, security, evidenceLimit });
  const query = `${kpi.name}. ${kpi.definition}${kpi.method === 'extract_then_quant' ? ` ${kpi.extraction.target}` : ''}`;
  const cited = new Set((score.citations as ResolvedCitation[]).map(c => c.chunkId));
  const offered = (score.evidence as EvidenceItem[]).map(e => e.chunkId);

  let t = performance.now();
  const pr11 = (await retrieveEvidence(ctx(10), kpi)).map(e => e.chunkId);
  const pr11Ms = performance.now() - t;
  t = performance.now();
  const candidates = await retrieveEvidence(ctx(20), kpi);
  const searchMs = performance.now() - t;
  const firstCall = calls.length;
  t = performance.now();
  const r = await filterByRelevance({ judge, runId, asOf: brief.asOf, company: security.name, issuerKeys: security.issuerKeys }, query, candidates);
  const judgeMs = performance.now() - t;
  const filtered = r.hits.slice(0, 10).map(h => h.chunkId);
  const reranked = [...r.hits].sort((a, b) => r.probabilities[b.chunkId]! - r.probabilities[a.chunkId]!).slice(0, 10).map(h => h.chunkId);
  const row = {
    symbol: score.symbol, kpiId: score.kpiId, method: score.method, level: score.level,
    reproducesOffered: JSON.stringify(pr11) === JSON.stringify(offered), cited: [...cited],
    pr11: { ids: pr11, citedRanks: rankOf(pr11, cited), ms: Math.round(pr11Ms) },
    filtered: { ids: filtered, citedRanks: rankOf(filtered, cited), searchMs: Math.round(searchMs), judgeMs: Math.round(judgeMs) },
    rerankedCitedRanks: rankOf(reranked, cited),
    fromBeyondTop10: filtered.filter(id => !pr11.includes(id)).length,
    dropped: r.dropped, probabilities: Object.fromEntries(Object.entries(r.probabilities).map(([k, v]) => [k, Math.round(v * 1000) / 1000])), failure: r.failure ?? null,
  };
  console.log(`${score.symbol.padEnd(9)} ${score.kpiId.padEnd(34)} offered=${row.reproducesOffered ? 'same' : 'DIFF'} cited=${cited.size} pr11 ranks ${JSON.stringify(row.pr11.citedRanks)} filtered ranks ${JSON.stringify(row.filtered.citedRanks)} kept ${r.hits.length}/${candidates.length} new=${row.fromBeyondTop10} search ${row.filtered.searchMs} ms jev ${row.filtered.judgeMs} ms${r.failure ? ` FAILED ${r.failure}` : ''}`);
  if (!fixture && !r.failure && r.dropped.length > 0 && r.hits.length > 0) fixture = {
    source: `recorded from run ${runId} on ${started.toISOString().slice(0, 10)}`, promptVersion: relevancePromptVersion, query, company: security.name, asOf: brief.asOf, issuerKeys: security.issuerKeys,
    candidates: candidates.map(({ chunkId, docKind, docId, issuerKey, section, startOffset, endOffset, availableOn, text }) => ({ chunkId, docKind, docId, issuerKey, section, startOffset, endOffset, availableOn, text })),
    decisions: calls.slice(firstCall).map(c => ({ state: c.input.state, questions: c.input.questions, inputEvidenceIds: c.input.inputEvidenceIds, answers: c.answers })),
  };
  return row;
};
const cases: Array<Awaited<ReturnType<typeof compare>>> = [];
for (const score of picked) cases.push(await compare(score));

const audit = await db.select({ cost: llmCalls.cost, error: llmCalls.error }).from(llmCalls).where(and(eq(llmCalls.runId, runId), eq(llmCalls.role, 'relevance'), gte(llmCalls.createdAt, started)));
const citedTotal = cases.reduce((s, c) => s + c.cited.length, 0);
const kept = (k: 'pr11' | 'filtered') => cases.reduce((s, c) => s + c[k].citedRanks.length, 0);
const meanRank = (ranks: number[][]) => { const all = ranks.flat(); return all.length ? Math.round(100 * all.reduce((s, x) => s + x, 0) / all.length) / 100 : null; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
const summary = {
  cases: cases.length, threshold: relevanceThreshold, reproducedOffered: cases.filter(c => c.reproducesOffered).length,
  citedPassages: citedTotal, citedKeptPr11: kept('pr11'), citedKeptFiltered: kept('filtered'), citedKeptReranked: cases.reduce((s, c) => s + c.rerankedCitedRanks.length, 0),
  meanCitedRankPr11: meanRank(cases.map(c => c.pr11.citedRanks)), meanCitedRankFiltered: meanRank(cases.map(c => c.filtered.citedRanks)), meanCitedRankReranked: meanRank(cases.map(c => c.rerankedCitedRanks)),
  passagesPr11: cases.reduce((s, c) => s + c.pr11.ids.length, 0), passagesFiltered: cases.reduce((s, c) => s + c.filtered.ids.length, 0), fromBeyondTop10: cases.reduce((s, c) => s + c.fromBeyondTop10, 0),
  medianPr11Ms: median(cases.map(c => c.pr11.ms)), medianFilteredMs: median(cases.map(c => c.filtered.searchMs + c.filtered.judgeMs)), medianJudgeMs: median(cases.map(c => c.filtered.judgeMs)), maxCallMs: Math.max(...calls.map(c => c.ms)),
  jevCalls: audit.length, jevErrors: audit.filter(a => a.error).length, jevCostUsd: Math.round(audit.reduce((s, a) => s + Number(a.cost ?? 0), 0) * 1e6) / 1e6,
};
console.log(`\n${JSON.stringify(summary, null, 1)}`);
await writeFile(new URL(`../../../docs/pilot/jev-relevance-${runId}.json`, import.meta.url), `${JSON.stringify({ schemaVersion: 1, runId, recordedAt: started.toISOString(), promptVersion: relevancePromptVersion, summary, cases }, null, 1)}\n`);
if (fixture) {
  const dir = new URL('../../../packages/retrieval/fixtures/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('jev-relevance.json', dir), `${JSON.stringify(fixture, null, 1)}\n`);
}
await sql.end();
