import { hashRecords, missingPolicy, type KpiRecord, type Manifest, type RelevanceRecord, type ReviewerRecord } from './manifest.js';
import type { MetricsInput } from './metrics.js';
import type { RubricLevel } from './kappa.js';
import type { ReviewerInput } from '@open-foresight/core';
import type { ReviewerFixture } from './reviewer.js';

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

const fixtureKpi: ReviewerInput['kpi'] = {
  name: 'Grid revenue share', definition: 'Share of total revenue from grid equipment and grid services.', lookbackDays: 730,
  rubric: {
    levels: { 0: 'No grid revenue is disclosed.', 1: 'Grid revenue is below 10% of total revenue.', 2: 'Grid revenue is 10% to 25% of total revenue.', 3: 'Grid revenue is 25% to 50% of total revenue.', 4: 'Grid revenue is above 50% of total revenue.' },
    unknown: 'The passages state no share of revenue for grid products.',
  },
};
const answer = (verdict: string, issue: string, note: string, suggestedLevel: string | null = null) => JSON.stringify({ verdict, issue, note, suggestedLevel });
const caughtIssue = { wrong_issuer: 'wrong_entity', stale_evidence: 'stale_evidence', talk_without_numbers: 'talk_not_numbers' } as const;
const caughtNote = {
  wrong_entity: 'Passage e1 reports the revenue of a different company, so it is no evidence for this one.',
  stale_evidence: 'Passage e1 is from 2019, outside the 730 day lookback to the as-of date.',
  talk_not_numbers: 'Passage e1 states plans only. Level 3 needs a disclosed share of revenue.',
  unsupported_level: 'Passage e1 states no share of revenue, so it cannot support level 3.',
} as const;
const invalidFlawed: Record<number, string> = {
  19: answer('reject', 'wrong_entity', 'Passage e1 is about another company.'),
  39: answer('retry', 'stale_evidence', 'Passage e1 is old. '.repeat(24)),
  59: JSON.stringify({ verdict: 'retry', note: 'Passage e1 states plans only.', suggestedLevel: null }),
  79: 'The score looks fine to me.',
};

/**
 * The input of the `reviewer-fixture` mode: 80 flawed and 20 clean scores, each with the Reviewer input and an answer in the recorded format.
 * The answers are written here by rule, not by a model. Flawed index i: i % 20 == 19 is an invalid output, i % 10 == 4 is missed (accepted), the rest are caught.
 * Clean index j: 19 is an invalid output, 2, 8 and 14 are false alarms, the rest are accepted. So catch is 68 of 76 and false alarm 3 of 19, with 5 invalid outputs.
 */
export function syntheticReviewerFixture() {
  const flawedKinds = ['wrong_issuer', 'stale_evidence', 'talk_without_numbers'] as const;
  const records: ReviewerRecord[] = Array.from({ length: 100 }, (_, i) => ({
    id: `rvf-${i}`, theme: syntheticThemes[i % syntheticThemes.length]!, symbol: `S${i}`, snapshotId: 'snap-1', labelledBy: 'labeller-a',
    kpiId: 'grid_revenue_share', evidenceIds: [`chunk-${i}`], flaw: i < 80 ? flawedKinds[i % 3]! : 'none',
  }));
  const calls = Object.fromEntries(records.map((r, i) => {
    const company = `Company ${i} Inc`, own = `cik:${String(1000 + i).padStart(10, '0')}`;
    const passage = {
      wrong_issuer: { issuer: `cik:${String(9000 + i).padStart(10, '0')}`, availableOn: '2026-03-02', text: `Other Holdings ${i} Corp reported that its grid segment generated 31% of total revenue in fiscal 2025.` },
      stale_evidence: { issuer: own, availableOn: '2019-02-15', text: `${company} reported that grid products generated 28% of total revenue in fiscal 2018.` },
      talk_without_numbers: { issuer: own, availableOn: '2026-03-02', text: `${company} plans to become a leader in grid modernisation and sees strong demand ahead.` },
      none: { issuer: own, availableOn: '2026-03-02', text: `${company} reported that grid products generated ${12 + (i % 10)}% of total revenue in fiscal 2025.` },
    }[r.flaw];
    const input: ReviewerInput = { score: { company, symbol: r.symbol, asOf: '2026-11-20', level: r.flaw === 'none' ? '2' : '3' }, kpi: fixtureKpi, passages: [{ id: 'e1', chunkId: r.evidenceIds[0]!, section: 'Item 7. Management discussion', ...passage }] };
    let response: string;
    if (r.flaw !== 'none') {
      const issue = r.flaw === 'talk_without_numbers' && i % 9 === 2 ? 'unsupported_level' : caughtIssue[r.flaw];
      const verdict = issue === 'wrong_entity' || i % 2 === 1 ? 'escalate' : 'retry';
      response = invalidFlawed[i] ?? (i % 10 === 4 ? answer('accept', 'none', 'Passage e1 supports level 3.') : answer(verdict, issue, caughtNote[issue], verdict === 'retry' ? 'unknown' : null));
    } else {
      const j = i - 80;
      response = j === 19 ? JSON.stringify({ verdict: 'accept', issue: 'none', note: 'Passage e1 supports level 2.', suggestedLevel: null, reasoning: 'hidden' })
        : j === 2 ? answer('retry', 'conflict', 'Passage e1 could be read as level 2 or 3.')
        : j === 8 ? answer('escalate', 'other', 'The fiscal year of passage e1 is unclear.')
        : j === 14 ? answer('retry', 'unsupported_level', 'Passage e1 supports level 1 at most.', '1')
        : answer('accept', 'none', 'Passage e1 discloses a grid share of revenue within level 2.');
    }
    return [r.id, { input, response }];
  }));
  const manifest = { ...wrap('reviewer', records, 20261123, Math.ceil(records.length * 0.1)), manifestId: 'fixture-reviewer-100' };
  return { schemaVersion: 1 as const, provenance: 'fixture: Reviewer answers written by syntheticReviewerFixture in the recorded format, not model output', manifest, calls } satisfies ReviewerFixture;
}
