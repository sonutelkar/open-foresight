import { describe, expect, it } from 'vitest';
import { resolveIsin, type Candidate } from './openfigi.js';

const c = (figi: string, shareClassFIGI: string | null, name = 'X CORP'): Candidate => ({ figi, name, shareClassFIGI });

describe('resolveIsin', () => {
  it('resolves many venue listings of one share class to that class', () => {
    expect(resolveIsin([c('A', 'SC1'), c('B', 'SC1'), c('C', 'SC1')])).toMatchObject({ status: 'resolved', shareClassFigi: 'SC1', classes: [{ shareClassFigi: 'SC1', venues: 3 }] });
  });
  it('is ambiguous when an ISIN returns several share classes', () => {
    const r = resolveIsin([c('A', 'SC1'), c('B', 'SC2')]);
    expect(r.status).toBe('ambiguous');
    expect(r.classes).toHaveLength(2);
  });
  it('is unmatched with no candidates or no share class', () => {
    expect(resolveIsin([]).status).toBe('unmatched');
    expect(resolveIsin([c('A', null), c('B', undefined as unknown as null)]).status).toBe('unmatched');
  });
});
