import { describe, expect, it } from 'vitest';
import { basketView, esefReportLink, formatScore, levelText, quoteInPassage } from './evidence.js';

describe('evidence helpers', () => {
  it('builds ESEF links from the stored path and leaves full links alone', () => {
    expect(esefReportLink('/724500/2025-12-31/ESEF/NL/0/a.xhtml')).toBe('https://filings.xbrl.org/724500/2025-12-31/ESEF/NL/0/a.xhtml');
    expect(esefReportLink('https://example.org/a.xhtml')).toBe('https://example.org/a.xhtml');
  });
  it('accepts a quote only when the passage contains it', () => {
    expect(quoteInPassage('7.2 GW  of storage', 'We deployed 7.2 GW\nof Storage assets.')).toBe(true);
    expect(quoteInPassage('9 GW of storage', 'We deployed 7.2 GW of storage assets.')).toBe(false);
    expect(quoteInPassage('  ', 'anything')).toBe(false);
  });
  it('renders scores and levels', () => {
    expect(formatScore(0.8)).toBe('0.800');
    expect(formatScore(Number.NaN)).toBe('n/a');
    expect(levelText('3')).toBe('Level 3 of 4');
    expect(levelText('unknown')).toBe('Unknown');
  });
  it('tells failed, pending, empty and ready runs apart', () => {
    expect(basketView({ status: 'failed' }, null)).toBe('failed');
    expect(basketView({ status: 'failed' }, { members: [{}] })).toBe('failed');
    expect(basketView({ status: 'analysing' }, null)).toBe('pending');
    expect(basketView({ status: 'done' }, { members: [] })).toBe('empty');
    expect(basketView({ status: 'done' }, { members: [{}] })).toBe('ready');
  });
});
