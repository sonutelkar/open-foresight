import { describe, expect, it } from 'vitest';
import { capWeights, packageBasket, unknownModeFor, type BasketCandidate, type BasketKpi, type BasketRules } from './basket.js';
import type { ScoreLevel } from './score.js';

const kpis: BasketKpi[] = [{ id: 'gate', weight: 0.4, isGate: true }, { id: 'a', weight: 0.3, isGate: false }, { id: 'b', weight: 0.2, isGate: false }, { id: 'c', weight: 0.1, isGate: false }];
const noGate: BasketKpi[] = kpis.map(k => ({ ...k, isGate: false }));
const rules: BasketRules = { size: 10, weightCapPercent: 100, weighting: 'score', unknownMode: 'strict' };
const cand = (symbol: string, levels: Record<string, ScoreLevel>, extra: Partial<BasketCandidate> = {}, confidence = 0.8): BasketCandidate => ({
  securityId: `id-${symbol}`, symbol, name: `${symbol} Inc`, marketCapUsd: 1e10, advUsd: 1e7,
  scores: Object.fromEntries(Object.entries(levels).map(([k, level]) => [k, { level, confidence }])), ...extra,
});
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe('theme score and contributions', () => {
  it('scores each name as the weighted sum of level over 4', () => {
    const b = packageBasket({ candidates: [cand('X', { gate: '4', a: '2', b: '4', c: '0' })], kpis, rules });
    const m = b.members[0]!;
    expect(m.score).toBeCloseTo(0.4 * 1 + 0.3 * 0.5 + 0.2 * 1 + 0, 12);
    expect(m.contributions.map(c => c.kpiId)).toEqual(['gate', 'a', 'b', 'c']);
    [0.4, 0.15, 0.2, 0].forEach((v, i) => expect(m.contributions[i]!.contribution).toBeCloseTo(v, 12));
    expect(sum(m.contributions.map(c => c.contribution)) + m.capAdjustment).toBeCloseTo(m.score, 12);
  });

  it('treats unknown as level 0 in strict mode and keeps the weights', () => {
    const m = packageBasket({ candidates: [cand('X', { gate: '4', a: 'unknown', b: '4', c: '4' })], kpis, rules }).members[0]!;
    expect(m.score).toBeCloseTo(0.4 + 0 + 0.2 + 0.1, 12);
    expect(m.unknownWeight).toBeCloseTo(0.3, 12);
    const a = m.contributions.find(c => c.kpiId === 'a')!;
    expect(a.level).toBe('unknown');
    expect(a.weight).toBeCloseTo(0.3, 12);
    expect(a.contribution).toBe(0);
  });

  it('drops an unknown KPI in lenient mode and renormalises the rest', () => {
    const m = packageBasket({ candidates: [cand('X', { gate: '4', a: 'unknown', b: '4', c: '4' })], kpis, rules: { ...rules, unknownMode: 'lenient' } }).members[0]!;
    expect(m.score).toBeCloseTo((0.4 + 0.2 + 0.1) / 0.7, 12);
    expect(sum(m.contributions.map(c => c.weight))).toBeCloseTo(1, 12);
    expect(m.contributions.find(c => c.kpiId === 'a')!.weight).toBe(0);
  });

  it('caps a lenient score at 0.8 when more than half the weight is unknown, and the contributions plus the adjustment still add up', () => {
    const m = packageBasket({ candidates: [cand('X', { gate: '4', a: 'unknown', b: 'unknown', c: 'unknown' }, {}, 0.5)], kpis, rules: { ...rules, unknownMode: 'lenient' } }).members[0]!;
    expect(m.unknownWeight).toBeCloseTo(0.6, 12);
    expect(m.score).toBe(0.8);
    expect(m.capAdjustment).toBeCloseTo(0.8 - 1, 12);
    expect(sum(m.contributions.map(c => c.contribution)) + m.capAdjustment).toBeCloseTo(m.score, 12);
  });

  it('does not cap a lenient score when exactly half the weight is unknown', () => {
    const k: BasketKpi[] = [{ id: 'p', weight: 0.5, isGate: false }, { id: 'q', weight: 0.5, isGate: false }];
    const m = packageBasket({ candidates: [cand('X', { p: '4', q: 'unknown' })], kpis: k, rules: { ...rules, unknownMode: 'lenient' } }).members[0]!;
    expect(m.score).toBe(1);
    expect(m.capAdjustment).toBe(0);
  });

  it('counts a KPI with no stored score as unknown', () => {
    const m = packageBasket({ candidates: [cand('X', { gate: '4', a: '4' })], kpis, rules }).members[0]!;
    expect(m.unknownWeight).toBeCloseTo(0.3, 12);
  });

  it('maps the exposure style to the unknown mode', () => {
    expect(unknownModeFor('strict')).toBe('strict');
    expect(unknownModeFor('broad')).toBe('lenient');
  });
});

describe('gate and exclusions', () => {
  it('excludes a name whose gate KPI is level 0, and one whose gate KPI is unknown, in either mode', () => {
    for (const unknownMode of ['strict', 'lenient'] as const) {
      const b = packageBasket({ candidates: [cand('FAIL', { gate: '0', a: '4', b: '4', c: '4' }), cand('UNK', { gate: 'unknown', a: '4', b: '4', c: '4' }), cand('OK', { gate: '1', a: '1' })], kpis, rules: { ...rules, unknownMode } });
      expect(b.members.map(m => m.symbol)).toEqual(['OK']);
      expect(b.excluded.map(e => [e.symbol, e.reason]).sort()).toEqual([['FAIL', 'gate_failed'], ['UNK', 'gate_unknown']]);
      expect(b.funnel).toMatchObject({ candidates: 3, gateFailed: 1, gateUnknown: 1, selected: 1 });
    }
  });

  it('excludes zero scores and reports the funnel', () => {
    const b = packageBasket({ candidates: [cand('Z', { gate: '0', a: '0', b: '0', c: '0' }), cand('Y', { gate: '1', a: '3' })], kpis: noGate, rules });
    expect(b.excluded.find(e => e.symbol === 'Z')?.reason).toBe('zero_score');
    expect(b.funnel).toEqual({ candidates: 2, gateFailed: 0, gateUnknown: 0, zeroScore: 1, eligible: 1, selected: 1, belowCutoff: 0 });
  });

  it('keeps the top N and marks the rest below the cutoff', () => {
    const cs = ['A', 'B', 'C', 'D'].map((s, i) => cand(s, { a: String(4 - i) as ScoreLevel }));
    const b = packageBasket({ candidates: cs, kpis: noGate, rules: { ...rules, size: 2 } });
    expect(b.members.map(m => m.symbol)).toEqual(['A', 'B']);
    expect(b.excluded.filter(e => e.reason === 'below_cutoff').map(e => e.symbol)).toEqual(['C', 'D']);
    expect(b.funnel).toMatchObject({ eligible: 4, selected: 2, belowCutoff: 2 });
  });

  it('returns an empty provisional basket when nothing qualifies', () => {
    const b = packageBasket({ candidates: [cand('N', { gate: '0' })], kpis, rules });
    expect(b).toMatchObject({ status: 'provisional', members: [], cap: { relaxed: false } });
  });
});

describe('tie breaks and determinism', () => {
  const tied = [
    cand('LOWCONF', { a: '2' }, { advUsd: 9e9 }, 0.5), cand('HIGHCONF', { a: '2' }, { advUsd: 1 }, 0.9),
    cand('LIQ', { a: '2' }, { advUsd: 5e7 }, 0.7), cand('ILLIQ', { a: '2' }, { advUsd: 1e6 }, 0.7),
    cand('AAA', { a: '2' }, { advUsd: 1e6 }, 0.7), cand('ZZZ', { a: '2' }, { advUsd: 1e6 }, 0.7),
  ];
  const k: BasketKpi[] = [{ id: 'a', weight: 1, isGate: false }];

  it('orders equal scores by confidence, then liquidity, then symbol', () => {
    const order = packageBasket({ candidates: tied, kpis: k, rules }).members.map(m => m.symbol);
    expect(order).toEqual(['HIGHCONF', 'LIQ', 'AAA', 'ILLIQ', 'ZZZ', 'LOWCONF']);
  });

  it('gives the same basket for any input order and for a repeat call', () => {
    const base = packageBasket({ candidates: tied, kpis: k, rules });
    expect(packageBasket({ candidates: [...tied].reverse(), kpis: k, rules })).toEqual(base);
    expect(packageBasket({ candidates: tied, kpis: k, rules })).toEqual(base);
  });
});

describe('weighting and caps', () => {
  const four = [cand('A', { a: '4' }), cand('B', { a: '3' }), cand('C', { a: '2' }), cand('D', { a: '1' })];
  const k: BasketKpi[] = [{ id: 'a', weight: 1, isGate: false }];

  it('weights equally, by score, and by score times root market cap', () => {
    const equal = packageBasket({ candidates: four, kpis: k, rules: { ...rules, weighting: 'equal' } });
    expect(equal.members.map(m => m.weightPercent)).toEqual([25, 25, 25, 25]);
    const byScore = packageBasket({ candidates: four, kpis: k, rules });
    expect(byScore.members.map(m => m.weightPercent)).toEqual([40, 30, 20, 10]);
    const big = four.map((c, i) => ({ ...c, marketCapUsd: i === 3 ? 4e12 : 1e10 }));
    const rooted = packageBasket({ candidates: big, kpis: k, rules: { ...rules, weighting: 'score_sqrt_cap' } });
    expect(rooted.members.find(m => m.symbol === 'D')!.weightPercent).toBeGreaterThan(byScore.members.find(m => m.symbol === 'D')!.weightPercent);
    expect(sum(rooted.members.map(m => m.weightPercent))).toBeCloseTo(100, 9);
  });

  it('caps a name and redistributes the excess, repeating until nobody is over', () => {
    const b = packageBasket({ candidates: four, kpis: k, rules: { ...rules, weightCapPercent: 35 } });
    const w = b.members.map(m => m.weightPercent);
    expect(Math.max(...w)).toBeLessThanOrEqual(35 + 1e-4);
    expect(sum(w)).toBeCloseTo(100, 9);
    expect(b.members[0]!.atCap).toBe(true);
    expect(b.cap).toEqual({ requestedPercent: 35, usedPercent: 35, relaxed: false });
    const heavy = capWeights([100, 10, 1, 1], 40);
    expect(heavy.weights.map(w => Math.round(w * 1e6) / 1e6)).toEqual([40, 40, 10, 10]);
    expect(sum(heavy.weights)).toBeCloseTo(100, 9);
    expect(Math.max(...heavy.weights)).toBeLessThanOrEqual(40 + 1e-9);
  });

  it('relaxes an infeasible cap to the smallest feasible value and records it', () => {
    const b = packageBasket({ candidates: four, kpis: k, rules: { ...rules, weightCapPercent: 20 } });
    expect(b.cap).toEqual({ requestedPercent: 20, usedPercent: 25, relaxed: true });
    expect(b.members.map(m => m.weightPercent)).toEqual([25, 25, 25, 25]);
    expect(b.members.every(m => m.atCap)).toBe(true);
  });

  it('keeps the total at exactly 100 after rounding, with no name over the cap', () => {
    const many = Array.from({ length: 37 }, (_, i) => cand(`S${String(i).padStart(2, '0')}`, { a: String((i % 4) + 1) as ScoreLevel }));
    const b = packageBasket({ candidates: many, kpis: k, rules: { ...rules, size: 37, weightCapPercent: 4 } });
    expect(sum(b.members.map(m => m.weightPercent))).toBeCloseTo(100, 9);
    expect(Math.max(...b.members.map(m => m.weightPercent))).toBeLessThanOrEqual(4 + 1e-4);
  });
});
