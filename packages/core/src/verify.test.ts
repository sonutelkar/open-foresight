import { describe, expect, it } from 'vitest';
import type { Kpi } from './framework.js';
import { claimFor, decideSupport, levelsToCheck, spanWindow } from './verify.js';

const kpi = { id: 'k', method: 'judgement', rubric: { levels: { '0': 'none', '1': 'mention', '2': 'minor', '3': 'segment', '4': 'majority' }, unknown: 'u' } } as unknown as Kpi;

describe('levelsToCheck', () => {
  it('checks levels 3 and 4 and the levels below, and nothing else', () => {
    expect(levelsToCheck('4')).toEqual(['4', '3', '2', '1']);
    expect(levelsToCheck('3')).toEqual(['3', '2', '1']);
    for (const l of ['2', '1', '0', 'unknown'] as const) expect(levelsToCheck(l)).toEqual([]);
  });
  it('reads the claim from the rubric', () => { expect(claimFor(kpi, '4')).toBe('majority'); expect(claimFor(kpi, 'unknown')).toBeNull(); });
});

describe('decideSupport', () => {
  const probes = (...ps: Array<[ '4' | '3' | '2' | '1', number]>) => ps.map(([level, best]) => ({ level, best }));
  it('keeps a supported level without a note', () => {
    expect(decideSupport('4', probes(['4', 0.6]))).toEqual({ level: '4', adjustment: null });
  });
  it('keeps a borderline level and records the doubt', () => {
    const d = decideSupport('4', probes(['4', 0.5]));
    expect(d.level).toBe('4');
    expect(d.adjustment).toMatchObject({ code: 'jev_borderline', from: '4', to: '4' });
  });
  it('steps down to the first supported level', () => {
    const d = decideSupport('4', probes(['4', 0.1], ['3', 0.2], ['2', 0.9], ['1', 0.95]));
    expect(d.level).toBe('2');
    expect(d.adjustment).toMatchObject({ code: 'jev_unsupported', from: '4', to: '2' });
  });
  it('accepts a lower level at the borderline probability, because a weaker claim needs less', () => {
    expect(decideSupport('3', probes(['3', 0.25], ['2', 0.45])).level).toBe('2');
    expect(decideSupport('3', probes(['3', 0.25], ['2', 0.39], ['1', 0.41])).level).toBe('1');
  });
  it('falls to the floor when no level is supported, and never to level 0', () => {
    expect(decideSupport('3', probes(['3', 0.05], ['2', 0.1], ['1', 0.2])).level).toBe('1');
  });
  it('never raises a level', () => {
    expect(decideSupport('3', probes(['3', 0.1], ['2', 0.1], ['1', 0.1])).level).toBe('1');
    expect(decideSupport('2', probes())).toEqual({ level: '2', adjustment: null });
  });
});

describe('spanWindow', () => {
  const text = `${'Intro words. '.repeat(100)}We derived 78.7% of our revenue from system solutions. ${'More words. '.repeat(100)}`;
  it('returns the stored text around the quote, bounded on each side', () => {
    const w = spanWindow(text, 'We derived  78.7% of our revenue from system solutions.', 100)!;
    expect(w).toContain('78.7% of our revenue');
    expect(w.length).toBeLessThan(400);
  });
  it('returns null when the quote is not in the stored text', () => {
    expect(spanWindow(text, 'We derived 90% of our revenue from system solutions.')).toBeNull();
    expect(spanWindow(text, '   ')).toBeNull();
  });
  it('returns the whole text when it is short', () => { expect(spanWindow('Short passage here.', 'passage here')).toBe('Short passage here.'); });
});
