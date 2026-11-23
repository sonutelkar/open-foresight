import { z } from 'zod';

/** The ordinal rubric levels. `unknown` is not on the scale, so it never enters a kappa. */
export const ordinalLevels = ['0', '1', '2', '3', '4'] as const;
export type OrdinalLevel = (typeof ordinalLevels)[number];
export const levelSchema = z.enum([...ordinalLevels, 'unknown']);
export type RubricLevel = z.infer<typeof levelSchema>;

export type KappaResult = {
  /** Pairs where both sides gave a level 0 to 4. Kappa and agreement are over these only. */
  n: number;
  /** Null when kappa is undefined: fewer than 2 usable pairs, or no expected disagreement because both sides used one and the same level. */
  kappa: number | null;
  /** Share of usable pairs with the same level. Null when there are none. */
  exactAgreement: number | null;
  /** Pairs left out because a side said unknown. `unknownA` means only side A did. */
  excluded: { unknownA: number; unknownB: number; unknownBoth: number };
  /** Counts of usable pairs, row = side A level, column = side B level, both 0 to 4. */
  confusion: number[][];
};

/**
 * Cohen's weighted kappa between two raters on levels 0 to 4. Each pair is `[a, b]`.
 * Quadratic weights by default, so a miss by two levels costs four times a miss by one.
 */
export function weightedKappa(pairs: ReadonlyArray<readonly [RubricLevel, RubricLevel]>, options: { weights?: 'quadratic' | 'linear' } = {}): KappaResult {
  const k = ordinalLevels.length;
  const confusion = ordinalLevels.map(() => ordinalLevels.map(() => 0));
  const excluded = { unknownA: 0, unknownB: 0, unknownBoth: 0 };
  let n = 0;
  for (const [a, b] of pairs) {
    if (a === 'unknown' || b === 'unknown') {
      if (a === b) excluded.unknownBoth++; else if (a === 'unknown') excluded.unknownA++; else excluded.unknownB++;
      continue;
    }
    confusion[Number(a)]![Number(b)]!++;
    n++;
  }
  const rows = confusion.map(r => r.reduce((s, x) => s + x, 0));
  const cols = ordinalLevels.map((_, j) => confusion.reduce((s, r) => s + r[j]!, 0));
  const weight = (i: number, j: number) => options.weights === 'linear' ? Math.abs(i - j) : (i - j) ** 2;
  // Observed and expected disagreement, both scaled by n squared so the sums stay whole numbers until the last division.
  let observed = 0, expected = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    observed += weight(i, j) * confusion[i]![j]! * n;
    expected += weight(i, j) * rows[i]! * cols[j]!;
  }
  const kappa = n < 2 || expected === 0 ? null : 1 - observed / expected;
  const agreed = confusion.reduce((s, r, i) => s + r[i]!, 0);
  return { n, kappa, exactAgreement: n === 0 ? null : agreed / n, excluded, confusion };
}

export type StabilityResult = {
  /** Cases present in both runs. */
  n: number;
  identical: number;
  /** Share of those cases with the same level, unknown included. Null when no case is in both runs. */
  stability: number | null;
  onlyInA: number;
  onlyInB: number;
};

/** Run-to-run stability: the share of cases, keyed by id, that got the identical level in two runs. `unknown` is a level here, so unknown twice is identical. */
export function levelStability(runA: Readonly<Record<string, RubricLevel>>, runB: Readonly<Record<string, RubricLevel>>): StabilityResult {
  let n = 0, identical = 0, onlyInA = 0;
  for (const [id, level] of Object.entries(runA)) {
    if (!Object.hasOwn(runB, id)) { onlyInA++; continue; }
    n++;
    if (runB[id] === level) identical++;
  }
  return { n, identical, stability: n === 0 ? null : identical / n, onlyInA, onlyInB: Object.keys(runB).length - n };
}
