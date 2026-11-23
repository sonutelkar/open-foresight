import { levelKeys, type Kpi } from './framework.js';
import type { ScoreLevel } from './score.js';

/** Names the questions and the mapping below. Change it when either changes, so a stored answer names the rule that read it. */
export const jevScoreVersion = 'jev-kpi-score@v1';

/**
 * How code reads Jev's answer. Provisional until a human-labelled set sets the numbers.
 * Below `minKnown` on the `known` question, the rubric's unknown rule applies. Below `minNear` within one level of the chosen level,
 * the answer is split between levels far apart, and no single level stands for it.
 */
export const jevLevelRule = { minKnown: 0.5, minNear: 0.5 } as const;

/**
 * The two questions Jev answers about one company and one judgement KPI. The Score options are the approved rubric levels 0 to 4 in order,
 * so option i is level i. The Noul carries the rubric's unknown rule. The company, KPI and passages go in the decision state.
 */
export function jevScoreQuestions(kpi: Extract<Kpi, { method: 'judgement' }>) {
  return {
    level: {
      type: 'score' as const,
      instructions: "Which rubric level do the passages support for this company on this KPI? Use only the passages and read each level literally. A level needs the evidence its description names.",
      criteria: levelKeys.map(l => kpi.rubric.levels[l]),
    },
    known: {
      type: 'noul' as const,
      instructions: `Do the passages say enough about this KPI to choose a level? A passage that is silent about the KPI is not evidence that the company lacks it. Answer no when this rule applies: ${kpi.rubric.unknown}`,
    },
  };
}

export type JevLevelReason = 'level' | 'unknown_rule' | 'split' | 'no_evidence';
export type JevLevel = {
  level: ScoreLevel; reason: JevLevelReason;
  /** The probability-weighted level, 0 to 4. Null when no answer was read. */
  weighted: number | null;
  /** The probability on the chosen level, which is the chance it is exactly right. 0 for unknown. */
  confidence: number;
};

/**
 * Reads Jev's Score probabilities and its `known` probability as a discrete level. Code decides, and Jev's own `score` and `confidence` fields are not used.
 * 1. Below `minKnown` on `known` is unknown.
 * 2. The weighted level is the sum of level times probability. It rounds to the nearest level, and a tie at .5 rounds down.
 * 3. Less than `minNear` within one level of that level is unknown, because the answer is split between levels far apart.
 * Rounding the weighted level and not taking the most likely level suits a quadratic kappa, which charges a miss by the square of its distance.
 */
export function readJevLevel(probabilities: Readonly<Record<string, number>>, known: number): JevLevel {
  const p = levelKeys.map(l => Math.max(0, probabilities[l] ?? 0));
  const total = p.reduce((s, x) => s + x, 0);
  if (total <= 0) return { level: 'unknown', reason: 'split', weighted: null, confidence: 0 };
  const q = p.map(x => x / total);
  const weighted = q.reduce((s, x, i) => s + i * x, 0);
  if (known < jevLevelRule.minKnown) return { level: 'unknown', reason: 'unknown_rule', weighted, confidence: 0 };
  const i = Math.min(4, Math.max(0, Math.ceil(weighted - 0.5 - 1e-9)));
  const near = q.slice(Math.max(0, i - 1), i + 2).reduce((s, x) => s + x, 0);
  if (near < jevLevelRule.minNear) return { level: 'unknown', reason: 'split', weighted, confidence: 0 };
  return { level: levelKeys[i]!, reason: 'level', weighted, confidence: q[i]! };
}

/** How a stored score was produced under the `jev-first` path. `jev` is Jev's own level. `luna-fallback` is the Analyst's level for a pair Jev answered unknown. */
export type ScoreRoute = 'jev' | 'luna-fallback';

/**
 * A `luna-fallback` score keeps this share of the confidence the Analyst would have given it as the primary scorer.
 * It comes from the PR 13b bake-off: on the pairs Jev found unknown, Luna's confidence did not drop, so Luna's own confidence does not warn of a weak answer there.
 * The size is a round figure, one half, and is not tuned to the AI-labelled set. Revisit it with a human-labelled set.
 */
export const lunaFallbackConfidenceFactor = 0.5;

export const routeNames: Record<ScoreRoute, string> = { jev: 'Jev', 'luna-fallback': 'Luna fallback' };
/** Shown with a basket that holds a fallback score. */
export const fallbackLimitation = 'Luna fallback scores are provisional. Jev could not answer these KPIs, and Luna was weak on such pairs in the bake-off, so its confidence is halved. The comparison used AI-generated labels.';
