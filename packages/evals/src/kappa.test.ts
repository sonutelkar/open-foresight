import { describe, expect, it } from 'vitest';
import { levelStability, weightedKappa, type RubricLevel } from './kappa.js';

type Pair = [RubricLevel, RubricLevel];
const repeat = (pair: Pair, times: number): Pair[] => Array.from({ length: times }, () => pair);

describe('weightedKappa', () => {
  it('is 1 for perfect agreement', () => {
    const r = weightedKappa([['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]);
    expect(r).toMatchObject({ n: 5, kappa: 1, exactAgreement: 1 });
    expect(r.confusion).toEqual([[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]]);
  });

  it('matches the textbook two-level example, where any weighting gives the plain kappa of 0.4', () => {
    // 50 proposals: both yes 20, A yes B no 5, A no B yes 10, both no 15. p_o = 0.7, p_e = 0.5, kappa = 0.4.
    const pairs = [...repeat(['1', '1'], 20), ...repeat(['1', '0'], 5), ...repeat(['0', '1'], 10), ...repeat(['0', '0'], 15)];
    const r = weightedKappa(pairs);
    expect(r.n).toBe(50);
    expect(r.kappa).toBeCloseTo(0.4, 12);
    expect(r.exactAgreement).toBeCloseTo(0.7, 12);
  });

  it('matches a hand computed three-level matrix', () => {
    // Rows A, columns B, levels 1 to 3: [4 1 0], [1 3 1], [0 1 2]. Margins 5 5 3 both ways, n 13.
    // Weighted observed 4, weighted expected 200 / 13, so kappa = 1 - 4 * 13 / 200 = 0.74.
    const pairs = [...repeat(['1', '1'], 4), ['1', '2'], ['2', '1'], ...repeat(['2', '2'], 3), ['2', '3'], ['3', '2'], ...repeat(['3', '3'], 2)] as Pair[];
    const r = weightedKappa(pairs);
    expect(r.kappa).toBeCloseTo(0.74, 12);
    expect(r.exactAgreement).toBeCloseTo(9 / 13, 12);
    expect(r.confusion[1]).toEqual([0, 4, 1, 0, 0]);
  });

  it('credits a systematic one-level miss with no exact agreement', () => {
    // Weighted observed 4 / 4, weighted expected 56 / 16, so quadratic kappa = 1 - 16 / 56 = 5 / 7. Linear: 1 - 16 / 24 = 1 / 3.
    const pairs: Pair[] = [['0', '1'], ['1', '2'], ['2', '3'], ['3', '4']];
    expect(weightedKappa(pairs)).toMatchObject({ n: 4, exactAgreement: 0 });
    expect(weightedKappa(pairs).kappa).toBeCloseTo(5 / 7, 12);
    expect(weightedKappa(pairs, { weights: 'linear' }).kappa).toBeCloseTo(1 / 3, 12);
  });

  it('leaves unknown out of kappa and counts it by side', () => {
    const r = weightedKappa([['1', '1'], ['2', '2'], ['unknown', '2'], ['3', 'unknown'], ['3', 'unknown'], ['unknown', 'unknown']]);
    expect(r).toMatchObject({ n: 2, kappa: 1, exactAgreement: 1, excluded: { unknownA: 1, unknownB: 2, unknownBoth: 1 } });
  });

  it('returns null, not 0 or 1, when kappa is undefined', () => {
    expect(weightedKappa([])).toMatchObject({ n: 0, kappa: null, exactAgreement: null });
    expect(weightedKappa([['unknown', '2']])).toMatchObject({ n: 0, kappa: null, exactAgreement: null });
    expect(weightedKappa([['2', '3']])).toMatchObject({ n: 1, kappa: null, exactAgreement: 0 });
    // Both sides used level 2 only, so no disagreement was expected and kappa is 0 / 0.
    expect(weightedKappa(repeat(['2', '2'], 3))).toMatchObject({ n: 3, kappa: null, exactAgreement: 1 });
  });

  it('gives 0 when one side uses a single level, because agreement is then exactly chance', () => {
    expect(weightedKappa([['2', '1'], ['2', '2'], ['2', '3']]).kappa).toBe(0);
  });
});

describe('levelStability', () => {
  it('is the share of shared cases with the identical level, unknown included', () => {
    const r = levelStability({ a: '1', b: '2', c: 'unknown', d: '3' }, { a: '1', b: '3', c: 'unknown', e: '2' });
    expect(r).toEqual({ n: 3, identical: 2, stability: 2 / 3, onlyInA: 1, onlyInB: 1 });
  });

  it('is null when the runs share no case', () => {
    expect(levelStability({ a: '1' }, { b: '1' })).toEqual({ n: 0, identical: 0, stability: null, onlyInA: 1, onlyInB: 1 });
  });
});
