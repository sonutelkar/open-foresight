import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateFramework, type Kpi, type FrameworkDraft } from './framework.js';
import { computeConfidence, quantLevel, validateScore, type EvidenceItem } from './score.js';
import { enabledSources } from './sources.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const result = validateFramework(golden, { availableSources: enabledSources({ eodhd: true }) });
if (!result.ok) throw new Error('golden framework must be valid');
const kpis = result.framework.kpis;
const extractKpi = kpis.find(k => k.method === 'extract_then_quant') as Extract<Kpi, { method: 'extract_then_quant' }>;
const judgeKpi = kpis.find(k => k.method === 'judgement') as Extract<Kpi, { method: 'judgement' }>;
const quantKpi = kpis.find(k => k.method === 'quant') as Extract<Kpi, { method: 'quant' }>;

const ev = (id: string, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id, chunkId: `chunk-${id}`, docKind: 'sec_filing', docId: `doc-${id}`, issuerKey: 'cik:0000000001', section: 'Item 1. Business',
  startOffset: 0, endOffset: 200, availableOn: '2026-05-01',
  text: 'Our grid products segment generated  $3.1 billion\nof revenue, or 26% of total revenue, in fiscal 2025. We also sell storage systems.', ...over,
});
const evidence = [ev('e1'), ev('e2', { docId: 'doc-other', availableOn: '2026-08-01' })];
const base = { asOf: '2026-11-01', allowedIssuerKeys: ['cik:0000000001'], evidence };
const good = { citations: [{ evidenceId: 'e1', quote: 'generated $3.1 billion of revenue, or 26% of total revenue' }], rationale: 'The filing states that grid products were 26 percent of revenue.', conflicts: [] };
const codes = (r: ReturnType<typeof validateScore>) => r.ok ? [] : r.errors.map(e => e.code).sort();

describe('validateScore for judgement KPIs', () => {
  it('accepts a cited level and resolves its citations to stored offsets', () => {
    const r = validateScore({ ...base, kpi: judgeKpi, output: { level: '3', ...good } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.level).toBe('3');
    expect(r.citations[0]).toMatchObject({ evidenceId: 'e1', chunkId: 'chunk-e1', docId: 'doc-e1', section: 'Item 1. Business', startOffset: 0, endOffset: 200 });
  });
  it('treats whitespace as insignificant but case and wording as significant', () => {
    expect(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: 'e1', quote: 'generated   $3.1 billion\n of revenue' }] } }).ok).toBe(true);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: 'e1', quote: 'generated $3.1 billion of REVENUE' }] } }))).toEqual(['quote_not_verbatim']);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: 'e1', quote: 'generated $3.2 billion of revenue' }] } }))).toEqual(['quote_not_verbatim']);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: 'e1', quote: 'We also sell storage systems and inverters' }] } }))).toEqual(['quote_not_verbatim']);
  });
  it('rejects a quote cited against the wrong passage', () => {
    const other = [ev('e1'), ev('e2', { text: 'An unrelated passage about leases and pensions that mentions nothing else at all.' })];
    expect(codes(validateScore({ ...base, evidence: other, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: 'e2', quote: 'generated $3.1 billion of revenue' }] } }))).toEqual(['quote_not_verbatim']);
  });
  it('accepts unknown and level 0 without citations, and rejects a higher level with none', () => {
    expect(validateScore({ ...base, kpi: judgeKpi, output: { level: 'unknown', citations: [], rationale: 'The passages say nothing about this.', conflicts: [] } }).ok).toBe(true);
    expect(validateScore({ ...base, kpi: judgeKpi, output: { level: '0', citations: [], rationale: 'No passage mentions the theme.', conflicts: [] } }).ok).toBe(true);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '3', citations: [], rationale: 'Strong exposure.', conflicts: [] } }))).toEqual(['uncited_level']);
  });
  it('rejects a missing or empty evidence id', () => {
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: 'e9', quote: 'generated $3.1 billion of revenue' }] } }))).toEqual(['unknown_evidence_id']);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: '', quote: 'generated $3.1 billion of revenue' }] } }))).toEqual(['unknown_evidence_id']);
  });
  it('rejects evidence that belongs to another security', () => {
    const foreign = [ev('e1', { issuerKey: 'cik:0000000999' })];
    expect(codes(validateScore({ ...base, evidence: foreign, kpi: judgeKpi, output: { level: '2', ...good } }))).toEqual(['wrong_security']);
  });
  it('rejects evidence outside the lookback window or after the as-of date', () => {
    const lookback = judgeKpi.lookbackDays;
    const old = [ev('e1', { availableOn: '2023-01-01' })];
    expect(lookback).toBeLessThan(1000);
    expect(codes(validateScore({ ...base, evidence: old, kpi: judgeKpi, output: { level: '2', ...good } }))).toEqual(['outside_window']);
    const future = [ev('e1', { availableOn: '2026-11-02' })];
    expect(codes(validateScore({ ...base, evidence: future, kpi: judgeKpi, output: { level: '2', ...good } }))).toEqual(['outside_window']);
    const edge = [ev('e1', { availableOn: '2026-11-01' })];
    expect(validateScore({ ...base, evidence: edge, kpi: judgeKpi, output: { level: '2', ...good } }).ok).toBe(true);
  });
  it('limits quotes, citations and the rationale', () => {
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: [{ evidenceId: 'e1', quote: 'short' }] } }))).toEqual(['quote_length']);
    const many = Array.from({ length: 5 }, () => good.citations[0]!);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, citations: many } }))).toEqual(['too_many_citations']);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, rationale: 'x'.repeat(601) } }))).toEqual(['rationale_length']);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '2', ...good, rationale: '  ' } }))).toEqual(['rationale_length']);
  });
  it('rejects output of the wrong shape and reports every violation at once', () => {
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { extractedValue: 0.2, ...good } }))).toEqual(['wrong_output']);
    expect(codes(validateScore({ ...base, kpi: judgeKpi, output: { level: '9', ...good } }))).toEqual(['wrong_output']);
    const r = validateScore({ ...base, kpi: judgeKpi, output: { level: '3', citations: [{ evidenceId: 'e9', quote: 'whatever this says here' }, { evidenceId: 'e1', quote: 'a quote that is not in the text' }], rationale: '', conflicts: [] } });
    expect(codes(r)).toEqual(['quote_not_verbatim', 'rationale_length', 'unknown_evidence_id']);
  });
});

describe('validateScore for extract_then_quant KPIs', () => {
  const run = (value: number | null, extra: Partial<typeof good> = {}) => validateScore({ ...base, kpi: extractKpi, output: { extractedValue: value, ...good, ...extra } });
  it('sets the level by code from the thresholds', () => {
    const t = extractKpi.thresholds;
    const levels = [0, t[0], (t[0] + t[1]) / 2, t[1], t[2], t[3], 1].map(v => { const r = run(v); return r.ok ? r.level : 'invalid'; });
    expect(levels).toEqual(['0', '1', '1', '2', '3', '4', '4']);
    const r = run(0.26);
    expect(r.ok && r.level).toBe('3');
    expect(r.ok && r.extractedValue).toBe(0.26);
  });
  it('is unknown when no value is extracted', () => {
    const r = run(null, { citations: [] });
    expect(r.ok && r.level).toBe('unknown');
  });
  it('rejects a percent written as a number, a negative value and an uncited value', () => {
    expect(codes(run(26))).toEqual(['value_out_of_range']);
    expect(codes(run(-0.1))).toEqual(['value_out_of_range']);
    expect(codes(run(0.26, { citations: [] }))).toEqual(['uncited_value']);
  });
  it('allows large values for a usd unit', () => {
    const usd = { ...extractKpi, extraction: { ...extractKpi.extraction, unit: 'usd' as const }, thresholds: [1e8, 5e8, 1e9, 5e9] as [number, number, number, number] };
    const r = validateScore({ ...base, kpi: usd, output: { extractedValue: 3.1e9, ...good } });
    expect(r.ok && r.level).toBe('3');
  });
});

describe('quantLevel', () => {
  it('buckets a value and treats a missing one as unknown', () => {
    const t = quantKpi.thresholds;
    expect(quantLevel(quantKpi, t[0] - 0.001)).toBe('0');
    expect(quantLevel(quantKpi, t[3])).toBe('4');
    expect(quantLevel(quantKpi, null)).toBe('unknown');
    expect(quantLevel(quantKpi, Number.NaN)).toBe('unknown');
  });
});

describe('computeConfidence', () => {
  const cite = (docId: string, availableOn: string) => ({ docId, availableOn });
  const base2 = { method: 'judgement' as const, valid: true, level: '3' as const, conflicts: [], asOf: '2026-11-01' };
  it('is zero for invalid scores and missing quant values, and one for a computed quant value', () => {
    expect(computeConfidence({ ...base2, valid: false, citations: [cite('a', '2026-10-01')] })).toBe(0);
    expect(computeConfidence({ ...base2, method: 'quant', quantValue: null, citations: [] })).toBe(0);
    expect(computeConfidence({ ...base2, method: 'quant', quantValue: 0.04, citations: [] })).toBe(1);
  });
  it('rewards more citations, more documents and recent evidence, and penalises conflicts', () => {
    expect(computeConfidence({ ...base2, level: 'unknown', citations: [] })).toBe(0.2);
    expect(computeConfidence({ ...base2, citations: [cite('a', '2024-01-01')] })).toBe(0.4);
    expect(computeConfidence({ ...base2, citations: [cite('a', '2026-10-01')] })).toBe(0.6);
    expect(computeConfidence({ ...base2, citations: [cite('a', '2026-10-01'), cite('a', '2026-10-01')] })).toBe(0.8);
    expect(computeConfidence({ ...base2, citations: [cite('a', '2026-10-01'), cite('b', '2026-10-01')] })).toBe(1);
    expect(computeConfidence({ ...base2, conflicts: ['x'], citations: [cite('a', '2026-10-01'), cite('b', '2026-10-01')] })).toBe(0.8);
  });
});
