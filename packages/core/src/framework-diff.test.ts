import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enabledSources } from './sources.js';
import { validateFramework, type Framework, type FrameworkDraft } from './framework.js';
import { describeEdits, diffFramework } from './framework-diff.js';

const draft = JSON.parse(readFileSync(new URL('../fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const checked = validateFramework(draft, { availableSources: enabledSources({ eodhd: true }) });
if (!checked.ok) throw new Error('golden framework must be valid');
const base = checked.framework;
const clone = () => structuredClone(base) as Framework;

describe('diffFramework', () => {
  it('finds nothing when nothing changed', () => {
    expect(diffFramework(base, clone())).toEqual({ total: 0, weights: 0, gate: 0, rubrics: 0, sources: 0, wording: 0 });
    expect(describeEdits(diffFramework(base, clone()))).toBe('');
  });
  it('counts each kind of edit by KPI', () => {
    const f = clone();
    f.kpis[0]!.weightPercent += 5; f.kpis[1]!.weightPercent -= 5;
    f.kpis[2]!.isGate = false; f.kpis[3]!.isGate = true;
    const judge = f.kpis.find(k => k.method === 'judgement')!;
    if (judge.method === 'judgement') judge.rubric.levels['2'] = 'A different rubric sentence for level two.';
    f.kpis[4]!.sources = [...new Set([...f.kpis[4]!.sources, 'prices' as const])];
    f.kpis[4]!.definition = `${f.kpis[4]!.definition} Edited.`;
    const e = diffFramework(base, f);
    expect(e).toMatchObject({ weights: 2, gate: 2, rubrics: 1, wording: 1 });
    expect(e.total).toBe(e.weights + e.gate + e.rubrics + e.sources + e.wording);
  });
  it('counts an empty weight field as a changed weight', () => {
    const f = clone(); f.kpis[0]!.weightPercent = Number.NaN;
    expect(diffFramework(base, f).weights).toBe(1);
  });
  it('says what changed in one sentence', () => {
    expect(describeEdits({ total: 4, weights: 2, gate: 0, rubrics: 1, sources: 0, wording: 1 })).toBe('2 weights, 1 rubric and 1 name or definition changed from the draft');
    expect(describeEdits({ total: 1, weights: 1, gate: 0, rubrics: 0, sources: 0, wording: 0 })).toBe('1 weight changed from the draft');
    expect(describeEdits({ total: 1, weights: 0, gate: 1, rubrics: 0, sources: 0, wording: 0 })).toBe('the gate changed from the draft');
  });
});
