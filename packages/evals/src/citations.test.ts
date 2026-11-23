import { describe, expect, it } from 'vitest';
import { evaluateCitations, type CitationCase, type StoredChunk } from './citations.js';

const text = 'Fluence is positioned to be a leading participant in this growth,\nwith 7.2 GW of energy storage assets deployed.';
const chunk: StoredChunk = { id: 'c1', issuerKey: 'cik:0001868941', availableOn: '2026-03-02', docKind: 'sec_filing', text };
const chunks = (...extra: StoredChunk[]) => new Map([chunk, ...extra].map(c => [c.id, c]));
const cite = (over: Partial<CitationCase['citations'][number]> = {}) => ({ evidenceId: 'e1', chunkId: 'c1', quote: '7.2 GW of energy storage assets deployed', availableOn: '2026-03-02', ...over });
const score = (over: Partial<CitationCase> = {}): CitationCase => ({
  scoreId: 's1', symbol: 'FLNC.US', kpiId: 'storage_share', method: 'judgement', asOf: '2026-11-22',
  allowedIssuerKeys: ['cik:0001868941'], offered: [{ id: 'e1', chunkId: 'c1' }], citations: [cite()], ...over,
});

describe('evaluateCitations', () => {
  it('passes every check for a real, verbatim, dated, same-issuer citation', () => {
    const report = evaluateCitations({ cases: [score()], chunks: chunks() });
    expect(report.failures).toEqual([]);
    for (const check of ['id', 'verbatim', 'point_in_time', 'issuer'] as const) expect(report.checks[check]).toEqual({ passed: 1, total: 1, rate: 1 });
    expect(report.gates).toEqual({ citationIds: { required: 1, rate: 1, passed: true }, verbatim: { required: 0.98, rate: 1, passed: true } });
  });

  it('fails the id check and the gate for an evidence ID that was never offered', () => {
    const report = evaluateCitations({ cases: [score({ citations: [cite({ evidenceId: 'e9' })] })], chunks: chunks() });
    expect(report.checks.id).toEqual({ passed: 0, total: 1, rate: 0 });
    expect(report.failures.map(f => f.check)).toEqual(['id']);
    expect(report.gates.citationIds.passed).toBe(false);
  });

  it('fails the id check when the label was offered for a different chunk', () => {
    const other = { ...chunk, id: 'c2' };
    const report = evaluateCitations({ cases: [score({ citations: [cite({ chunkId: 'c2' })] })], chunks: chunks(other) });
    expect(report.failures.map(f => f.check)).toEqual(['id']);
  });

  it('fails all four checks, with matching denominators, when the cited chunk is not in the store', () => {
    const report = evaluateCitations({ cases: [score({ offered: [{ id: 'e1', chunkId: 'gone' }], citations: [cite({ chunkId: 'gone' })] })], chunks: chunks() });
    for (const check of ['id', 'verbatim', 'point_in_time', 'issuer'] as const) expect(report.checks[check]).toEqual({ passed: 0, total: 1, rate: 0 });
    expect(report.failures.map(f => f.check)).toEqual(['id', 'verbatim', 'point_in_time', 'issuer']);
  });

  it('fails verbatim for an altered quote', () => {
    const report = evaluateCitations({ cases: [score({ citations: [cite({ quote: '7.5 GW of energy storage assets deployed' })] })], chunks: chunks() });
    expect(report.checks.verbatim).toEqual({ passed: 0, total: 1, rate: 0 });
    expect(report.failures.map(f => f.check)).toEqual(['verbatim']);
  });

  it('fails verbatim for a quote that differs only in case', () => {
    const report = evaluateCitations({ cases: [score({ citations: [cite({ quote: '7.2 gw of energy storage assets deployed' })] })], chunks: chunks() });
    expect(report.checks.verbatim.passed).toBe(0);
  });

  it('fails verbatim for an empty quote', () => {
    const report = evaluateCitations({ cases: [score({ citations: [cite({ quote: ' \n ' })] })], chunks: chunks() });
    expect(report.checks.verbatim.passed).toBe(0);
  });

  it('passes verbatim when only whitespace differs', () => {
    const report = evaluateCitations({ cases: [score({ citations: [cite({ quote: '  in this growth, with 7.2\tGW  of ' })] })], chunks: chunks() });
    expect(report.checks.verbatim).toEqual({ passed: 1, total: 1, rate: 1 });
  });

  it('fails point_in_time for a chunk available after the as-of date, and passes one available on it', () => {
    const late = { ...chunk, id: 'c2', availableOn: '2026-11-23' }, same = { ...chunk, id: 'c3', availableOn: '2026-11-22' };
    const report = evaluateCitations({
      cases: [score({ offered: [{ id: 'e1', chunkId: 'c2' }, { id: 'e2', chunkId: 'c3' }], citations: [cite({ chunkId: 'c2' }), cite({ evidenceId: 'e2', chunkId: 'c3' })] })],
      chunks: chunks(late, same),
    });
    expect(report.checks.point_in_time).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(report.failures).toEqual([expect.objectContaining({ evidenceId: 'e1', check: 'point_in_time' })]);
  });

  it('fails issuer for a chunk from another company', () => {
    const report = evaluateCitations({ cases: [score({ allowedIssuerKeys: ['cik:0000320193'] })], chunks: chunks() });
    expect(report.checks.issuer).toEqual({ passed: 0, total: 1, rate: 0 });
    expect(report.failures.map(f => f.check)).toEqual(['issuer']);
  });

  it('passes the verbatim gate at 49 of 50 quotes and fails it at 48 of 50', () => {
    const run = (bad: number) => evaluateCitations({
      cases: Array.from({ length: 50 }, (_, i) => score({ scoreId: `s${i}`, citations: [cite(i < bad ? { quote: 'not in the passage at all' } : {})] })),
      chunks: chunks(),
    });
    expect(run(1).checks.verbatim).toEqual({ passed: 49, total: 50, rate: 0.98 });
    expect(run(1).gates.verbatim).toEqual({ required: 0.98, rate: 0.98, passed: true });
    expect(run(2).gates.verbatim).toEqual({ required: 0.98, rate: 0.96, passed: false });
  });

  it('never passes a gate on an empty denominator', () => {
    for (const cases of [[], [score({ method: 'quant', citations: [] })]]) {
      const report = evaluateCitations({ cases, chunks: chunks() });
      expect(report.checks.id).toEqual({ passed: 0, total: 0, rate: null });
      expect(report.gates).toEqual({ citationIds: { required: 1, rate: null, passed: false }, verbatim: { required: 0.98, rate: null, passed: false } });
    }
  });

  it('counts scores, scores with citations and citations', () => {
    const report = evaluateCitations({ cases: [score(), score({ scoreId: 's2', method: 'quant', citations: [] }), score({ scoreId: 's3', citations: [cite(), cite()] })], chunks: chunks() });
    expect(report.totals).toEqual({ scores: 3, scoresWithCitations: 2, citations: 3 });
  });

  it('names the score, company, KPI and label in every failure', () => {
    const report = evaluateCitations({ cases: [score({ scoreId: 'score-42', symbol: 'SAP.XETRA', kpiId: 'grid_software', citations: [cite({ quote: 'invented' })] })], chunks: chunks() });
    expect(report.failures).toEqual([{ scoreId: 'score-42', symbol: 'SAP.XETRA', kpiId: 'grid_software', evidenceId: 'e1', check: 'verbatim', detail: expect.stringContaining('c1') }]);
  });
});
