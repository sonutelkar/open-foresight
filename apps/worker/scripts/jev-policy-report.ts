// Compares three scoring policies on the labelled set, from a saved bake-off file: `fallback to Luna`, `treat Jev unknown as unknown` and `Luna alone`.
// It makes no model call and costs nothing. It reads the bake-off file and the labels, and, when DATABASE_URL is set, the run's saved scores to report the basket-level effect.
// Every number is provisional, because the labelled set is AI-generated. It never reports a release gate as satisfied.
// The basket effect replaces only the labelled pairs. Every other judgement KPI keeps Luna's saved level, so it understates what a full run would change.
// Usage: [DATABASE_URL=...] [BAKEOFF=docs/pilot/bakeoff-<run id>.json] [LABELS=docs/pilot/labels-<run id>.json] [OUT=<dir>] bun scripts/jev-policy-report.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { lunaFallbackConfidenceFactor } from '@open-foresight/core';
import { runs } from '@open-foresight/db';
import { bakeoffFileSchema, comparePolicies, labelledSetSchema, policyNames, type PolicyId } from '@open-foresight/evals';
import { policyBasketEffects } from '../src/policy-basket.js';
import { basketInput } from '../src/stages.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pilot = '9875a20c-19dd-4703-8b07-326f6ddb05e1';
const set = labelledSetSchema.parse(JSON.parse(readFileSync(resolve(root, process.env.LABELS ?? `docs/pilot/labels-${pilot}.json`), 'utf8')));
const file = bakeoffFileSchema.parse(JSON.parse(readFileSync(resolve(root, process.env.BAKEOFF ?? `docs/pilot/bakeoff-${pilot}.json`), 'utf8')));
const report = comparePolicies(set, file, lunaFallbackConfidenceFactor);
const jev = new Map(file.pairs.map(p => [p.id, p.jev[0] ?? null]));

const ids = Object.keys(policyNames) as PolicyId[];
const effects: Record<PolicyId, Array<{ runId: string } & ReturnType<typeof import('../src/policy-basket.js').policyBasketEffects>[PolicyId]>> = { fallback: [], jevOnly: [], lunaAlone: [] };
if (process.env.DATABASE_URL) {
  const sql = postgres(process.env.DATABASE_URL, { max: 2 });
  const db = drizzle(sql);
  for (const runId of set.runIds) {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!run) throw new Error(`Run ${runId} is not in the store`);
    const found = policyBasketEffects(await basketInput(db, run), set.pairs.filter(p => p.runId === runId), jev, lunaFallbackConfidenceFactor);
    for (const id of ids) effects[id].push({ runId, ...found[id] });
  }
  await sql.end();
}

const out = { createdAt: new Date().toISOString(), note: 'Provisional. The labels are AI-generated, so no release gate is satisfied.', confidenceFactor: lunaFallbackConfidenceFactor, report, basketEffects: effects };
const dir = resolve(root, process.env.OUT ?? 'docs/pilot');
mkdirSync(dir, { recursive: true });
const path = resolve(dir, `policies-${set.runIds[0]}.json`);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);

const fmt = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));
console.log(`Wrote ${path}\n${report.compared} of ${report.labels.pairs} pairs compared. ${report.label}.`);
for (const s of report.sides) {
  const id = ids.find(i => policyNames[i] === s.name)!;
  console.log(`\n${s.name}\n  weighted kappa ${fmt(s.agreement.kappa)} over ${s.agreement.n} pairs, exact ${fmt(s.agreement.exactAgreement)}, unknown rate ${fmt(s.unknownRate)}`);
  const e = effects[id];
  console.log(e.length ? e.map(x => `  basket ${x.runId.slice(0, 8)}: ${x.selected} selected, +${x.added.length} -${x.dropped.length} names against Luna alone, ${x.weightsChanged} weights changed, largest shift ${fmt(x.maxWeightShiftPercent, 2)} points`).join('\n') : '  basket effect: set DATABASE_URL to read it');
}
console.log('\nProvisional on an AI-labelled set. Release gates (kappa 0.6, stability 0.95) are not satisfied by this report.');
