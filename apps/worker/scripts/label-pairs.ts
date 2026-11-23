// Labels the Analyst's judgement levels with a model from a third vendor and prints weighted kappa, for the provisional labelled set of PR 17.
// Every number it prints is provisional. The operator decided on 2026-11-23 that the first 200 pairs are AI labelled and skimmed by a person later,
// so they never count as the full release gate.
// Pool: the latest valid score per run, security and KPI, scored by the Analyst's judgement prompt, with a known level and at least one passage.
// extract_then_quant KPIs are left out: code sets their level from an extracted number, so a level label there would not be independent.
// A level the Jev exposure check settled is left out too, because it is not the Analyst's.
// The labeller sees the passages the Analyst was offered, reloaded from document_chunks in the Analyst's layout, with the KPI, its definition,
// the full rubric and the unknown rule. It never sees the Analyst's level, rationale or citations. Each pair is checked against the Analyst's
// recorded prompt, and a pair whose prompt differs is skipped and reported.
// When the pool is larger than COUNT, a seeded sample is stratified by the Analyst's level: one pair per level first, the rest in proportion. No label is looked at.
// Every call goes through the gateway, audited in llm_calls under the first run id with role labeller. A rerun skips pairs already in the output file,
// and the gateway cache answers any repeated call without paying for it. It sends public filing text and the KPI to the pinned provider (ZDR, no data collection).
// Usage: DATABASE_URL=... OPENROUTER_API_KEY=... RUN_IDS=a,b [COUNT=200] [OUT=docs/pilot] bun scripts/label-pairs.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { levelKeys } from '@open-foresight/core';
import { llmCalls, runs } from '@open-foresight/db';
import { labelledSetSchema, provisionalLabel, summarizeLabelled, type LabelledPair, type LabelledSet } from '@open-foresight/evals';
import { createGateway } from '@open-foresight/llm';
import { loadPrompt } from '@open-foresight/prompts';
import { models } from '../../../config/models.js';
import { analystCheck, labellerUser, labelTask, loadPool, loadTasks, samplePool } from '../src/labelling.js';

const seed = 20261123;
const concurrency = Math.max(1, Math.min(Number(process.env.CONCURRENCY ?? 4), 16));
const url = process.env.DATABASE_URL, apiKey = process.env.OPENROUTER_API_KEY;
const runIds = (process.env.RUN_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const count = Number(process.env.COUNT ?? 200);
if (!url || !apiKey || runIds.length === 0) throw new Error('Set DATABASE_URL, OPENROUTER_API_KEY and RUN_IDS');
if (runIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error('RUN_IDS must be run uuids separated by commas');
if (!Number.isSafeInteger(count) || count < 1) throw new Error('COUNT must be a positive whole number');
const auditRunId = runIds[0]!;
const labeller = models.find(m => m.role === 'labeller');
if (!labeller) throw new Error('config/models.ts has no labeller role');
const prompt = loadPrompt('labeller-judgement', 'v1');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const path = resolve(root, process.env.OUT ?? 'docs/pilot', `labels-${auditRunId}.json`);

const sql = postgres(url, { max: 4 });
const db = drizzle(sql);
const found = await db.select({ id: runs.id }).from(runs).where(inArray(runs.id, runIds));
if (found.length !== runIds.length) throw new Error(`Unknown run id: ${runIds.filter(id => !found.some(r => r.id === id)).join(', ')}`);

const byLevel = (items: readonly { level: string }[]) => levelKeys.map(l => `${l}:${items.filter(i => i.level === l).length}`).join(' ');
const pool = await loadPool(db, runIds);
const sample = samplePool(pool, count, seed);
console.log(`Pool by Analyst level: ${byLevel(pool)} (${pool.length} pairs in ${runIds.length} run(s)). Sample: ${byLevel(sample)} (${sample.length}).`);
const short = pool.length < count;
if (short) console.log(`\n!!! THE POOL HAS ONLY ${pool.length} PAIRS, FEWER THAN COUNT=${count}. ALL ARE LABELLED, SO N IS AT MOST ${pool.length}, NOT ${count}. !!!\n`);

const checked = (await loadTasks(db, sample)).map(task => ({ task, check: analystCheck(labellerUser(prompt, task), task.analystUser) }));
const different = checked.filter(c => c.check === 'different');
const unrecorded = checked.filter(c => c.check === 'not_recorded').length;
console.log(`Prompt check against the Analyst's recorded message: ${checked.length - different.length - unrecorded} same, ${different.length} different, ${unrecorded} not recorded.`);
for (const { task } of different) console.log(`  skipped ${task.score.symbol} ${task.score.kpiId}: the labeller would not see what the Analyst saw`);
const tasks = checked.filter(c => c.check !== 'different').map(c => c.task);

const existing = existsSync(path) ? labelledSetSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
if (existing && (existing.labeller.model !== labeller.model || existing.labeller.promptVersion !== prompt.promptVersion)) {
  throw new Error(`${path} was labelled by ${existing.labeller.model} with ${existing.labeller.promptVersion}. Move it away to label with ${labeller.model} and ${prompt.promptVersion}.`);
}
const labelled = new Map<string, LabelledPair>();
for (const p of existing?.pairs ?? []) if (tasks.some(t => t.score.id === p.id)) labelled.set(p.id, p);
const dropped = (existing?.pairs.length ?? 0) - labelled.size;
if (dropped > 0) console.log(`${dropped} label(s) in the file are not in this sample and are dropped from it. Their calls stay in the cache.`);
const todo = tasks.filter(t => !labelled.has(t.score.id));
console.log(`${labelled.size} pair(s) already labelled in ${path}, ${todo.length} to label with ${labeller.model} (${prompt.promptVersion}).`);

/** Spend and providers of every labeller call for this run and prompt, so a resumed file reports the whole cost of its labels. */
async function labellerCalls(ids?: string[]) {
  const where = ids ? inArray(llmCalls.id, ids) : and(eq(llmCalls.runId, auditRunId), eq(llmCalls.role, 'labeller'), eq(llmCalls.promptVersion, prompt.promptVersion));
  const rows = await db.select({ provider: llmCalls.provider, cost: llmCalls.cost, params: llmCalls.params, error: llmCalls.error }).from(llmCalls).where(where);
  const cached = rows.filter(r => (r.params as { cacheHit?: boolean }).cacheHit === true);
  const paid = rows.filter(r => !cached.includes(r) && r.error === null);
  const providers = [...new Set((paid.length ? paid : cached).flatMap(r => (r.provider ? [r.provider] : [])))].sort();
  return { calls: rows.length, cached: cached.length, failed: rows.filter(r => r.error !== null).length, usd: rows.reduce((s, r) => s + Number(r.cost ?? 0), 0), providers };
}

const analystModels = [...new Set(tasks.flatMap(t => (t.analystModel ? [t.analystModel] : [])))].sort().join(', ') || 'unknown';
const startedAt = new Date().toISOString();
async function save(): Promise<LabelledSet> {
  const pairs = tasks.flatMap(t => labelled.get(t.score.id) ?? []);
  const how = short
    ? `The pool had only ${pool.length} pairs, fewer than the ${count} requested, so every pool pair was taken.`
    : `A seeded sample of ${sample.length} from a pool of ${pool.length}, stratified by the Analyst's level.`;
  const missing = sample.length - pairs.length;
  const doc: LabelledSet = labelledSetSchema.parse({
    schemaVersion: 1, source: 'ai', provisional: true,
    labeller: { model: labeller!.model, provider: (await labellerCalls()).providers.join(', ') || existing?.labeller.provider || 'unknown', promptVersion: prompt.promptVersion },
    analyst: { model: analystModels }, runIds, createdAt: existing?.createdAt ?? startedAt, sample: { requested: count, pool: pool.length, seed },
    note: `N is ${pairs.length}. ${how}${missing > 0 ? ` ${missing} sampled pair(s) have no label.` : ''} This set is ${provisionalLabel}.`,
    pairs,
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return doc;
}

const auditIds: string[] = [];
const failures: string[] = [];
if (todo.length > 0) {
  const gateway = await createGateway({ apiKey, models: [labeller], db, concurrency });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (next < todo.length) {
      const task = todo[next++]!;
      const name = `${task.score.symbol} ${task.score.kpiId}`;
      try {
        const pair = await labelTask(gateway, prompt, task, auditRunId, id => auditIds.push(id));
        labelled.set(pair.id, pair);
        await save();
        console.log(`  ${name.padEnd(48)} analyst ${pair.analystLevel}  label ${pair.labelLevel}`);
      } catch (error) {
        failures.push(name);
        console.log(`  ${name.padEnd(48)} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }));
}

if (tasks.length === 0 || (labelled.size === 0 && !existing)) {
  console.log('\nNothing was labelled, so no file was written.');
} else {
  const doc = await save();
  const s = summarizeLabelled(doc);
  const now = auditIds.length ? await labellerCalls(auditIds) : { calls: 0, cached: 0, failed: 0, usd: 0, providers: [] };
  const total = await labellerCalls();
  const fmt = (x: number | null) => (x === null ? 'undefined' : x.toFixed(3));
  console.log(`\nWrote ${path}`);
  console.log(`N: ${doc.pairs.length} labelled pairs. ${doc.note}`);
  console.log(`Weighted kappa (quadratic), Analyst against labeller: ${fmt(s.kappa)} over ${s.n} pairs with a level on both sides`);
  console.log(`Exact agreement: ${fmt(s.exactAgreement)}`);
  console.log(`Unknown: labeller only ${s.excluded.unknownB}, Analyst only ${s.excluded.unknownA}, both ${s.excluded.unknownBoth}`);
  console.log('Confusion, rows Analyst 0 to 4, columns labeller 0 to 4:');
  s.confusion.forEach((row, i) => console.log(`  ${i}: ${row.map(x => String(x).padStart(3)).join(' ')}`));
  console.log(`Cost this invocation: ${now.usd.toFixed(4)} USD over ${now.calls} call(s), ${now.cached} from cache, ${now.failed} failed. Labeller cost of this file to date: ${total.usd.toFixed(4)} USD over ${total.calls} call(s).`);
  console.log(`Labeller provider: ${doc.labeller.provider}. Analyst model: ${doc.analyst.model}.`);
  console.log(s.label);
}
if (failures.length) { console.log(`${failures.length} pair(s) failed and have no label. Rerun to retry them.`); process.exitCode = 1; }
await sql.end();
