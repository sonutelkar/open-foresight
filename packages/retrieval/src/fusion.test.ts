import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './fusion.js';

describe('reciprocalRankFusion', () => {
  it('scores by summed reciprocal rank and ranks appearing in both lists above appearing in one', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'c'], ['c', 'b', 'd']], 60);
    expect(fused.map(f => f.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(fused[0]?.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[1]?.score).toBeCloseTo(1 / 62 + 1 / 62, 12);
    expect(fused.find(f => f.id === 'a')?.ranks).toEqual([1, null]);
    expect(fused.find(f => f.id === 'c')?.ranks).toEqual([3, 1]);
  });
  it('handles one list, empty lists and duplicates inside a list', () => {
    expect(reciprocalRankFusion([['x', 'y']]).map(f => f.id)).toEqual(['x', 'y']);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    const dup = reciprocalRankFusion([['x', 'x', 'y']]);
    expect(dup.find(f => f.id === 'x')?.score).toBeCloseTo(1 / 61, 12);
  });
  it('breaks ties by id and is deterministic', () => {
    const lists = [['b'], ['a']];
    expect(reciprocalRankFusion(lists).map(f => f.id)).toEqual(['a', 'b']);
    expect(reciprocalRankFusion(lists)).toEqual(reciprocalRankFusion(lists));
  });
  it('rejects a non positive k', () => { expect(() => reciprocalRankFusion([['a']], 0)).toThrow(); });
});
