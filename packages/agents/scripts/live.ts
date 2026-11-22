// Live check of the Designer on the real surface: the real gateway, the pinned designer model on OpenRouter, and real Postgres.
// Usage: OPENROUTER_API_KEY=... TEST_DATABASE_URL=postgres://... bun scripts/live.ts [--record]
//   --record also writes the raw model completion to fixtures/designer-real-completion.json, for replay tests.
// The sample universe comes from the 50 name fixture and never from the pilot reference ETF, so the framework is not shaped by the benchmark.
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources } from '@open-foresight/core';
import { kpiFrameworkDrafts, llmCalls, runs } from '@open-foresight/db';
import { createGateway } from '@open-foresight/llm';
import { models } from '../../../config/models.js';
import { listDrafts, runDesigner } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
const apiKey = process.env.OPENROUTER_API_KEY ?? '';
if (!url || !apiKey) throw new Error('Set TEST_DATABASE_URL and OPENROUTER_API_KEY');
const record = process.argv.includes('--record');
const sql = postgres(url, { max: 2 });
const db = drizzle(sql);

const [run] = await db.insert(runs).values({ settings: { theme: 'Smart Energy' }, modelProfile: 'quality' }).returning({ id: runs.id });
if (!run) throw new Error('No run');
const designerModel = models.find(m => m.role === 'designer');
if (!designerModel) throw new Error('config/models.ts has no designer role');
const gateway = await createGateway({ apiKey, models: [designerModel], db });
console.log(`gateway ready, designer model ${designerModel.model}`);

const started = performance.now();
const result = await runDesigner({
  db, gateway, runId: run.id, availableSources: enabledSources({ eodhd: true }),
  input: {
    brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon. Include grid equipment and automation, energy efficiency products, demand response, and the storage and inverter makers that let grids absorb variable renewables, including second order suppliers. Exclude pure electric vehicle makers and pure fossil fuel producers.',
    keywords: ['smart grid', 'grid automation', 'energy efficiency', 'demand response', 'battery storage', 'inverter'],
    seedNames: ['SU.PA', 'ABBN.SW', 'ENPH.US'],
    exclusions: ['pure EV makers', 'pure fossil fuel producers'],
    regions: ['US', 'EU', 'UK', 'CH'], exposureStyle: 'broad', asOf: new Date().toISOString().slice(0, 10),
    universeSample: [
      { symbol: 'ENPH.US', name: 'Enphase Energy' }, { symbol: 'FSLR.US', name: 'First Solar' }, { symbol: 'NEE.US', name: 'NextEra Energy' },
      { symbol: 'SU.PA', name: 'Schneider Electric' }, { symbol: 'ABBN.SW', name: 'ABB' }, { symbol: 'SIE.XETRA', name: 'Siemens' },
      { symbol: 'SSE.LSE', name: 'SSE' }, { symbol: 'NG.LSE', name: 'National Grid' }, { symbol: 'IBE.MC', name: 'Iberdrola' }, { symbol: 'VWS.CO', name: 'Vestas Wind Systems' },
    ],
  },
});
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`designer finished in ${seconds}s, ok=${result.ok}, attempts=${result.attempts}, reused=${'reused' in result ? result.reused : false}`);

const drafts = await listDrafts(db, run.id);
for (const d of [...drafts].reverse()) {
  const [call] = await db.select().from(llmCalls).where(eq(llmCalls.id, d.llmCallId));
  const usage = (call?.tokens ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
  console.log(`attempt ${d.attempt}: valid=${d.valid} errors=${(d.errors as unknown[]).length} promptVersion=${d.promptVersion} model=${call?.model} provider=${call?.provider} tokens=${usage.prompt_tokens}/${usage.completion_tokens} cost=$${call?.cost} latency=${call?.latencyMs}ms audit=${d.llmCallId.slice(0, 8)}`);
  if (!d.valid) for (const e of d.errors as Array<{ code: string; path: string; message: string }>) console.log(`   ${e.code} ${e.path}: ${e.message}`);
}
if (result.ok) {
  const f = result.framework;
  console.log('rationale:', f.rationale);
  for (const s of f.subThemes) console.log(`sub-theme ${s.id}: ${s.name}`);
  for (const k of f.kpis) console.log(`  ${String(k.weightPercent).padStart(3)}%  ${k.isGate ? 'GATE ' : '     '}${k.method.padEnd(18)} ${k.id.padEnd(28)} [${k.sources.join(',')}] lookback ${k.lookbackDays}d${'quantQuery' in k ? ` fn=${k.quantQuery}` : ''}${'thresholds' in k ? ` thresholds=${JSON.stringify(k.thresholds)}` : ''}`);
  const example = f.kpis.find(k => k.method !== 'quant');
  if (example && 'rubric' in example) console.log(`example rubric for ${example.id}:`, JSON.stringify(example.rubric, null, 1));
  await writeFile('/tmp/designer-live-framework.json', JSON.stringify(f, null, 2));
}
const [call] = drafts[0] ? await db.select().from(llmCalls).where(eq(llmCalls.id, drafts[0].llmCallId)) : [];
if (record && call?.response) {
  await writeFile(new URL('../fixtures/designer-real-completion.json', import.meta.url), `${JSON.stringify(call.response, null, 1)}\n`);
  console.log('recorded the raw completion of the latest attempt');
}
const stored = await db.select({ n: kpiFrameworkDrafts.id }).from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, run.id));
console.log(`saved drafts ${stored.length}, llm_calls rows for this run ${(await db.select().from(llmCalls).where(eq(llmCalls.runId, run.id))).length}`);
await sql.end();
if (!result.ok) process.exitCode = 1;
