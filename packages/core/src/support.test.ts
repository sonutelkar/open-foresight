import { describe, expect, it } from 'vitest';
import type { Kpi } from './framework.js';
import { capUnsupportedLevel, definitionTerms } from './support.js';

const kpi = { id: 'smart_energy_presence', method: 'judgement', definition: "This KPI tests whether the company's filings name products, services or contracted programmes in grid equipment, grid automation, energy efficiency, demand response, stationary storage or inverters, and how central those offerings are to the business." } as unknown as Kpi;
const cite = (quote: string) => ({ quote });

describe('definition terms', () => {
  it('keeps the offerings and drops filler', () => {
    const t = definitionTerms(kpi.method === 'judgement' ? kpi.definition : '');
    expect(t).toEqual(expect.arrayContaining(['grid', 'storag', 'invert', 'automa', 'demand']));
    expect(t).not.toContain('filing');
    expect(t).not.toContain('offeri');
  });
});

describe('capUnsupportedLevel', () => {
  it('lowers level 4 when the Shoals quotes name no defined offering', () => {
    const r = capUnsupportedLevel({ kpi, level: '4', citations: [cite('We refer to complete EBOS solutions that use products manufactured by us, typically in connection with the design and specification of an entire EBOS system, as "system solutions".'), cite('We derived 78.7% of our revenue from the sale of system solutions for the year ended December 31, 2025.')] });
    expect(r.level).toBe('2');
    expect(r.adjustment).toMatchObject({ code: 'no_definition_term', from: '4', to: '2' });
  });
  it('keeps the level when one quote names a defined offering', () => {
    expect(capUnsupportedLevel({ kpi, level: '4', citations: [cite('We derived 78.7% of revenue from grid-scale battery storage systems.')] })).toEqual({ level: '4', adjustment: null });
  });
  it('lowers level 3 with no citations at all, and leaves levels 0 to 2 and unknown alone', () => {
    expect(capUnsupportedLevel({ kpi, level: '3', citations: [] }).level).toBe('2');
    for (const level of ['0', '1', '2', 'unknown'] as const) expect(capUnsupportedLevel({ kpi, level, citations: [] })).toEqual({ level, adjustment: null });
  });
  it('never touches a KPI that is not a judgement', () => {
    const quant = { id: 'q', method: 'extract_then_quant', definition: 'x' } as unknown as Kpi;
    expect(capUnsupportedLevel({ kpi: quant, level: '4', citations: [] })).toEqual({ level: '4', adjustment: null });
  });
});
