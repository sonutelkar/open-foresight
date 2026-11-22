import { describe, expect, it } from 'vitest';
import { validateBrief, type BriefError } from './brief.js';

const today = '2026-11-22';
const base = {
  brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon, including grid equipment, efficiency products and storage.',
  keywords: ['smart grid', 'storage'], seedNames: ['SU.PA'], exclusions: ['pure EV makers'], regions: ['US', 'EU'], minMarketCapUsd: 1e9, minAdvUsd: 5e6,
  asOf: '2026-11-20', exposureStyle: 'broad', basketSize: 40, weightCapPercent: 5, weighting: 'score', reviewLevel: 'kpis_and_flags', modelProfile: 'quality',
};
const errors = (over: Record<string, unknown>): BriefError[] => { const r = validateBrief({ ...base, ...over }, { today }); return r.ok ? [] : r.errors; };
const codes = (over: Record<string, unknown>) => errors(over).map(e => e.code).sort();

describe('validateBrief', () => {
  it('accepts a valid brief and cleans its lists', () => {
    const r = validateBrief({ ...base, keywords: [' smart grid ', 'smart grid', '', 'storage'], exclusions: [] }, { today });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.brief.keywords).toEqual(['smart grid', 'storage']);
  });
  it('rejects a short brief and counts words, not characters', () => {
    expect(codes({ brief: 'Too short to be a real investment theme.' })).toEqual(['brief_too_short']);
    expect(codes({ brief: Array.from({ length: 19 }, () => 'word').join(' ') })).toEqual(['brief_too_short']);
    expect(codes({ brief: Array.from({ length: 20 }, () => 'word').join(' ') })).toEqual([]);
    expect(codes({ brief: '   ' })).toEqual(['brief_too_short']);
    expect(errors({ brief: 'x' })[0]?.field).toBe('brief');
  });
  it('rejects a future as-of date, allows today and the past, and rejects an invalid date', () => {
    expect(codes({ asOf: '2026-11-23' })).toEqual(['future_date']);
    expect(codes({ asOf: '2026-11-22' })).toEqual([]);
    expect(codes({ asOf: '2020-01-31' })).toEqual([]);
    expect(codes({ asOf: '2026-13-40' })).toEqual(['shape']);
    expect(codes({ asOf: 'yesterday' })).toEqual(['shape']);
  });
  it('rejects a weight cap that cannot fill the basket and accepts the boundary', () => {
    expect(codes({ basketSize: 19, weightCapPercent: 5 })).toEqual(['infeasible_cap']);
    expect(codes({ basketSize: 20, weightCapPercent: 5 })).toEqual([]);
    expect(codes({ basketSize: 10, weightCapPercent: 9.9 })).toEqual(['infeasible_cap']);
    expect(errors({ basketSize: 10, weightCapPercent: 9 })[0]?.message).toContain('at most 90 percent');
    expect(codes({ basketSize: 10, weightCapPercent: 100 })).toEqual([]);
  });
  it('rejects bad regions, sizes, numbers and unknown fields', () => {
    expect(codes({ regions: [] })).toEqual(['shape']);
    expect(codes({ regions: ['JP'] })).toEqual(['shape']);
    expect(codes({ basketSize: 4 })).toContain('shape');
    expect(codes({ basketSize: 12.5 })).toContain('shape');
    expect(codes({ weightCapPercent: 0 })).toContain('shape');
    expect(codes({ weightCapPercent: 101 })).toContain('shape');
    expect(codes({ minMarketCapUsd: -1 })).toEqual(['shape']);
    expect(codes({ exposureStyle: 'wild' })).toEqual(['shape']);
    expect(codes({ extra: 1 })).toEqual(['shape']);
    expect(validateBrief(null, { today }).ok).toBe(false);
    expect(validateBrief('text', { today }).ok).toBe(false);
  });
  it('reports every problem at once', () => {
    const e = errors({ brief: 'short', asOf: '2027-01-01', basketSize: 6, weightCapPercent: 10 });
    expect(e.map(x => x.code).sort()).toEqual(['brief_too_short', 'future_date', 'infeasible_cap']);
    expect(e.map(x => x.field).sort()).toEqual(['asOf', 'brief', 'weightCapPercent']);
  });
});
