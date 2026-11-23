import { z } from 'zod';
import { leakageProbe, maskLeaks } from './leakage.js';
import { levelSchema, levelStability, weightedKappa, type KappaResult, type RubricLevel, type StabilityResult } from './kappa.js';
import { kpiRecordSchema, relevanceRecordSchema, reviewerRecordSchema, type RelevanceRecord, type ReviewerRecord } from './manifest.js';

/** The spec's gates for the Phase 2 labelled sets. */
export const phase2Gates = { weightedKappa: 0.6, stability: 0.95, reviewerCatch: 0.8, prescreenRecall: 0.95 } as const;

/**
 * Frozen before any live scoring. A masked rerun is compared level by level on the pairs both runs answered:
 * - a change between two levels 0 to 4 counts as `changed`, and as `large` when it spans `largeChange` levels or more;
 * - a change to or from `unknown` counts as `toUnknown` or `fromUnknown`, never as a level distance, and never as `large`;
 * - a pair only one run answered is counted apart and is left out.
 * A large change signals possible reliance on memory. It is not proof.
 */
export const maskingPolicy = { largeChange: 2 } as const;

const ratio = (k: number, n: number) => (n === 0 ? null : k / n);

export type ReviewerMetrics = {
  flawed: { n: number; caught: number; missing: number };
  clean: { n: number; falseAlarms: number; missing: number };
  /** Caught flawed scores over the flawed scores with a verdict. Null when none has one. */
  catchRate: number | null;
  /** Flagged clean scores over the clean scores with a verdict. Null when none has one. */
  falseAlarmRate: number | null;
  /** Verdicts for ids that are in no record. */
  unknownVerdicts: number;
};

export function reviewerMetrics(records: readonly ReviewerRecord[], verdicts: Readonly<Record<string, { flagged: boolean }>>): ReviewerMetrics {
  const flawed = { n: 0, caught: 0, missing: 0 }, clean = { n: 0, falseAlarms: 0, missing: 0 };
  for (const r of records) {
    const bucket = r.flaw === 'none' ? clean : flawed;
    bucket.n++;
    const v = Object.hasOwn(verdicts, r.id) ? verdicts[r.id]! : null;
    if (!v) bucket.missing++;
    else if (v.flagged) { if (r.flaw === 'none') clean.falseAlarms++; else flawed.caught++; }
  }
  const ids = new Set(records.map(r => r.id));
  return {
    flawed, clean,
    catchRate: ratio(flawed.caught, flawed.n - flawed.missing),
    falseAlarmRate: ratio(clean.falseAlarms, clean.n - clean.missing),
    unknownVerdicts: Object.keys(verdicts).filter(id => !ids.has(id)).length,
  };
}

export type PrescreenMetrics = {
  relevant: { n: number; kept: number; missing: number };
  notRelevant: { n: number; kept: number; missing: number };
  /** Relevant names kept over relevant names with a decision. The name is kept when the screen is unsure or has no evidence, so those count as kept. */
  recall: number | null;
  /** Relevant names kept over all names kept. */
  precision: number | null;
  funnel: { total: number; kept: number; dropped: number; missing: number };
  falseNegatives: string[];
};

export function prescreenMetrics(records: readonly RelevanceRecord[], kept: Readonly<Record<string, boolean>>): PrescreenMetrics {
  const relevant = { n: 0, kept: 0, missing: 0 }, notRelevant = { n: 0, kept: 0, missing: 0 };
  const falseNegatives: string[] = [];
  for (const r of records) {
    const bucket = r.relevant ? relevant : notRelevant;
    bucket.n++;
    if (!Object.hasOwn(kept, r.id)) bucket.missing++;
    else if (kept[r.id]) bucket.kept++;
    else if (r.relevant) falseNegatives.push(r.id);
  }
  const keptTotal = relevant.kept + notRelevant.kept, missing = relevant.missing + notRelevant.missing;
  return {
    relevant, notRelevant,
    recall: ratio(relevant.kept, relevant.n - relevant.missing),
    precision: ratio(relevant.kept, keptTotal),
    funnel: { total: records.length, kept: keptTotal, dropped: records.length - keptTotal - missing, missing },
    falseNegatives,
  };
}

export type MaskingComparison = {
  compared: number; onlyUnmasked: number; onlyMasked: number;
  unchanged: number; changed: number; large: number; toUnknown: number; fromUnknown: number;
  /** Mean absolute level distance over pairs that changed between two levels 0 to 4. Null when none did. */
  meanChange: number | null;
  /** Share of compared pairs with a large change. */
  largeRate: number | null;
};

export function maskingComparison(unmasked: Readonly<Record<string, RubricLevel>>, masked: Readonly<Record<string, RubricLevel>>): MaskingComparison {
  let compared = 0, unchanged = 0, changed = 0, large = 0, toUnknown = 0, fromUnknown = 0, distance = 0, onlyUnmasked = 0;
  for (const [id, a] of Object.entries(unmasked)) {
    if (!Object.hasOwn(masked, id)) { onlyUnmasked++; continue; }
    const b = masked[id]!;
    compared++;
    if (a === b) unchanged++;
    else if (b === 'unknown') toUnknown++;
    else if (a === 'unknown') fromUnknown++;
    else {
      const d = Math.abs(Number(a) - Number(b));
      changed++; distance += d;
      if (d >= maskingPolicy.largeChange) large++;
    }
  }
  return { compared, onlyUnmasked, onlyMasked: Object.keys(masked).length - compared, unchanged, changed, large, toUnknown, fromUnknown, meanChange: ratio(distance, changed), largeRate: ratio(large, compared) };
}

/** A scorer's answer to a pair. The rationale and evidence are optional, and the leakage probe needs both. */
const answerSchema = z.object({ level: levelSchema, rationale: z.string().optional() }).strict();
const runSchema = z.record(z.string(), answerSchema);

/** Everything the metrics mode reads: labels from the manifests and what the scorers, the Reviewer and the pre-screen answered. A section may be absent. */
export const metricsInputSchema = z.object({
  schemaVersion: z.literal(1),
  /** Printed with the report. A fixture or provisional input says so. */
  provenance: z.string().min(1),
  kpi: z.object({
    records: z.array(kpiRecordSchema),
    runs: z.array(runSchema).min(1).max(2),
    masked: z.record(z.string(), levelSchema).optional(),
    /** Cited passage text by pair id, for the leakage probe. */
    evidence: z.record(z.string(), z.array(z.string())).optional(),
    /** Names and tickers to look for in masked evidence, by pair id. */
    maskedEvidence: z.record(z.string(), z.object({ text: z.string(), names: z.array(z.string()) }).strict()).optional(),
  }).strict().optional(),
  reviewer: z.object({ records: z.array(reviewerRecordSchema), verdicts: z.record(z.string(), z.object({ flagged: z.boolean() }).strict()) }).strict().optional(),
  relevance: z.object({ records: z.array(relevanceRecordSchema), kept: z.record(z.string(), z.boolean()) }).strict().optional(),
}).strict();
export type MetricsInput = z.infer<typeof metricsInputSchema>;

export type KpiMetrics = {
  /** Pairs in the labels, and how many the first run answered. */
  pairs: number; answered: number; missing: number;
  agreement: KappaResult;
  /** Share of answered pairs the first run called unknown, and the label called unknown. */
  unknownRate: number | null; labelUnknownRate: number | null;
  stability: StabilityResult | null;
  masking: MaskingComparison | null;
  leakage: { probed: number; flagged: number; flaggedIds: string[] } | null;
  maskLeaks: { checked: number; leaking: number; leakingIds: string[] } | null;
};

export function kpiMetrics(input: NonNullable<MetricsInput['kpi']>): KpiMetrics {
  const first = input.runs[0]!;
  const answered = input.records.filter(r => Object.hasOwn(first, r.id));
  const level = (run: z.infer<typeof runSchema>) => Object.fromEntries(Object.entries(run).map(([id, a]) => [id, a.level]));
  const probed = input.evidence ? answered.filter(r => first[r.id]!.rationale !== undefined && Object.hasOwn(input.evidence!, r.id)) : [];
  const flaggedIds = probed.filter(r => leakageProbe({ rationale: first[r.id]!.rationale!, evidence: input.evidence![r.id]! }).flagged).map(r => r.id);
  const maskedChecks = Object.entries(input.maskedEvidence ?? {});
  const leakingIds = maskedChecks.filter(([, v]) => maskLeaks(v.text, v.names).length > 0).map(([id]) => id);
  return {
    pairs: input.records.length, answered: answered.length, missing: input.records.length - answered.length,
    agreement: weightedKappa(answered.map(r => [first[r.id]!.level, r.level] as const)),
    unknownRate: ratio(answered.filter(r => first[r.id]!.level === 'unknown').length, answered.length),
    labelUnknownRate: ratio(input.records.filter(r => r.level === 'unknown').length, input.records.length),
    stability: input.runs[1] ? levelStability(level(first), level(input.runs[1])) : null,
    masking: input.masked ? maskingComparison(level(first), input.masked) : null,
    leakage: input.evidence ? { probed: probed.length, flagged: flaggedIds.length, flaggedIds } : null,
    maskLeaks: input.maskedEvidence ? { checked: maskedChecks.length, leaking: leakingIds.length, leakingIds } : null,
  };
}

export type GateStatus = 'pass' | 'fail' | 'incomplete';
export type MetricGate = { required: number; measured: number | null; denominator: number; status: GateStatus; reason: string };
export type MetricsReport = {
  schemaVersion: 1; provenance: string;
  kpi: KpiMetrics | null; reviewer: ReviewerMetrics | null; prescreen: PrescreenMetrics | null;
  gates: { weightedKappa: MetricGate | null; stability: MetricGate | null; reviewerCatch: MetricGate | null; prescreenRecall: MetricGate | null };
};

function gate(required: number, measured: number | null, denominator: number, missing: number, what: string): MetricGate {
  if (measured === null || denominator === 0) return { required, measured, denominator, status: 'incomplete', reason: `${what} is undefined: no usable denominator` };
  if (missing > 0) return { required, measured, denominator, status: 'incomplete', reason: `${missing} records have no answer, so ${what} is not a result` };
  const pass = measured >= required;
  return { required, measured, denominator, status: pass ? 'pass' : 'fail', reason: pass ? `${what} ${measured} is at least ${required}` : `${what} ${measured} is below ${required}` };
}

/** Computes every metric the input has data for, with denominators, unknowns and exclusions. A gate is `pass` only with a defined value, no missing record and a value at the threshold. */
export function buildMetricsReport(input: MetricsInput): MetricsReport {
  const kpi = input.kpi ? kpiMetrics(input.kpi) : null;
  const reviewer = input.reviewer ? reviewerMetrics(input.reviewer.records, input.reviewer.verdicts) : null;
  const prescreen = input.relevance ? prescreenMetrics(input.relevance.records, input.relevance.kept) : null;
  const g = phase2Gates;
  return {
    schemaVersion: 1, provenance: input.provenance, kpi, reviewer, prescreen,
    gates: {
      weightedKappa: kpi && gate(g.weightedKappa, kpi.agreement.kappa, kpi.agreement.n, kpi.missing, 'weighted kappa'),
      stability: kpi?.stability ? gate(g.stability, kpi.stability.stability, kpi.stability.n, kpi.stability.onlyInA + kpi.stability.onlyInB, 'stability') : kpi ? { required: g.stability, measured: null, denominator: 0, status: 'incomplete', reason: 'no second run' } : null,
      reviewerCatch: reviewer && gate(g.reviewerCatch, reviewer.catchRate, reviewer.flawed.n - reviewer.flawed.missing, reviewer.flawed.missing + reviewer.clean.missing, 'Reviewer catch rate'),
      prescreenRecall: prescreen && gate(g.prescreenRecall, prescreen.recall, prescreen.relevant.n - prescreen.relevant.missing, prescreen.funnel.missing, 'pre-screen recall'),
    },
  };
}
