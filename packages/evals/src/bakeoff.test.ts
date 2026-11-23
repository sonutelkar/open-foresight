import { describe, expect, it } from 'vitest';
import { calibration, compareOnLabels, type SideRun } from './bakeoff.js';
import { labelledSetSchema, type LabelledPair } from './labels.js';

const runId = '9875a20c-19dd-4703-8b07-326f6ddb05e1';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pair = (n: number, labelLevel: LabelledPair['labelLevel']): LabelledPair => ({
  id: id(n), runId, symbol: `S${n}.US`, kpiId: 'storage_commitment', method: 'judgement', analystLevel: '2', labelLevel, labelRationale: 'r', chunkIds: ['c1'],
});
const set = labelledSetSchema.parse({
  schemaVersion: 1, source: 'ai', provisional: true,
  labeller: { model: 'google/gemini-3.1-pro-preview', provider: 'Google', promptVersion: 'labeller-judgement@v1:0' },
  analyst: { model: 'openai/gpt-6-luna' }, runIds: [runId], createdAt: '2026-11-23T14:00:00.000Z', sample: { requested: 6, pool: 6, seed: 1 }, note: 'N is 6. Provisional.',
  pairs: [pair(1, '1'), pair(2, '2'), pair(3, '3'), pair(4, '2'), pair(5, 'unknown'), pair(6, '0')],
});
const run = (levels: Array<[number, SideRun[string]['level'], number | null]>): SideRun => Object.fromEntries(levels.map(([n, level, confidence]) => [id(n), { level, confidence }]));

// Jev failed on pair 6, so every side is compared on pairs 1 to 5.
const jev = {
  name: 'jev', model: 'typesafe/jev-1.14',
  runs: [run([[1, '1', 0.9], [2, '2', 0.6], [3, '2', 0.3], [4, 'unknown', 0], [5, '1', 0.8]]), run([[1, '1', 0.9], [2, '3', 0.5], [3, '2', 0.3], [4, 'unknown', 0], [5, '1', 0.8]])] as const,
  cost: { usd: 0.002, calls: 5, medianLatencyMs: 250 },
};
const analyst = { name: 'analyst', model: 'openai/gpt-6-luna', runs: [run([[1, '1', 0.6], [2, '2', 0.8], [3, '3', 1], [4, '2', 0.4], [5, '2', 0.6], [6, '1', 0.6]])] as const, cost: null };

describe('compareOnLabels', () => {
  const report = compareOnLabels(set, [jev, analyst]);
  const [j, a] = report.sides;

  it('compares every side on the pairs all of them answered, and counts what each side missed', () => {
    expect(report.compared).toBe(5);
    expect(report.labels).toEqual({ source: 'ai', model: 'google/gemini-3.1-pro-preview', pairs: 6, unknownRate: 0.2 });
    expect(j!.missing).toBe(1);
    expect(a!.missing).toBe(0);
    // Pair 6, which the Analyst got wrong, is not counted for it, so it agrees on all 4 pairs with a level on both sides.
    expect(a!.agreement).toMatchObject({ n: 4, kappa: 1, exactAgreement: 1, excluded: { unknownA: 0, unknownB: 1, unknownBoth: 0 } });
  });

  it('gives weighted kappa against the label, leaving unknown out and counting it as the unknown rate', () => {
    // Jev against the label on pairs 1 to 3: (1,1) (2,2) (2,3). Weighted observed 1 x 3, weighted expected 9, so kappa = 1 - 3 / 9.
    expect(j!.agreement).toMatchObject({ n: 3, exactAgreement: 2 / 3, excluded: { unknownA: 1, unknownB: 1, unknownBoth: 0 } });
    expect(j!.agreement.kappa).toBeCloseTo(2 / 3, 12);
    expect(j!.unknownRate).toBe(0.2);
    expect(a!.unknownRate).toBe(0);
  });

  it('gives stability between two passes, unknown included, and none for a side with one pass', () => {
    expect(j!.stability).toEqual({ n: 5, identical: 4, stability: 0.8, onlyInA: 0, onlyInB: 0 });
    expect(a!.stability).toBeNull();
  });

  it('measures calibration of the confidence against an exact match with the label', () => {
    // Jev: pairs 1, 2 and 3 have a level on both sides. (0.9, match), (0.6, match), (0.3, miss).
    // Brier (0.01 + 0.16 + 0.09) / 3. ECE (0.3 + 0.4 + 0.1) / 3.
    expect(j!.calibration!.n).toBe(3);
    expect(j!.calibration!.brier).toBeCloseTo(0.26 / 3, 12);
    expect(j!.calibration!.ece).toBeCloseTo(0.8 / 3, 12);
    expect(j!.calibration!.bins.map(b => b.n)).toEqual([0, 1, 0, 1, 1]);
    expect(j!.calibration!.bins[1]).toMatchObject({ from: 0.2, to: 0.4, meanConfidence: 0.3, matchRate: 0 });
    // Analyst: four matches at 0.6, 0.8, 1 and 0.4. Brier (0.16 + 0.04 + 0 + 0.36) / 4. ECE 0.6 / 4 + 0.4 / 4 + 0.1 x 2 / 4.
    expect(a!.calibration!.brier).toBeCloseTo(0.14, 12);
    expect(a!.calibration!.ece).toBeCloseTo(0.3, 12);
    expect(a!.calibration!.bins[4]).toMatchObject({ n: 2, matchRate: 1 });
    expect(a!.calibration!.bins[4]!.meanConfidence).toBeCloseTo(0.9, 12);
  });

  it('reports cost per call for a side that made calls, and none for a stored level', () => {
    expect(j!.cost).toEqual({ usd: 0.002, calls: 5, medianLatencyMs: 250, usdPerCall: 0.0004 });
    expect(a!.cost).toBeNull();
  });

  it('never shows a release gate as satisfied on the AI-labelled set, even at perfect agreement', () => {
    const perfect = compareOnLabels(set, [{ ...analyst, runs: [run([[1, '1', 1], [2, '2', 1], [3, '3', 1], [4, '2', 1], [5, 'unknown', 1], [6, '0', 1]]), run([[1, '1', 1], [2, '2', 1], [3, '3', 1], [4, '2', 1], [5, 'unknown', 1], [6, '0', 1]])] }]);
    expect(perfect.sides[0]!.agreement.kappa).toBe(1);
    expect(perfect.sides[0]!.stability!.stability).toBe(1);
    expect(perfect.releaseGates).toEqual({
      weightedKappa: { required: 0.6, satisfied: false, reason: expect.stringContaining('human-labelled') },
      stability: { required: 0.95, satisfied: false, reason: expect.stringContaining('human-labelled') },
    });
    expect(perfect.label).toBe('provisional, AI labelled, not the full release gate');
  });
});

describe('calibration', () => {
  it('is null with nothing to measure, and puts a confidence of 1 in the top bin', () => {
    expect(calibration([])).toBeNull();
    const c = calibration([{ confidence: 1, match: true }, { confidence: 0, match: false }])!;
    expect(c).toMatchObject({ n: 2, brier: 0, ece: 0 });
    expect(c.bins.map(b => b.n)).toEqual([1, 0, 0, 0, 1]);
  });
});
