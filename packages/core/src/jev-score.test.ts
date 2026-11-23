import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enabledSources } from './sources.js';
import { validateFramework, type FrameworkDraft, type Kpi } from './framework.js';
import { jevLevelRule, jevScoreQuestions, readJevLevel } from './jev-score.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const checked = validateFramework(golden, { availableSources: enabledSources({ eodhd: true }) });
if (!checked.ok) throw new Error('golden framework must be valid');
const kpi = checked.framework.kpis.find(k => k.method === 'judgement') as Extract<Kpi, { method: 'judgement' }>;
/** The real Score answer recorded from Jev in PR 05b. */
const recorded = JSON.parse(readFileSync(new URL('../../llm/fixtures/jev/score.json', import.meta.url), 'utf8')).response.answers.score as { score: number; probabilities: Record<string, number>; confidence: number };

const at = (entries: Partial<Record<'0' | '1' | '2' | '3' | '4', number>>) => ({ '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, ...entries });

describe('jevScoreQuestions', () => {
  it('offers the approved rubric levels 0 to 4 in order and asks the unknown rule separately', () => {
    const q = jevScoreQuestions(kpi);
    expect(q.level.type).toBe('score');
    expect(q.level.criteria).toEqual([kpi.rubric.levels['0'], kpi.rubric.levels['1'], kpi.rubric.levels['2'], kpi.rubric.levels['3'], kpi.rubric.levels['4']]);
    expect(q.known.type).toBe('noul');
    expect(q.known.instructions).toContain(kpi.rubric.unknown);
  });
});

describe('readJevLevel', () => {
  it('reads a confident answer at each level as that level, with its probability as the confidence', () => {
    for (const l of ['0', '1', '2', '3', '4'] as const) {
      expect(readJevLevel(at({ [l]: 0.9, [l === '0' ? '1' : '0']: 0.1 }), 0.95)).toMatchObject({ level: l, reason: 'level', confidence: 0.9 });
    }
    expect(readJevLevel(at({ '0': 0.9, '1': 0.1 }), 0.95).weighted).toBeCloseTo(0.1, 12);
    expect(readJevLevel(at({ '4': 0.9, '0': 0.1 }), 0.95).weighted).toBeCloseTo(3.6, 12);
  });

  it('reads the recorded real answer as level 4, where the weighted level equals the score Jev reported', () => {
    const r = readJevLevel(recorded.probabilities, 1);
    expect(r).toEqual({ level: '4', reason: 'level', weighted: recorded.score, confidence: 1 });
  });

  it('rounds the weighted level to the nearest level, and a tie at .5 down', () => {
    expect(readJevLevel(at({ '2': 0.6, '3': 0.4 }), 0.9)).toMatchObject({ level: '2', confidence: 0.6 });
    expect(readJevLevel(at({ '2': 0.4, '3': 0.6 }), 0.9)).toMatchObject({ level: '3', confidence: 0.6 });
    expect(readJevLevel(at({ '1': 0.5, '2': 0.5 }), 0.9)).toMatchObject({ level: '1', confidence: 0.5 });
    expect(readJevLevel(at({ '3': 0.5, '4': 0.5 }), 0.9)).toMatchObject({ level: '3', confidence: 0.5 });
  });

  it('uses the weighted level and not the most likely one', () => {
    // Level 1 is the most likely at 0.45, but the weight above it pulls the weighted level to 2.3, so the level is 2, which Jev gave no probability.
    const r = readJevLevel(at({ '1': 0.45, '3': 0.35, '4': 0.2 }), 0.9);
    expect(r).toMatchObject({ level: '2', reason: 'level', confidence: 0 });
    expect(r.weighted).toBeCloseTo(2.3, 12);
  });

  it('keeps a level for evidence spread over neighbouring levels and reports the low confidence', () => {
    const r = readJevLevel(at({ '1': 0.35, '2': 0.35, '3': 0.3 }), 0.9);
    expect(r).toMatchObject({ level: '2', reason: 'level', confidence: 0.35 });
    expect(r.weighted).toBeCloseTo(1.95, 12);
  });

  it('gives unknown, not the middle level, for an answer split between levels far apart', () => {
    expect(readJevLevel(at({ '0': 0.5, '4': 0.5 }), 0.9)).toEqual({ level: 'unknown', reason: 'split', weighted: 2, confidence: 0 });
    // 0.45 within one level of level 2 is under the 0.5 line, and 0.5 is on it.
    expect(readJevLevel(at({ '0': 0.3, '2': 0.45, '4': 0.25 }), 0.9)).toMatchObject({ level: 'unknown', reason: 'split' });
    expect(jevLevelRule.minNear).toBe(0.5);
    expect(readJevLevel(at({ '0': 0.25, '2': 0.5, '4': 0.25 }), 0.9)).toMatchObject({ level: '2', reason: 'level', confidence: 0.5 });
  });

  it('gives unknown when the unknown rule applies, however sure the level', () => {
    expect(readJevLevel(at({ '3': 1 }), 0.2)).toEqual({ level: 'unknown', reason: 'unknown_rule', weighted: 3, confidence: 0 });
    expect(readJevLevel(at({ '3': 1 }), 0.49)).toMatchObject({ level: 'unknown', reason: 'unknown_rule' });
    expect(readJevLevel(at({ '3': 1 }), jevLevelRule.minKnown)).toMatchObject({ level: '3', reason: 'level' });
  });

  it('reads level 0 as a known level, separate from unknown', () => {
    expect(readJevLevel(at({ '0': 0.8, '1': 0.2 }), 0.9)).toMatchObject({ level: '0', reason: 'level', confidence: 0.8 });
  });

  it('normalises probabilities that do not sum to 1, and gives unknown when there are none', () => {
    const r = readJevLevel(at({ '2': 0.3, '3': 0.1 }), 0.9);
    expect(r.level).toBe('2');
    expect(r.confidence).toBeCloseTo(0.75, 12);
    expect(r.weighted).toBeCloseTo(2.25, 12);
    expect(readJevLevel({}, 0.9)).toEqual({ level: 'unknown', reason: 'split', weighted: null, confidence: 0 });
  });
});
