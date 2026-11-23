import { describe, expect, it } from 'vitest';
import type { BasketCandidate, BasketKpi, BasketRules } from '@open-foresight/core';
import type { LabelledPair } from '@open-foresight/evals';
import { applyPolicy, policyBasketEffects } from './policy-basket.js';

const kpis: BasketKpi[] = [{ id: 'gate', weight: 0.5, isGate: true }, { id: 'depth', weight: 0.5, isGate: false }];
const rules: BasketRules = { size: 2, weightCapPercent: 100, weighting: 'score', unknownMode: 'lenient' };
const cand = (symbol: string, gate: '0' | '1' | '2' | '3' | '4', depth: '0' | '1' | '2' | '3' | '4' | 'unknown'): BasketCandidate => ({
  securityId: symbol, symbol, name: symbol, marketCapUsd: 1e10, advUsd: 1e7, scores: { gate: { level: gate, confidence: 0.8 }, depth: { level: depth, confidence: 0.8 } },
});
// Luna says depth 4 for AAA and 0 for BBB, and 1 for CCC. Jev says 1 for AAA, unknown for BBB and unknown for CCC.
const candidates = [cand('AAA', '2', '4'), cand('BBB', '2', '0'), cand('CCC', '2', '1')];
const pair = (n: number, symbol: string): LabelledPair => ({ id: `p${n}`, runId: 'r', symbol, kpiId: 'depth', method: 'judgement', analystLevel: '1', labelLevel: '1', labelRationale: '', chunkIds: ['c'] });
const pairs = [pair(1, 'AAA'), pair(2, 'BBB'), pair(3, 'CCC')];
const jev = new Map<string, { level: '0' | '1' | 'unknown'; confidence: number } | null>([['p1', { level: '1', confidence: 0.9 }], ['p2', { level: 'unknown', confidence: 0 }], ['p3', { level: 'unknown', confidence: 0 }]]);

describe('applyPolicy', () => {
  it('keeps the store as it is for Luna alone', () => {
    expect(applyPolicy(candidates, pairs, jev, 'lunaAlone', 0.5)).toEqual(candidates);
  });
  it('takes the Jev level, and under the fallback Luna for a Jev unknown with a halved confidence and the fallback flag', () => {
    const [a, b] = applyPolicy(candidates, pairs, jev, 'fallback', 0.5);
    expect(a!.scores.depth).toEqual({ level: '1', confidence: 0.9, route: 'jev' });
    expect(b!.scores.depth).toEqual({ level: '0', confidence: 0.4, route: 'luna-fallback' });
  });
  it('leaves a Jev unknown unknown when Jev decides alone', () => {
    expect(applyPolicy(candidates, pairs, jev, 'jevOnly', 0.5)[1]!.scores.depth).toEqual({ level: 'unknown', confidence: 0 });
  });
  it('keeps the saved level where Jev failed', () => {
    expect(applyPolicy(candidates, pairs, new Map([['p1', null]]), 'fallback', 0.5)[0]!.scores.depth).toEqual(candidates[0]!.scores.depth);
  });
});

describe('policyBasketEffects', () => {
  const effects = policyBasketEffects({ candidates, kpis, rules }, pairs, jev, 0.5);
  it('reports no change for Luna alone against itself', () => {
    expect(effects.lunaAlone).toMatchObject({ added: [], dropped: [], weightsChanged: 0 });
  });
  it('moves two weights and no names when Jev scores first and Luna fills its unknowns', () => {
    // Luna alone: AAA 0.75 and CCC 0.375 are in, at 66.67 and 33.33 percent. Jev first: AAA falls to 0.375 and ties CCC, so the weights go to 50 and 50.
    expect(effects.fallback).toMatchObject({ selected: 2, added: [], dropped: [], weightsChanged: 2 });
    expect(effects.fallback.maxWeightShiftPercent).toBeCloseTo(16.6667, 3);
  });
  it('swaps a name when Jev unknowns stay unknown, because a lenient run renormalises them away', () => {
    expect(effects.jevOnly).toMatchObject({ selected: 2, added: ['BBB'], dropped: ['AAA'] });
  });
});
