import { describe, expect, it } from 'vitest';
import { basketView, decisionText, esefReportLink, formatDay, formatScore, levelText, methodName, quoteInPassage, runContextLine, stageName } from './evidence.js';
import { sourceName } from './sources.js';

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

describe('run labels', () => {
  it('names the stage and the decision the way a person reads them', () => {
    expect(stageName('awaiting_kpi_approval')).toBe('KPI approval');
    expect(decisionText({ userId: 'Ada Analyst', action: 'approve', stage: 'awaiting_kpi_approval', reason: null })).toBe('Approved at KPI approval by Ada Analyst');
    expect(decisionText({ userId: 'Ada', action: 'approve', stage: 'awaiting_kpi_approval', reason: 'weights checked' })).toBe('Approved at KPI approval by Ada · weights checked');
  });
  it('writes the context line, and leaves out what is not known yet', () => {
    expect(formatDay('2026-11-23')).toBe('23 Nov 2026');
    expect(formatDay('soon')).toBe('soon');
    expect(runContextLine({ exposureStyle: 'broad', asOf: '2026-11-23', names: 18, capPercent: 8, started: '14:46' })).toBe('Broad, as of 23 Nov 2026, 18 names, cap 8%, started 14:46');
    expect(runContextLine({ exposureStyle: 'strict', asOf: '2026-11-23', names: 1 })).toBe('Strict, as of 23 Nov 2026, 1 name');
    expect(runContextLine({})).toBe('');
  });
  it('names sources and methods, and falls back to a readable form', () => {
    expect(sourceName('sec_filings')).toBe('SEC filings (10-K, 10-Q)');
    expect(sourceName('new_source')).toBe('new source');
    expect(methodName('extract_then_quant')).toBe('Extract then quant');
    expect(methodName('judgement')).toBe('Judgement');
  });
});
