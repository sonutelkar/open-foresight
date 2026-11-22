import { describe, expect, it } from 'vitest';
import { loadPrompt, render } from './index.js';

describe('loadPrompt', () => {
  it('loads the Designer prompt with a content addressed version', () => {
    const p = loadPrompt('designer', 'v2');
    expect(p.promptVersion).toMatch(/^designer@v2:[0-9a-f]{12}$/);
    expect(p.sha256).toHaveLength(64);
    expect(p.system).toContain('Designer for Open Foresight');
    expect(p.user).toContain('Theme brief:');
    expect(loadPrompt('designer', 'v2')).toEqual(p);
  });
  it('lists exactly the placeholders the Designer fills', () => {
    const p = loadPrompt('designer', 'v2');
    const names = (t: string) => [...new Set([...t.matchAll(/\{\{([a-z_]+)\}\}/g)].map(m => m[1]))].sort();
    expect(names(p.system)).toEqual(['quant_functions', 'sources']);
    expect(names(p.user)).toEqual(['as_of', 'brief', 'exclusions', 'exposure_style', 'keywords', 'regions', 'seed_names', 'universe_sample']);
  });
  it('rejects unsafe or missing names', () => {
    expect(() => loadPrompt('../secrets', 'v1')).toThrow('Invalid');
    expect(() => loadPrompt('designer', 'v2/../v3')).toThrow('Invalid');
    expect(() => loadPrompt('designer', 'v9')).toThrow();
  });
});

describe('render', () => {
  it('fills placeholders and rejects missing or unused variables', () => {
    expect(render('Hello {{name}}, {{name}}.', { name: 'Ada' })).toBe('Hello Ada, Ada.');
    expect(() => render('Hello {{name}}', {})).toThrow('Missing prompt variable: name');
    expect(() => render('Hello', { name: 'Ada' })).toThrow('Unused prompt variables: name');
  });
  it('does not re-expand placeholders inside values', () => {
    expect(render('A {{x}}', { x: '{{y}}' })).toBe('A {{y}}');
  });
});

describe('Analyst prompts', () => {
  const names = (t: string) => [...new Set([...t.matchAll(/\{\{([a-z_]+)\}\}/g)].map(m => m[1]))].sort();
  it('load with the placeholders the Analyst fills', () => {
    const j = loadPrompt('analyst-judgement', 'v1');
    expect(j.promptVersion).toMatch(/^analyst-judgement@v1:[0-9a-f]{12}$/);
    expect(names(j.system)).toEqual([]);
    expect(names(j.user)).toEqual(['as_of', 'company', 'definition', 'kpi_name', 'passages', 'rubric', 'symbol', 'unknown_rule']);
    const e = loadPrompt('analyst-extraction', 'v1');
    expect(names(e.system)).toEqual([]);
    expect(names(e.user)).toEqual(['as_of', 'company', 'definition', 'kpi_name', 'passages', 'rubric', 'symbol', 'target', 'unit']);
  });
  it('tell the model that silence is not absence and that quotes are verbatim', () => {
    expect(loadPrompt('analyst-judgement', 'v1').system).toContain('silent about the KPI is not evidence');
    expect(loadPrompt('analyst-extraction', 'v1').system).toContain('copied exactly');
  });
});
