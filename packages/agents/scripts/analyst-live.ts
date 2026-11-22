// Live check of the Analyst on the real surface: real SEC filings, real Azure embeddings, the pinned designer and analyst models, real Postgres.
// Usage: OPENROUTER_API_KEY=... SEC_USER_AGENT=... [EODHD_API_KEY=...] TEST_DATABASE_URL=postgres://... bun scripts/analyst-live.ts [--record]
//   --record writes the real evidence and model outputs to fixtures/analyst-real-scores.json for replay tests.
// It scores Enphase Energy (ENPH) on the framework the Designer drafts for a Smart Energy brief, and computes every quant function.
import { writeFile } from 'node:fs/promises';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources, quantIds, type EvidenceItem, type Framework } from '@open-foresight/core';
import { computeQuant, createEodhdProvider, createSecEdgarProvider, createSecSecurityProvider } from '@open-foresight/data';
import { createSnapshot, figiMappings, kpiScores, llmCalls, runs, secFilings, secListings, securities } from '@open-foresight/db';
import { createEmbedder, createGateway } from '@open-foresight/llm';
import { createRetriever, extractedTextFor, indexDocuments, issuerKeysForSecurity } from '@open-foresight/retrieval';
import { models } from '../../../config/models.js';
import { runDesigner, scoreFramework } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
const apiKey = process.env.OPENROUTER_API_KEY ?? '';
const ua = process.env.SEC_USER_AGENT ?? '';
if (!url || !apiKey || !ua) throw new Error('Set TEST_DATABASE_URL, OPENROUTER_API_KEY and SEC_USER_AGENT');
const record = process.argv.includes('--record');
const sql = postgres(url, { max: 4 });
const db = drizzle(sql);
const today = new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const [run] = await db.insert(runs).values({ settings: { theme: 'Smart Energy', stock: 'ENPH' }, modelProfile: 'quality' }).returning({ id: runs.id });
if (!run) throw new Error('No run');
const gateway = await createGateway({ apiKey, models: models.filter(m => m.role === 'designer' || m.role === 'analyst'), db });
console.log('gateway ready:', models.filter(m => m.role === 'designer' || m.role === 'analyst').map(m => `${m.role}=${m.model}`).join(', '));

// 1. The Designer drafts the framework for the brief.
const designed = await runDesigner({
  db, gateway, runId: run.id, availableSources: enabledSources({ eodhd: true }),
  input: {
    brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon. Include grid equipment and automation, energy efficiency products, demand response, and the storage and inverter makers that let grids absorb variable renewables, including second order suppliers. Exclude pure electric vehicle makers and pure fossil fuel producers.',
    keywords: ['smart grid', 'grid automation', 'energy efficiency', 'demand response', 'battery storage', 'inverter'], seedNames: ['SU.PA', 'ABBN.SW', 'ENPH.US'], exclusions: ['pure EV makers', 'pure fossil fuel producers'],
    regions: ['US', 'EU', 'UK', 'CH'], exposureStyle: 'broad', asOf: today,
    universeSample: [{ symbol: 'ENPH.US', name: 'Enphase Energy' }, { symbol: 'FSLR.US', name: 'First Solar' }, { symbol: 'NEE.US', name: 'NextEra Energy' }, { symbol: 'SU.PA', name: 'Schneider Electric' }, { symbol: 'ABBN.SW', name: 'ABB' }],
  },
});
if (!designed.ok) throw new Error(`Designer failed: ${designed.errors.map(e => e.code).join(',')}`);
const framework: Framework = designed.framework;
console.log(`framework: ${framework.kpis.length} KPIs, methods ${[...new Set(framework.kpis.map(k => k.method))].join(', ')}, draft ${designed.draftId.slice(0, 8)}`);

// 2. Real SEC filings for Enphase Energy, linked to a security through OpenFIGI.
const cik = '0001463101';
const submissions = await (await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'user-agent': ua } })).json() as { filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[] } } };
const recent = submissions.filings.recent;
const tenKs = recent.form.flatMap((form, i) => form === '10-K' ? [{ accession: recent.accessionNumber[i]!, filedAt: recent.filingDate[i]! }] : []).slice(0, 2);
console.log('10-K filings', JSON.stringify(tenKs));
console.log('security', JSON.stringify(await createSecSecurityProvider({ db, userAgent: ua }).sync({ tickers: ['ENPH'] })));
console.log('filings', JSON.stringify(await createSecEdgarProvider({ db, userAgent: ua }).sync({ cik, accessions: tenKs.map(t => t.accession) })));
const [link] = await db.select({ securityId: figiMappings.securityId, name: securities.name }).from(secListings).innerJoin(figiMappings, eq(figiMappings.listingId, secListings.id)).innerJoin(securities, eq(securities.id, figiMappings.securityId)).where(eq(secListings.ticker, 'ENPH'));
if (!link?.securityId) throw new Error('ENPH did not resolve to a security');
const issuerKeys = await issuerKeysForSecurity(db, link.securityId);
console.log(`security ${link.name} ${link.securityId.slice(0, 8)} issuers ${JSON.stringify(issuerKeys)}`);

// 3. Prices for the market quant functions, when an EODHD key is set.
if (process.env.EODHD_API_KEY) {
  const eodhd = createEodhdProvider({ db, apiKey: process.env.EODHD_API_KEY });
  console.log('prices', JSON.stringify(await eodhd?.sync({ symbols: ['ENPH.US'], from: addDays(today, -430), to: today })));
}

// 4. Snapshot, then index the filings with real embeddings.
const snapshot = await createSnapshot({ db });
const embedder = await createEmbedder({ db, apiKey });
const indexed = await indexDocuments({ db, embedder, kinds: ['sec_filing'], issuerKeys });
console.log('indexed', JSON.stringify(indexed));
const retriever = createRetriever({ db, embedder });

// 5. Score every KPI with the real Analyst.
const asOf = today;
const started = performance.now();
const ctx = { db, gateway, retriever, runId: run.id, frameworkDraftId: designed.draftId, snapshotId: snapshot.id, asOf, security: { id: link.securityId, name: link.name, symbol: 'ENPH.US', ciks: [cik], issuerKeys } };
const outcomes = await scoreFramework(ctx, framework, { concurrency: 3 });
console.log(`scored ${outcomes.length} KPIs in ${((performance.now() - started) / 1000).toFixed(1)}s`);

const rows = await db.select().from(kpiScores).where(eq(kpiScores.runId, run.id)).orderBy(asc(kpiScores.kpiId), asc(kpiScores.attempt));
let traceable = 0, citationsChecked = 0, verbatim = 0;
for (const k of framework.kpis) {
  const o = outcomes[framework.kpis.indexOf(k)]!;
  const attempts = rows.filter(r => r.kpiId === k.id);
  console.log(`\n${k.id} [${k.method}${k.isGate ? ', gate' : ''}] level=${o.level} value=${o.extractedValue ?? o.quantValue ?? '-'} confidence=${o.confidence} valid=${o.valid} attempts=${attempts.length} citations=${o.citations.length}`);
  const final = attempts.at(-1);
  if (final?.rationale) console.log(`  rationale: ${final.rationale.slice(0, 260)}`);
  for (const a of attempts.filter(x => !x.valid)) console.log(`  rejected attempt ${a.attempt}: ${(a.errors as Array<{ code: string; message: string }>).map(e => `${e.code} (${e.message.slice(0, 90)})`).join('; ')}`);
  for (const c of o.citations) {
    citationsChecked++;
    const text = await extractedTextFor(db, c.docKind, c.docId);
    const chunk = text?.slice(c.startOffset, c.endOffset) ?? '';
    const found = chunk.replace(/\s+/g, ' ').includes(c.quote);
    if (found) verbatim++;
    const [filing] = await db.select({ accession: secFilings.accession, filedAt: secFilings.filedAt, form: secFilings.form }).from(secFilings).where(eq(secFilings.id, c.docId));
    if (found && filing) traceable++;
    console.log(`  cite ${c.evidenceId} -> chunk ${c.chunkId.slice(0, 8)} -> ${filing?.form} ${filing?.accession} filed ${filing?.filedAt} | ${c.section.slice(0, 30)} offsets ${c.startOffset}-${c.endOffset} | quote found in stored source: ${found} | "${c.quote.slice(0, 100)}"`);
  }
  if (o.level === 'unknown' && o.valid && k.method !== 'quant') console.log('  (unknown: the passages did not support a level)');
}
console.log(`\ncitations ${citationsChecked}, quotes found verbatim in the stored source ${verbatim}, traceable to a filing ${traceable}`);

// 6. Every registered quant function on real data.
console.log('\nquant functions for ENPH.US as of', asOf);
for (const id of quantIds) {
  const r = await computeQuant({ db, snapshotId: snapshot.id, asOf, quantId: id, symbol: 'ENPH.US', ciks: [cik] });
  const trace = r.inputs.filter(i => i.kind === 'fact').map(i => i.kind === 'fact' ? `${i.concept}=${i.value} (${i.periodEnd}, ${i.accession})` : '').join(' / ');
  console.log(`  ${id.padEnd(20)} ${r.value === null ? 'null'.padEnd(12) : String(Number(r.value.toPrecision(6))).padEnd(12)} ${r.note ?? ''} ${trace}`);
}

// 7. The audit trail.
const calls = await db.select().from(llmCalls).where(and(eq(llmCalls.runId, run.id), inArray(llmCalls.role, ['analyst', 'designer'])));
const cost = calls.reduce((s, c) => s + Number(c.cost ?? 0), 0);
console.log(`\nmodel calls ${calls.length} (designer ${calls.filter(c => c.role === 'designer').length}, analyst ${calls.filter(c => c.role === 'analyst').length}), models ${[...new Set(calls.map(c => `${c.model} via ${c.provider}`))].join('; ')}, total cost $${cost.toFixed(4)}`);
console.log(`scores saved ${rows.length}, valid ${rows.filter(r => r.valid).length}, invalid attempts ${rows.filter(r => !r.valid).length}`);

if (record) {
  const fixture: Array<{ kpiId: string; evidence: EvidenceItem[]; attempts: Array<{ output: unknown; valid: boolean; errorCodes: string[] }> }> = [];
  for (const k of framework.kpis.filter(x => x.method !== 'quant')) {
    const attempts = rows.filter(r => r.kpiId === k.id && r.raw);
    const refs = (attempts.at(-1)?.evidence ?? []) as Array<Omit<EvidenceItem, 'text' | 'issuerKey'>>;
    const evidence: EvidenceItem[] = [];
    for (const ref of refs) {
      const text = await extractedTextFor(db, ref.docKind, ref.docId);
      evidence.push({ ...ref, issuerKey: issuerKeys[0] ?? '', text: text?.slice(ref.startOffset, ref.endOffset) ?? '' });
    }
    fixture.push({ kpiId: k.id, evidence, attempts: attempts.map(a => ({ output: a.raw, valid: a.valid, errorCodes: (a.errors as Array<{ code: string }>).map(e => e.code) })) });
  }
  await writeFile(new URL('../fixtures/analyst-real-scores.json', import.meta.url), `${JSON.stringify({ recordedAt: new Date().toISOString(), asOf, company: link.name, symbol: 'ENPH.US', issuerKey: issuerKeys[0], framework, items: fixture }, null, 1)}\n`);
  console.log('recorded the real evidence and model outputs');
}
await sql.end();
const bad = rows.filter(r => !r.valid).length;
if (verbatim !== citationsChecked) { console.error('LIVE CHECK FAILED: a citation was not found verbatim in the stored source'); process.exitCode = 1; }
void bad;
