// The PR 13b bake-off: Jev against the frontier Analyst on the same labelled KPI pairs and the same passages, and against the labels.
// Every number it prints is provisional, because the labelled set is AI-generated. The release gates need a human-labelled set.
// Jev scores each pair twice. Its calls are never cached, so the two passes give its stability. The Analyst's first pass is the level the model
// stored for the pair, and its second replays the recorded request, the same system prompt and user message, with the gateway cache off.
// Both sides are compared on the model's own level, before the code checks of PRs 16b and 13c. The level after those checks is reported as a third side.
// Nothing is written to kpi_scores. Every call is audited in llm_calls under the labelled set's first run id, with role jev-scorer or bakeoff-analyst.
// It sends public filing text and the KPI to the pinned providers (ZDR, no data collection). Expect about 0.5 USD and 15 minutes for 200 pairs.
// Usage: DATABASE_URL=... OPENROUTER_API_KEY=... [LABELS=docs/pilot/labels-<run id>.json] [CONCURRENCY=4] [OUT=docs/pilot] bun scripts/jev-bakeoff.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { jevLevelRule, jevScoreVersion, judgementOutputSchema } from '@open-foresight/core';
import { jevModel, scoreWithJev, type JevScore } from '@open-foresight/agents';
import { kpiScores, llmCalls } from '@open-foresight/db';
import { compareOnLabels, labelledSetSchema, levelSchema, type RubricLevel, type SideRun } from '@open-foresight/evals';
import { createGateway } from '@open-foresight/llm';
import { loadPrompt } from '@open-foresight/prompts';
import { models } from '../../../config/models.js';
import { loadPool, loadTasks, type LabelTask } from '../src/labelling.js';

const url = process.env.DATABASE_URL, apiKey = process.env.OPENROUTER_API_KEY;
if (!url || !apiKey) throw new Error('Set DATABASE_URL and OPENROUTER_API_KEY');
const concurrency = Math.max(1, Math.min(Number(process.env.CONCURRENCY ?? 4), 16));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const labelsPath = resolve(root, process.env.LABELS ?? 'docs/pilot/labels-9875a20c-19dd-4703-8b07-326f6ddb05e1.json');
const set = labelledSetSchema.parse(JSON.parse(readFileSync(labelsPath, 'utf8')));
const auditRunId = set.runIds[0]!;
const analyst = models.find(m => m.role === 'analyst');
if (!analyst) throw new Error('config/models.ts has no analyst role');
const prompt = loadPrompt('analyst-judgement', 'v1');

const sql = postgres(url, { max: 4 });
const db = drizzle(sql);
const ids = new Set(set.pairs.map(p => p.id));
const scores = (await loadPool(db, set.runIds)).filter(s => ids.has(s.id));
if (scores.length !== ids.size) throw new Error(`${ids.size - scores.length} labelled pair(s) are no longer the latest valid score in their run`);
const tasks = await loadTasks(db, scores);
const stored = new Map((await db.select({ id: kpiScores.id, raw: kpiScores.raw, confidence: kpiScores.confidence }).from(kpiScores).where(inArray(kpiScores.id, [...ids])))
  .map(r => [r.id, { level: levelSchema.parse((r.raw as { level?: unknown } | null)?.level), confidence: Number(r.confidence) }]));
console.log(`${tasks.length} labelled pairs from ${labelsPath}. Auditing under run ${auditRunId}.`);

/** Runs `fn` over the tasks a few at a time. A task that throws is left out and counted, and the wall time of each call is kept. */
async function pass<T>(name: string, fn: (task: LabelTask) => Promise<T>): Promise<{ results: Map<string, T>; failures: string[]; latencies: number[] }> {
  const results = new Map<string, T>(), failures: string[] = [], latencies: number[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      const started = performance.now();
      try { results.set(task.score.id, await fn(task)); latencies.push(performance.now() - started); }
      catch (error) { failures.push(`${task.score.symbol} ${task.score.kpiId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }));
  console.log(`${name}: ${results.size} scored, ${failures.length} failed.`);
  for (const f of failures) console.log(`  failed ${f}`);
  return { results, failures, latencies };
}
const median = (xs: number[]) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2); };

const gateway = await createGateway({ apiKey, models: [{ role: 'bakeoff-analyst', model: analyst.model }], db, concurrency });
const jevPass = (n: number) => pass(`Jev pass ${n}`, task => scoreWithJev(gateway, { runId: auditRunId, company: task.company, asOf: task.score.asOf, kpi: task.kpi, passages: task.passages }));
const jev1 = await jevPass(1);
const jev2 = await jevPass(2);

const replayable = (task: LabelTask) => task.analystUser !== null && task.score.promptVersion === prompt.promptVersion;
const analystAudits: string[] = [];
const rerun = await pass('Analyst repeat with the cache off', async task => {
  if (!replayable(task)) throw new Error('its recorded request cannot be replayed with the current prompt');
  const out = await gateway.generate({
    runId: auditRunId, role: 'bakeoff-analyst', promptVersion: prompt.promptVersion, system: prompt.system, user: task.analystUser!, schemaName: 'kpi_score_judgement',
    schema: judgementOutputSchema, inputEvidenceIds: task.passages.map(p => p.chunkId), maxOutputTokens: 1500, cache: false, onAudit: id => analystAudits.push(id),
  });
  return out.level;
});
const analystCalls = analystAudits.length ? await db.select({ cost: llmCalls.cost, provider: llmCalls.provider }).from(llmCalls).where(inArray(llmCalls.id, analystAudits)) : [];

const jevRun = (p: Awaited<ReturnType<typeof jevPass>>): SideRun => Object.fromEntries([...p.results].map(([id, r]) => [id, { level: r.level, confidence: r.confidence }]));
const storedRun = (pick: (id: string) => RubricLevel): SideRun => Object.fromEntries([...ids].map(id => [id, { level: pick(id), confidence: stored.get(id)!.confidence }]));
const report = compareOnLabels(set, [
  { name: 'jev', model: jevModel, runs: [jevRun(jev1), jevRun(jev2)], cost: { usd: [...jev1.results.values()].reduce((s, r) => s + (r.answer?.costUsd ?? 0), 0), calls: [...jev1.results.values()].filter(r => r.answer).length, medianLatencyMs: median(jev1.latencies) } },
  { name: 'analyst', model: analyst.model, runs: [storedRun(id => stored.get(id)!.level), Object.fromEntries([...rerun.results].map(([id, level]) => [id, { level, confidence: stored.get(id)!.confidence }]))], cost: { usd: analystCalls.reduce((s, c) => s + Number(c.cost ?? 0), 0), calls: analystCalls.length, medianLatencyMs: median(rerun.latencies) } },
  { name: 'analyst after code checks', model: analyst.model, runs: [storedRun(id => set.pairs.find(p => p.id === id)!.analystLevel)], cost: null },
]);

const answered = [...jev1.results.values(), ...jev2.results.values()].flatMap(r => (r.answer && r.weighted !== null ? [Math.abs(r.weighted - r.answer.score)] : []));
const detail = (r: JevScore | undefined) => r && { level: r.level, reason: r.reason, weighted: r.weighted, confidence: r.confidence, known: r.answer?.known ?? null, probabilities: r.answer?.probabilities ?? null, jevScore: r.answer?.score ?? null, jevConfidence: r.answer?.confidence ?? null, decisionId: r.answer?.decisionId ?? null };
const out = {
  report,
  createdAt: new Date().toISOString(),
  labelledSet: labelsPath.slice(root.length),
  jev: { model: jevModel, version: jevScoreVersion, rule: jevLevelRule, failures: [jev1.failures, jev2.failures] },
  analyst: { model: analyst.model, promptVersion: prompt.promptVersion, providers: [...new Set(analystCalls.flatMap(c => (c.provider ? [c.provider] : [])))], notReplayable: tasks.filter(t => !replayable(t)).length, failures: rerun.failures },
  /** Largest gap between the weighted level computed in code and the score Jev reported, over every answer. */
  maxWeightedGap: answered.length ? Math.max(...answered) : null,
  pairs: set.pairs.map(p => ({
    id: p.id, symbol: p.symbol, kpiId: p.kpiId, label: p.labelLevel,
    analyst: { stored: stored.get(p.id)?.level ?? null, repeat: rerun.results.get(p.id) ?? null, afterChecks: p.analystLevel, confidence: stored.get(p.id)?.confidence ?? null },
    jev: [detail(jev1.results.get(p.id)), detail(jev2.results.get(p.id))],
  })),
};
const dir = resolve(root, process.env.OUT ?? 'docs/pilot');
mkdirSync(dir, { recursive: true });
const path = resolve(dir, `bakeoff-${auditRunId}.json`);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);

const fmt = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));
console.log(`\nWrote ${path}\n${report.compared} of ${report.labels.pairs} pairs compared. ${report.label}.`);
for (const s of report.sides) {
  console.log(`\n${s.name} (${s.model})`);
  console.log(`  weighted kappa ${fmt(s.agreement.kappa)} over ${s.agreement.n} pairs, exact ${fmt(s.agreement.exactAgreement)}, unknown rate ${fmt(s.unknownRate)}, missing ${s.missing}`);
  console.log(`  stability ${s.stability ? `${fmt(s.stability.stability)} (${s.stability.identical} of ${s.stability.n})` : 'not measured'}`);
  console.log(`  calibration ${s.calibration ? `Brier ${fmt(s.calibration.brier)}, ECE ${fmt(s.calibration.ece)} over ${s.calibration.n}` : 'n/a'}`);
  console.log(`  cost ${s.cost ? `${fmt(s.cost.usd, 4)} USD over ${s.cost.calls} calls, median ${s.cost.medianLatencyMs ?? 'n/a'} ms` : 'none, stored level'}`);
}
console.log(`\nLargest gap between the code's weighted level and Jev's reported score: ${fmt(out.maxWeightedGap, 6)}.`);
console.log('Release gates (kappa 0.6, stability 0.95) are not satisfied on an AI-labelled set, whatever the numbers above.');
await sql.end();
