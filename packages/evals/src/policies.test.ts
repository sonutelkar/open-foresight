import { describe, expect, it } from 'vitest';
import { labelledSetSchema, type LabelledPair } from './labels.js';
import { comparePolicies, routeLevel, type BakeoffFile } from './policies.js';

const runId = '9875a20c-19dd-4703-8b07-326f6ddb05e1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pair = (n: number, labelLevel: LabelledPair['labelLevel']): LabelledPair => ({ id: id(n), runId, symbol: `S${n}.US`, kpiId: 'k', method: 'judgement', analystLevel: '2', labelLevel, labelRationale: 'r', chunkIds: ['c1'] });
const set = labelledSetSchema.parse({
  schemaVersion: 1, source: 'ai', provisional: true,
  labeller: { model: 'l', provider: 'p', promptVersion: 'v' }, analyst: { model: 'a' }, runIds: [runId], createdAt: '2026-11-23T14:00:00.000Z',
  sample: { requested: 6, pool: 6, seed: 1 }, note: 'N is 6. Provisional.',
  pairs: [pair(1, '0'), pair(2, '1'), pair(3, '2'), pair(4, '3'), pair(5, '4'), pair(6, '2')],
});
// Pairs 1 to 3 Jev answers, 4 and 5 it calls unknown, and 6 its call failed. Luna is off by two levels on pair 4.
const file: BakeoffFile = {
  pairs: [
    { id: id(1), analyst: { stored: '1', confidence: 0.8 }, jev: [{ level: '0', confidence: 0.9 }] },
    { id: id(2), analyst: { stored: '2', confidence: 0.8 }, jev: [{ level: '1', confidence: 0.7 }] },
    { id: id(3), analyst: { stored: '2', confidence: 0.8 }, jev: [{ level: '2', confidence: 0.6 }] },
    { id: id(4), analyst: { stored: '1', confidence: 0.8 }, jev: [{ level: 'unknown', confidence: 0 }] },
    { id: id(5), analyst: { stored: '4', confidence: 0.8 }, jev: [{ level: 'unknown', confidence: 0 }] },
    { id: id(6), analyst: { stored: '2', confidence: 0.8 }, jev: [null] },
  ],
};

describe('routeLevel', () => {
  it('keeps a Jev level and gives Luna a discounted confidence only for a Jev unknown', () => {
    expect(routeLevel({ level: '3', confidence: 0.7 }, { level: '1', confidence: 0.8 }, 0.5)).toEqual({ level: '3', confidence: 0.7 });
    expect(routeLevel({ level: 'unknown', confidence: 0 }, { level: '1', confidence: 0.8 }, 0.5)).toEqual({ level: '1', confidence: 0.4 });
  });
  it('stays unknown when Luna is unknown or absent, and has no answer when Jev failed', () => {
    expect(routeLevel({ level: 'unknown', confidence: 0 }, { level: 'unknown', confidence: 0.8 }, 0.5)?.level).toBe('unknown');
    expect(routeLevel({ level: 'unknown', confidence: 0 }, null, 0.5)?.level).toBe('unknown');
    expect(routeLevel(null, { level: '1', confidence: 0.8 }, 0.5)).toBeNull();
  });
});

describe('comparePolicies', () => {
  const report = comparePolicies(set, file, 0.5);
  const [fallback, jevOnly, lunaAlone] = report.sides;

  it('compares the three policies on the pairs every policy answered, and stays provisional', () => {
    expect(report.sides.map(s => s.name)).toEqual(['fallback to Luna', 'treat Jev unknown as unknown', 'Luna alone']);
    expect(report.compared).toBe(5);
    expect(report.label).toMatch(/provisional/);
    expect(report.releaseGates.weightedKappa.satisfied).toBe(false);
    expect(report.releaseGates.stability.satisfied).toBe(false);
  });
  it('counts Jev unknowns as unknown, and none under the fallback or Luna alone', () => {
    expect([fallback!.unknownRate, jevOnly!.unknownRate, lunaAlone!.unknownRate]).toEqual([0, 0.4, 0]);
    expect(jevOnly!.agreement.n).toBe(3);
  });
  it('gives the exact agreement of each policy over its answered pairs', () => {
    // Labels 0,1,2,3,4. Fallback: 0,1,2,1,4 so 4 of 5. Jev only: 0,1,2 so 3 of 3. Luna alone: 1,2,2,1,4 so 2 of 5.
    expect(fallback!.agreement.exactAgreement).toBeCloseTo(0.8);
    expect(jevOnly!.agreement.exactAgreement).toBeCloseTo(1);
    expect(lunaAlone!.agreement.exactAgreement).toBeCloseTo(0.4);
    expect(fallback!.agreement.n).toBe(5);
  });
});
