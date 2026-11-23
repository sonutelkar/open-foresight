import { levelStability, weightedKappa, type KappaResult, type RubricLevel, type StabilityResult } from './kappa.js';
import { provisionalLabel, type LabelledSet } from './labels.js';
import { releaseGateThresholds } from './pilot.js';

/** One pass of a scorer over the labelled pairs, keyed by pair id. A pair the scorer failed on is absent. `confidence` is null when the scorer gives none. */
export type SideRun = Readonly<Record<string, { level: RubricLevel; confidence: number | null }>>;
export type BakeOffSide = {
  name: string; model: string;
  /** The first pass gives agreement, unknowns and calibration. A second pass, made with caching off, gives stability against the first. */
  runs: readonly [SideRun] | readonly [SideRun, SideRun];
  /** What one pass over the compared pairs cost. Null for a level read back from the store, which cost nothing to read. */
  cost: { usd: number; calls: number; medianLatencyMs: number | null } | null;
};

export type Calibration = {
  /** Pairs where the side and the label both gave a level and the side gave a confidence. The outcome is an exact match with the label. */
  n: number;
  /** Mean squared gap between confidence and outcome. 0 is perfect, and always answering 0.5 scores 0.25. */
  brier: number;
  /** Expected calibration error over the bins: the pair-weighted mean gap between mean confidence and the match rate. */
  ece: number;
  bins: Array<{ from: number; to: number; n: number; meanConfidence: number | null; matchRate: number | null }>;
};
export type SideReport = {
  name: string; model: string;
  /** Labelled pairs this side has no answer for, because its call failed. They are left out of every side's numbers. */
  missing: number;
  /** The side as rater A against the label as rater B, quadratic weights, on pairs where both gave a level. */
  agreement: KappaResult;
  /** Share of compared pairs the side answered unknown. */
  unknownRate: number | null;
  stability: StabilityResult | null;
  calibration: Calibration | null;
  cost: (NonNullable<BakeOffSide['cost']> & { usdPerCall: number | null }) | null;
};
const releaseGate = <T extends number>(required: T) => ({ required, satisfied: false as const, reason: 'The labelled set is AI-generated and provisional, and this release gate needs a human-labelled set.' });
export type BakeOffReport = {
  schemaVersion: 1;
  label: typeof provisionalLabel;
  labels: { source: 'ai'; model: string; pairs: number; unknownRate: number | null };
  /** Pairs every side answered. Every number below is over these, so each side is judged on the same pairs and the same evidence. */
  compared: number;
  sides: SideReport[];
  releaseGates: { weightedKappa: ReturnType<typeof releaseGate<0.6>>; stability: ReturnType<typeof releaseGate<0.95>> };
};

const binEdges = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

/** Brier score and binned reliability of a confidence as a forecast that the level matches the label exactly. A confidence of 1 falls in the top bin. */
export function calibration(points: ReadonlyArray<{ confidence: number; match: boolean }>): Calibration | null {
  if (points.length === 0) return null;
  const y = (p: { match: boolean }) => (p.match ? 1 : 0);
  const brier = points.reduce((s, p) => s + (p.confidence - y(p)) ** 2, 0) / points.length;
  const bins = binEdges.slice(0, -1).map((from, i) => {
    const to = binEdges[i + 1]!;
    const inBin = points.filter(p => p.confidence >= from && (p.confidence < to || (to === 1 && p.confidence <= 1)));
    const n = inBin.length;
    return { from, to, n, meanConfidence: n ? inBin.reduce((s, p) => s + p.confidence, 0) / n : null, matchRate: n ? inBin.reduce((s, p) => s + y(p), 0) / n : null };
  });
  const ece = bins.reduce((s, b) => s + (b.n === 0 ? 0 : (b.n / points.length) * Math.abs(b.meanConfidence! - b.matchRate!)), 0);
  return { n: points.length, brier, ece, bins };
}

/**
 * Compares scorers on one labelled set. Every number is over the pairs that every side answered, so no side is judged on easier pairs.
 * The release gates are reported apart and are never satisfied, because the only labelled set is AI-generated.
 */
export function compareOnLabels(set: LabelledSet, sides: readonly BakeOffSide[]): BakeOffReport {
  const pairs = set.pairs.filter(p => sides.every(s => Object.hasOwn(s.runs[0], p.id)));
  const ids = new Set(pairs.map(p => p.id));
  const only = (run: SideRun) => Object.fromEntries(Object.entries(run).filter(([id]) => ids.has(id)).map(([id, r]) => [id, r.level]));
  const rate = (k: number) => (pairs.length ? k / pairs.length : null);
  return {
    schemaVersion: 1,
    label: provisionalLabel,
    labels: { source: set.source, model: set.labeller.model, pairs: set.pairs.length, unknownRate: rate(pairs.filter(p => p.labelLevel === 'unknown').length) },
    compared: pairs.length,
    sides: sides.map(side => {
      const first = side.runs[0];
      const points = pairs.flatMap(p => {
        const r = first[p.id]!;
        return r.level !== 'unknown' && p.labelLevel !== 'unknown' && r.confidence !== null ? [{ confidence: r.confidence, match: r.level === p.labelLevel }] : [];
      });
      return {
        name: side.name, model: side.model,
        missing: set.pairs.filter(p => !Object.hasOwn(first, p.id)).length,
        agreement: weightedKappa(pairs.map(p => [first[p.id]!.level, p.labelLevel] as const)),
        unknownRate: rate(pairs.filter(p => first[p.id]!.level === 'unknown').length),
        stability: side.runs[1] ? levelStability(only(first), only(side.runs[1])) : null,
        calibration: calibration(points),
        cost: side.cost && { ...side.cost, usdPerCall: side.cost.calls ? side.cost.usd / side.cost.calls : null },
      };
    }),
    releaseGates: { weightedKappa: releaseGate(releaseGateThresholds.weightedKappa), stability: releaseGate(releaseGateThresholds.stability) },
  };
}
