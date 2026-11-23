import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { levelStability, weightedKappa, type RubricLevel } from './kappa.js';
import { leakageProbe, maskLeaks } from './leakage.js';
import { hashRecords, provisionalKpiManifest, type Manifest } from './manifest.js';
import { buildMetricsReport, maskingComparison, metricsInputSchema, prescreenMetrics, reviewerMetrics, type MetricsInput } from './metrics.js';
import { runPhase2 } from './phase2.js';
import { perfSizes, releaseSizes, syntheticRelease } from './synthetic.js';
import { parseManifest, validateRelease, validateReleaseSet } from './validate.js';
import type { LabelledSet } from './labels.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'phase2-')); dirs.push(d); return d; };
const clone = <T,>(x: T): T => structuredClone(x);
/** Rebuilds the hash after a test edits the records, so only the edit under test is wrong. */
const rehash = <T extends Manifest>(m: T): T => ({ ...m, contentHash: hashRecords(m.records) });
const release = syntheticRelease();
const okOpts = { allowFixture: true };

describe('metrics on 200 pairs, 100 flawed and 500 relevance records', () => {
  it('computes a known kappa', () => {
    // 200 pairs: 100 agree at level 1, 100 agree at level 3, then every pair moved by one level in a controlled way.
    const pairs: Array<[RubricLevel, RubricLevel]> = [...Array(80).fill(['1', '1']), ...Array(20).fill(['1', '2']), ...Array(80).fill(['3', '3']), ...Array(20).fill(['3', '2'])];
    const r = weightedKappa(pairs);
    // observed disagreement 40/200 = 0.2. Marginals: A has 100 at 1 and 100 at 3. B has 80 at 1, 40 at 2, 80 at 3. Expected = (100*80*1 + 100*40*1 + 100*40*1 + 100*80*1)/200^2... see below.
    expect(r.n).toBe(200);
    expect(r.exactAgreement).toBeCloseTo(0.8, 12);
    const expected = (100 * 80 * 0 + 100 * 40 * 1 + 100 * 80 * 4 + 100 * 80 * 4 + 100 * 40 * 1 + 100 * 80 * 0) / 200 ** 2;
    expect(r.kappa).toBeCloseTo(1 - 0.2 / expected, 12);
  });

  it('reports 95 of 100 identical as exactly 0.95 stability, with unknown a level', () => {
    const a: Record<string, RubricLevel> = {}, b: Record<string, RubricLevel> = {};
    for (let i = 0; i < 100; i++) { a[`p${i}`] = i % 10 === 0 ? 'unknown' : '2'; b[`p${i}`] = i < 95 ? a[`p${i}`]! : '3'; }
    expect(levelStability(a, b)).toMatchObject({ n: 100, identical: 95, stability: 0.95 });
  });

  it('counts 80 of 100 flawed scores caught as exactly 0.8 and passes the gate, 79 fails', () => {
    const records = Array.from({ length: 100 }, (_, i) => ({ ...release.manifests.reviewer.records[0]!, id: `f${i}`, flaw: 'wrong_issuer' as const }));
    const verdicts = (caught: number) => Object.fromEntries(records.map((r, i) => [r.id, { flagged: i < caught }]));
    expect(reviewerMetrics(records, verdicts(80)).catchRate).toBe(0.8);
    const gate = (caught: number) => buildMetricsReport({ schemaVersion: 1, provenance: 'test', reviewer: { records, verdicts: verdicts(caught) } }).gates.reviewerCatch;
    expect(gate(80)).toMatchObject({ status: 'pass', denominator: 100 });
    expect(gate(79)).toMatchObject({ status: 'fail', measured: 0.79 });
  });

  it('reports catch and false alarm over their own denominators', () => {
    const [a, b, c, d] = ['wrong_issuer', 'stale_evidence', 'none', 'none'].map((flaw, i) => ({ ...release.manifests.reviewer.records[0]!, id: `x${i}`, flaw: flaw as 'none' }));
    const m = reviewerMetrics([a!, b!, c!, d!], { x0: { flagged: true }, x1: { flagged: false }, x2: { flagged: true }, x3: { flagged: false }, ghost: { flagged: true } });
    expect(m).toMatchObject({ catchRate: 0.5, falseAlarmRate: 0.5, flawed: { n: 2, caught: 1 }, clean: { n: 2, falseAlarms: 1 }, unknownVerdicts: 1 });
  });

  it('computes pre-screen recall, precision and funnel, and keeps names with no evidence as kept', () => {
    const recs = [true, true, true, false, false].map((relevant, i) => ({ ...release.manifests.relevance.records[0]!, id: `n${i}`, relevant }));
    const m = prescreenMetrics(recs, { n0: true, n1: true, n2: false, n3: true, n4: false });
    expect(m).toMatchObject({ recall: 2 / 3, precision: 2 / 3, funnel: { total: 5, kept: 3, dropped: 2, missing: 0 }, falseNegatives: ['n2'] });
  });
});

describe('missing data and zero denominators never pass', () => {
  it('marks a gate incomplete when records have no answer', () => {
    const input = clone(release.metricsInput) as MetricsInput;
    delete input.reviewer!.verdicts[input.reviewer!.records[0]!.id];
    const r = buildMetricsReport(input);
    expect(r.reviewer!.flawed.missing + r.reviewer!.clean.missing).toBe(1);
    expect(r.gates.reviewerCatch!.status).toBe('incomplete');
  });
  it('marks every gate incomplete on empty sets, with null rates', () => {
    const r = buildMetricsReport({ schemaVersion: 1, provenance: 't', kpi: { records: [], runs: [{}] }, reviewer: { records: [], verdicts: {} }, relevance: { records: [], kept: {} } });
    expect(r.reviewer).toMatchObject({ catchRate: null, falseAlarmRate: null });
    expect(r.prescreen).toMatchObject({ recall: null, precision: null });
    expect(Object.values(r.gates).every(g => g?.status === 'incomplete')).toBe(true);
  });
  it('excludes unknown pairs from kappa, reports them, and does not pass an all-unknown run', () => {
    const recs = release.manifests.kpi.records.slice(0, 4).map(r => ({ ...r, level: 'unknown' as const }));
    const r = buildMetricsReport({ schemaVersion: 1, provenance: 't', kpi: { records: recs, runs: [Object.fromEntries(recs.map(x => [x.id, { level: 'unknown' as const }]))] } });
    expect(r.kpi!.agreement).toMatchObject({ n: 0, kappa: null, excluded: { unknownBoth: 4 } });
    expect(r.gates.weightedKappa!.status).toBe('incomplete');
  });
  it('fails (not incomplete) a full, measured set below the kappa threshold', () => {
    const recs = release.manifests.kpi.records.slice(0, 50).map((r, i) => ({ ...r, level: (i % 2 ? '0' : '4') as RubricLevel }));
    const run = Object.fromEntries(recs.map((x, i) => [x.id, { level: (i % 2 ? '4' : '0') as RubricLevel }]));
    expect(buildMetricsReport({ schemaVersion: 1, provenance: 't', kpi: { records: recs, runs: [run, run] } }).gates.weightedKappa).toMatchObject({ status: 'fail' });
  });
  it('rejects a metrics input with a duplicate or malformed section instead of passing it', () => {
    expect(metricsInputSchema.safeParse({ schemaVersion: 1, provenance: 't', extra: 1 }).success).toBe(false);
  });
});

describe('name masking', () => {
  it('counts level changes, large changes and unknown transitions apart', () => {
    const m = maskingComparison({ a: '1', b: '1', c: '0', d: '2', e: 'unknown', f: '3' }, { a: '1', b: '2', c: '3', d: 'unknown', e: '1', g: '0' });
    expect(m).toMatchObject({ compared: 5, unchanged: 1, changed: 2, large: 1, toUnknown: 1, fromUnknown: 1, onlyUnmasked: 1, onlyMasked: 1, meanChange: 2, largeRate: 0.2 });
  });
  it('flags a name that survives masking, whole words only', () => {
    expect(maskLeaks('Acme Corp sold 3 units; ACME grew.', ['Acme', 'XYZ'])).toEqual(['Acme']);
    expect(maskLeaks('Pineapple Inc', ['Apple'])).toEqual([]);
    expect(maskLeaks('the company [COMPANY] and [TICKER]', ['Acme', 'ACM'])).toEqual([]);
  });
});

describe('leakage probe', () => {
  const evidence = ['Revenue from smart meters was 1,200 million in 2024, up 12.5%.'];
  it('passes a rationale grounded in the evidence', () => {
    expect(leakageProbe({ rationale: 'Smart meters revenue was 1200 million in 2024, up 12.5%.', evidence }).flagged).toBe(false);
  });
  it('flags a number and an entity the evidence does not hold', () => {
    const r = leakageProbe({ rationale: 'The company, partnered with Siemens Energy, reached 3.4 billion in 2025.', evidence });
    expect(r.unsupportedNumbers).toEqual(['3.4', '2025']);
    expect(r.unsupportedEntities).toEqual(['siemens energy']);
    expect(r.flagged).toBe(true);
  });
});

describe('release validation', () => {
  const files = (m: typeof release.manifests = release.manifests) => Object.entries(m).map(([name, raw]) => ({ name, raw }));
  it('accepts a complete set only with the fixture flag', () => {
    expect(validateReleaseSet(files(), okOpts)).toEqual({ ok: true, errors: [] });
    expect(validateReleaseSet(files()).errors.join()).toMatch(/is a fixture/);
  });
  it('reports the sizes of a release-size fixture', () => {
    expect(release.manifests.kpi.records).toHaveLength(releaseSizes.kpi);
    expect(release.manifests.reviewer.records.filter(r => r.flaw !== 'none')).toHaveLength(100);
    expect(release.manifests.relevance.records).toHaveLength(500);
  });
  it('rejects a missing manifest', () => {
    expect(validateReleaseSet(files().slice(0, 2), okOpts).errors).toContain('missing the relevance manifest');
    expect(validateReleaseSet([], okOpts).ok).toBe(false);
  });
  it('rejects a duplicate record id', () => {
    const m = clone(release.manifests.kpi); m.records[1] = { ...m.records[1]!, id: m.records[0]!.id };
    expect(validateRelease(rehash(m), okOpts).errors.join()).toMatch(/Duplicate record kpi-0/);
  });
  it('rejects an edit that kept the old hash, and a changed theme list', () => {
    const m = clone(release.manifests.kpi); m.records[0] = { ...m.records[0]!, level: m.records[0]!.level === '4' ? '0' : '4' };
    expect(validateRelease(m, okOpts).errors.join()).toMatch(/contentHash does not match/);
    const t = clone(release.manifests.kpi); t.records[0] = { ...t.records[0]!, theme: 'other' };
    expect(validateRelease(rehash(t), okOpts).errors.join()).toMatch(/outside the manifest themes/);
  });
  it('rejects incomplete sets: too few records, too few themes, no clean control, no negatives', () => {
    const k = clone(release.manifests.kpi); k.records = k.records.slice(0, 199);
    expect(validateRelease(rehash(k), okOpts).errors.join()).toMatch(/199 KPI pairs, 200 required/);
    const th = clone(release.manifests.kpi); th.themes = th.themes.slice(0, 2); th.records = th.records.filter(r => th.themes.includes(r.theme));
    expect(validateRelease(rehash(th), okOpts).errors.join()).toMatch(/2 themes, 3 required/);
    const rv = clone(release.manifests.reviewer); rv.records = rv.records.filter(r => r.flaw !== 'none');
    expect(validateRelease(rehash(rv), okOpts).errors.join()).toMatch(/no clean control/);
    const rl = clone(release.manifests.relevance); rl.records = rl.records.map(r => ({ ...r, relevant: true }));
    expect(validateRelease(rehash(rl), okOpts).errors.join()).toMatch(/both relevant and not relevant/);
  });
  it('rejects provisional data', () => {
    const set: LabelledSet = { schemaVersion: 1, source: 'ai', provisional: true, labeller: { model: 'm', provider: 'google', promptVersion: 'v1' }, analyst: { model: 'a' }, runIds: ['00000000-0000-4000-8000-000000000000'], createdAt: '2026-11-23T00:00:00.000Z', sample: { requested: 1, pool: 1, seed: 1 }, note: 'n', pairs: [{ id: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000000', symbol: 'AAA', kpiId: 'k', method: 'judgement', analystLevel: '2', labelLevel: '2', labelRationale: 'r', chunkIds: ['c1'] }] };
    const m = provisionalKpiManifest(set, { manifestId: 'pilot', theme: 'smart-energy', snapshotId: 's' });
    expect(parseManifest(m)).toMatchObject({ ok: true });
    expect(validateRelease(m).errors.join()).toMatch(/provisional/);
  });
  it('rejects an AI labeller from a scorer vendor, a missing human spot check and a thin one', () => {
    const v = clone(release.manifests.kpi); v.labellers = [{ name: 'labeller-a', kind: 'ai', vendor: 'OpenAI' }];
    expect(validateRelease(v, okOpts).errors.join()).toMatch(/vendor of a scorer/);
    const n = clone(release.manifests.kpi); n.humanSample = null;
    expect(validateRelease(n, okOpts).errors.join()).toMatch(/no human spot check/);
    const t = clone(release.manifests.kpi); t.humanSample = { n: 5, agreed: 5, reviewers: ['x'] };
    expect(validateRelease(t, okOpts).errors.join()).toMatch(/covers 5 of 200 records, below 10%/);
    const s = clone(release.manifests.kpi); s.scorerVendors = [];
    expect(validateRelease(s, okOpts).errors.join()).toMatch(/independence cannot be checked/);
  });
  it('requires human labellers and an adjudicator for human provenance', () => {
    const h = clone(release.manifests.kpi); h.provenance = 'human';
    expect(validateRelease(h, okOpts).errors.join()).toMatch(/a labeller is not a human/);
    h.labellers = [{ name: 'labeller-a', kind: 'human' }, { name: 'b', kind: 'human' }];
    expect(validateRelease(h, okOpts).errors.join()).toMatch(/named adjudicator/);
  });
});

describe('phase2-eval CLI', () => {
  it('validate exits nonzero for a missing directory, an empty one and provisional data, zero for the fixture set', () => {
    expect(runPhase2(['--mode', 'validate', '--data', '/nonexistent-phase2']).code).toBe(1);
    expect(runPhase2(['--mode', 'validate', '--data', tmp()])).toMatchObject({ code: 1 });
    const d = tmp();
    for (const [k, m] of Object.entries(release.manifests)) writeFileSync(join(d, `${k}.json`), JSON.stringify(m));
    expect(runPhase2(['--mode', 'validate', '--data', d]).code).toBe(1);
    expect(runPhase2(['--mode', 'validate', '--data', d, '--allow-fixture'])).toMatchObject({ code: 0 });
    writeFileSync(join(d, 'broken.json'), '{nope');
    expect(runPhase2(['--mode', 'validate', '--data', d, '--allow-fixture']).stderr).toMatch(/broken.json: not valid JSON/);
  });
  it('refuses later modes and unknown arguments', () => {
    expect(runPhase2(['--mode', 'reviewer', '--data', '.']).code).toBe(2);
    expect(runPhase2(['--bogus']).code).toBe(1);
  });
  it('metrics prints a report and --strict fails on incomplete or failed gates', () => {
    const d = tmp(), file = join(d, 'in.json');
    writeFileSync(file, JSON.stringify(release.metricsInput));
    const ok = runPhase2(['--mode', 'metrics', '--data', file, '--strict']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).gates.reviewerCatch.denominator).toBe(100);
    const bad = clone(release.metricsInput) as MetricsInput; bad.reviewer!.verdicts = {};
    writeFileSync(file, JSON.stringify(bad));
    expect(runPhase2(['--mode', 'metrics', '--data', file]).code).toBe(0);
    expect(runPhase2(['--mode', 'metrics', '--data', file, '--strict']).code).toBe(1);
  });
});

describe('checked-in fixtures', () => {
  it('match the seeded builder, so they cannot drift', () => {
    const base = new URL('../fixtures/', import.meta.url);
    expect(JSON.parse(readFileSync(new URL('phase2-1000.json', base), 'utf8'))).toEqual(JSON.parse(JSON.stringify(syntheticRelease(20261123, perfSizes).metricsInput)));
    for (const [kind, m] of Object.entries(release.manifests)) expect(JSON.parse(readFileSync(new URL(`phase2-release/${kind}.json`, base), 'utf8'))).toEqual(JSON.parse(JSON.stringify(m)));
  });
  it('phase2-1000 holds 1,000 records and computes in well under the 30 second ceiling', () => {
    const input = metricsInputSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/phase2-1000.json', import.meta.url), 'utf8')));
    expect(input.kpi!.records.length + input.reviewer!.records.length + input.relevance!.records.length).toBe(1000);
    const t = performance.now();
    buildMetricsReport(input);
    expect(performance.now() - t).toBeLessThan(30_000);
  });
});
