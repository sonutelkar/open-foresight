import { hashRecords, missingPolicy, type KpiRecord, type Manifest, type RelevanceRecord, type ReviewerRecord } from './manifest.js';
import type { MetricsInput } from './metrics.js';
import type { RubricLevel } from './kappa.js';

/** Seeded generator of fixture data. It makes tooling inputs, never release data, so every manifest it builds has `fixture: true`. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const syntheticThemes = ['smart-energy', 'cybersecurity', 'robotics-ai'] as const;
const scorerVendors = ['openai', 'jev'];
const labellers = [{ name: 'labeller-a', kind: 'ai' as const, vendor: 'anthropic', model: 'labeller-a' }];

export type SyntheticSizes = { kpi: number; flawed: number; clean: number; relevance: number };
export const releaseSizes: SyntheticSizes = { kpi: 200, flawed: 100, clean: 50, relevance: 500 };

function wrap<K extends Manifest['kind']>(kind: K, records: Extract<Manifest, { kind: K }>['records'], seed: number, humanChecked: number): Extract<Manifest, { kind: K }> {
  return {
    schemaVersion: 1, manifestId: `fixture-${kind}`, version: 1, supersedes: null, createdAt: '2026-11-23T00:00:00.000Z', fixture: true,
    provenance: 'ai-generated-human-sampled', themes: [...syntheticThemes], labellers, scorerVendors,
    sampling: { seed, requested: records.length, pool: records.length }, adjudication: { method: 'single-ai-labeller', adjudicators: [] },
    humanSample: { n: humanChecked, agreed: humanChecked, reviewers: ['fixture-colleague'] },
    missingPolicy: { ...missingPolicy }, contentHash: hashRecords(records), kind, records,
  } as unknown as Extract<Manifest, { kind: K }>;
}

/** Manifests and scorer answers of a given size. The scorer agrees with the labels about 90% of the time, the Reviewer catches about 85% and the screen keeps about 97% of relevant names. */
export function syntheticRelease(seed = 20261123, sizes: SyntheticSizes = releaseSizes) {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const base = (prefix: string, i: number) => ({ id: `${prefix}-${i}`, theme: syntheticThemes[i % syntheticThemes.length]!, symbol: `S${i}`, snapshotId: 'snap-1', labelledBy: 'labeller-a' });
  const levels: RubricLevel[] = ['0', '1', '2', '3', '4'];

  const kpiRecords: KpiRecord[] = Array.from({ length: sizes.kpi }, (_, i) => ({ ...base('kpi', i), kpiId: `kpi-${i % 7}`, evidenceIds: [`c${i}-a`, `c${i}-b`], level: pick(levels) }));
  const noisy = (l: RubricLevel, p: number): RubricLevel => (l === 'unknown' || rand() >= p ? l : String(Math.max(0, Math.min(4, Number(l) + (rand() < 0.5 ? -1 : 1)))) as RubricLevel);
  const runA = Object.fromEntries(kpiRecords.map(r => [r.id, { level: noisy(r.level, 0.1), rationale: `Revenue grew ${i2(r.id)} percent` }]));
  const runB = Object.fromEntries(kpiRecords.map(r => [r.id, { level: noisy(runA[r.id]!.level, 0.03) }]));
  const masked = Object.fromEntries(kpiRecords.map(r => [r.id, noisy(runA[r.id]!.level, 0.05)]));
  const evidence = Object.fromEntries(kpiRecords.map(r => [r.id, [`Revenue grew ${i2(r.id)} percent in the year.`]]));

  const flawedKinds = ['wrong_issuer', 'stale_evidence', 'talk_without_numbers'] as const;
  const reviewerRecords: ReviewerRecord[] = [
    ...Array.from({ length: sizes.flawed }, (_, i) => ({ ...base('rev', i), kpiId: `kpi-${i % 7}`, evidenceIds: [`r${i}-a`], flaw: flawedKinds[i % 3]! })),
    ...Array.from({ length: sizes.clean }, (_, i) => ({ ...base('rev', sizes.flawed + i), kpiId: `kpi-${i % 7}`, evidenceIds: [`r${sizes.flawed + i}-a`], flaw: 'none' as const })),
  ];
  const verdicts = Object.fromEntries(reviewerRecords.map(r => [r.id, { flagged: r.flaw === 'none' ? rand() < 0.1 : rand() < 0.85 }]));

  const relevanceRecords: RelevanceRecord[] = Array.from({ length: sizes.relevance }, (_, i) => ({ ...base('rel', i), evidenceIds: i % 25 === 0 ? [] : [`p${i}-a`], relevant: i % 3 === 0 }));
  const kept = Object.fromEntries(relevanceRecords.map(r => [r.id, r.relevant ? rand() < 0.97 : rand() < 0.4]));

  const humanChecked = (n: number) => Math.ceil(n * 0.1);
  return {
    manifests: { kpi: wrap('kpi', kpiRecords, seed, humanChecked(kpiRecords.length)), reviewer: wrap('reviewer', reviewerRecords, seed, humanChecked(reviewerRecords.length)), relevance: wrap('relevance', relevanceRecords, seed, humanChecked(relevanceRecords.length)) },
    metricsInput: {
      schemaVersion: 1, provenance: 'fixture: synthetic data, not release data',
      kpi: { records: kpiRecords, runs: [runA, runB], masked, evidence },
      reviewer: { records: reviewerRecords, verdicts },
      relevance: { records: relevanceRecords, kept },
    } satisfies MetricsInput,
  };
}
const i2 = (id: string) => String(10 + (Number(id.split('-')[1]) % 80));

/** The 1,000 record input of the perf check: 400 KPI pairs, 200 reviewer scores (150 flawed) and 400 relevance labels. */
export const perfSizes: SyntheticSizes = { kpi: 400, flawed: 150, clean: 50, relevance: 400 };
