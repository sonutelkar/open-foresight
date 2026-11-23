import { describe, expect, it } from 'vitest';
import { labelledSetSchema, provisionalLabel, summarizeLabelled, type LabelledPair } from './labels.js';

const runId = '9875a20c-19dd-4703-8b07-326f6ddb05e1';
const pair = (n: number, analystLevel: LabelledPair['analystLevel'], labelLevel: LabelledPair['labelLevel']): LabelledPair => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, runId, symbol: `S${n}.US`, kpiId: 'storage_commitment', method: 'judgement',
  analystLevel, labelLevel, labelRationale: 'e1 names a storage programme with a figure.', chunkIds: ['c1', 'c2'],
});
const doc = (pairs: LabelledPair[]) => ({
  schemaVersion: 1, source: 'ai', provisional: true,
  labeller: { model: 'google/gemini-3.1-pro-preview', provider: 'Google', promptVersion: 'labeller-judgement@v1:0123456789ab' },
  analyst: { model: 'openai/gpt-6-luna' }, runIds: [runId], createdAt: '2026-11-23T14:00:00.000Z',
  sample: { requested: 200, pool: pairs.length, seed: 1 }, note: 'N is 1. Provisional.', pairs,
});

describe('labelledSetSchema', () => {
  it('accepts an AI labelled set and refuses one that claims to be final or human', () => {
    expect(labelledSetSchema.parse(doc([pair(1, '2', '2')])).pairs).toHaveLength(1);
    expect(labelledSetSchema.safeParse({ ...doc([]), provisional: false }).success).toBe(false);
    expect(labelledSetSchema.safeParse({ ...doc([]), source: 'human' }).success).toBe(false);
  });

  it('refuses a pair counted twice, a quant method and a pair with no passages', () => {
    expect(labelledSetSchema.safeParse(doc([pair(1, '2', '2'), pair(1, '3', '3')])).success).toBe(false);
    expect(labelledSetSchema.safeParse(doc([{ ...pair(1, '2', '2'), method: 'extract_then_quant' } as never])).success).toBe(false);
    expect(labelledSetSchema.safeParse(doc([{ ...pair(1, '2', '2'), chunkIds: [] }])).success).toBe(false);
  });
});

describe('summarizeLabelled', () => {
  it('compares the Analyst with the labeller and says the result is provisional', () => {
    const s = summarizeLabelled(labelledSetSchema.parse(doc([pair(1, '0', '1'), pair(2, '1', '2'), pair(3, '2', '3'), pair(4, '3', '4'), pair(5, '2', 'unknown')])));
    expect(s.label).toBe(provisionalLabel);
    expect(s.label).toBe('provisional, AI labelled, not the full release gate');
    expect(s).toMatchObject({ n: 4, exactAgreement: 0, excluded: { unknownA: 0, unknownB: 1, unknownBoth: 0 } });
    expect(s.kappa).toBeCloseTo(5 / 7, 12);
    expect(s.confusion[0]).toEqual([0, 1, 0, 0, 0]);
  });
});
