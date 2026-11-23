import { describe, expect, it } from 'vitest';
import { evaluateCitations, type CitationCase, type StoredChunk } from './citations.js';
import { buildPilotReport, pilotReportSchema, type PilotInput } from './pilot.js';

const chunk: StoredChunk = { id: 'c1', issuerKey: 'cik:1', availableOn: '2026-03-02', docKind: 'sec_filing', text: 'We deployed 7.2 GW of energy storage.' };
const scored: CitationCase = {
  scoreId: 's1', symbol: 'FLNC.US', kpiId: 'storage', method: 'judgement', asOf: '2026-11-22', allowedIssuerKeys: ['cik:1'],
  offered: [{ id: 'e1', chunkId: 'c1' }], citations: [{ evidenceId: 'e1', chunkId: 'c1', quote: '7.2 GW of energy storage', availableOn: '2026-03-02' }],
};
const at = (minutes: number) => new Date(Date.parse('2026-11-22T21:57:00Z') + minutes * 60_000);
const input = (over: Partial<PilotInput> = {}): PilotInput => ({
  runId: 'run-1', brief: `Smart energy: ${'grid equipment, storage and demand response. '.repeat(5)}`, asOf: '2026-11-22', snapshotId: 'snap-1', createdAt: at(0),
  statusHistory: [
    { status: 'draft', at: at(0) }, { status: 'designing', at: at(0.5) }, { status: 'awaiting_kpi_approval', at: at(1) },
    { status: 'prescreening', at: at(11) }, { status: 'analysing', at: at(11.5) }, { status: 'packaging', at: at(20) }, { status: 'done', at: at(21) },
  ],
  approval: { decisionId: 'decision-1', analyst: 'Ada Analyst', at: at(11) },
  llmCalls: [
    { role: 'analyst', model: 'openai/gpt-6-luna', provider: 'Azure', costUsd: 0.1, latencyMs: 9000 },
    { role: 'analyst', model: 'openai/gpt-6-luna', provider: 'Azure', costUsd: 0.2, latencyMs: 7000 },
    { role: 'designer', model: 'anthropic/claude-opus-5.5', provider: 'Google', costUsd: 0.13, latencyMs: null },
  ],
  embeddingCostsUsd: [0.0001, 0.0002, null],
  funnel: { universe: 46, screened: 32, candidates: 32, eligible: 14, selected: 14 },
  scores: [
    { method: 'judgement', level: '3', adjustmentCodes: [] },
    { method: 'judgement', level: '2', adjustmentCodes: ['no_definition_term', 'no_definition_term'] },
    { method: 'quant', level: 'unknown', adjustmentCodes: [] },
  ],
  citations: evaluateCitations({ cases: [scored], chunks: new Map([[chunk.id, chunk]]) }),
  ...over,
});

describe('buildPilotReport', () => {
  it('writes a versioned document with times, approval, models, costs and score counts', () => {
    const report = buildPilotReport(input());
    expect(pilotReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(report).toMatchObject({ schemaVersion: 1, runId: 'run-1', asOf: '2026-11-22', snapshotId: 'snap-1', host: 'local', approval: { analyst: 'Ada Analyst', decisionId: 'decision-1' } });
    expect(report.theme).toHaveLength(120);
    expect(report.timestamps).toEqual({
      createdAt: '2026-11-22T21:57:00.000Z', approvedAt: '2026-11-22T22:08:00.000Z', doneAt: '2026-11-22T22:18:00.000Z',
      elapsedMs: 21 * 60_000, gateWaitMs: 10 * 60_000, machineMs: 11 * 60_000,
    });
    expect(report.models).toEqual([
      { role: 'analyst', model: 'openai/gpt-6-luna', provider: 'Azure', calls: 2, costUsd: 0.3, medianLatencyMs: 8000 },
      { role: 'designer', model: 'anthropic/claude-opus-5.5', provider: 'Google', calls: 1, costUsd: 0.13, medianLatencyMs: null },
    ]);
    expect(report.embeddingCostUsd).toBe(0.0003);
    expect(report.totalCostUsd).toBe(0.4303);
    expect(report.scores).toEqual({ total: 3, byMethod: { judgement: { '3': 1, '2': 1 }, quant: { unknown: 1 } }, adjustments: { no_definition_term: 1 } });
    expect(report.gates).toEqual({
      elapsed: { required: 1_800_000, actual: 11 * 60_000, elapsedMs: 21 * 60_000, passed: true },
      citationIds: { required: 1, actual: 1, passed: true }, verbatim: { required: 0.98, actual: 1, passed: true },
      basket: { required: 1, actual: 14, passed: true }, passed: true,
    });
  });

  it('fails a pilot that selects no names, even when every citation gate passes', () => {
    const empty = buildPilotReport(input({ funnel: { universe: 46, screened: 32, candidates: 32, gateUnknown: 31, gateFailed: 1, eligible: 0, selected: 0 } }));
    expect(empty.gates.citationIds.passed).toBe(true);
    expect(empty.gates.basket).toEqual({ required: 1, actual: 0, passed: false });
    expect(empty.gates.passed).toBe(false);
    expect(buildPilotReport(input({ funnel: null })).gates.basket.passed).toBe(false);
  });

  it('fails the elapsed gate when machine time reaches 30 minutes, even with the gate wait removed', () => {
    const slow = buildPilotReport(input({ statusHistory: [{ status: 'awaiting_kpi_approval', at: at(1) }, { status: 'done', at: at(40) }] }));
    expect(slow.gates.elapsed).toEqual({ required: 1_800_000, actual: 30 * 60_000, elapsedMs: 40 * 60_000, passed: false });
    expect(slow.gates.passed).toBe(false);
  });

  it('fails the citation gates, and the report, when no citation was measured', () => {
    const report = buildPilotReport(input({ citations: evaluateCitations({ cases: [], chunks: new Map() }) }));
    expect(report.gates.citationIds).toEqual({ required: 1, actual: null, passed: false });
    expect(report.gates.verbatim).toEqual({ required: 0.98, actual: null, passed: false });
    expect(report.gates.passed).toBe(false);
  });

  it('fails the report when one citation ID is missing', () => {
    const bad = { ...scored, citations: [...scored.citations, { ...scored.citations[0], evidenceId: 'e7' }] };
    const report = buildPilotReport(input({ citations: evaluateCitations({ cases: [bad], chunks: new Map([[chunk.id, chunk]]) }) }));
    expect(report.gates.citationIds).toEqual({ required: 1, actual: 0.5, passed: false });
    expect(report.gates.passed).toBe(false);
  });

  it('keeps an AI-labelled set provisional and never counts it toward the release gates', () => {
    const labelledSet = { source: 'ai' as const, pairs: 200, weightedKappa: 0.91, exactAgreement: 0.88, stability: 0.99, provisional: true as const };
    const report = buildPilotReport(input({ labelledSet }));
    expect(report.labelledSet).toEqual(labelledSet);
    expect(report.releaseGates.weightedKappa).toMatchObject({ required: 0.6, satisfied: false });
    expect(report.releaseGates.stability).toMatchObject({ required: 0.95, satisfied: false });
    expect(() => buildPilotReport(input({ labelledSet: { ...labelledSet, provisional: false } as never }))).toThrow();
  });

  it('refuses a run that never finished', () => {
    expect(() => buildPilotReport(input({ statusHistory: [{ status: 'awaiting_kpi_approval', at: at(1) }, { status: 'analysing', at: at(12) }] }))).toThrow(/no done status/);
  });
});

describe('pilotReportSchema', () => {
  const report = () => JSON.parse(JSON.stringify(buildPilotReport(input())));

  it('rejects a document that claims a release gate is satisfied', () => {
    const edited = report();
    edited.releaseGates.weightedKappa.satisfied = true;
    expect(pilotReportSchema.safeParse(edited).success).toBe(false);
  });

  it('rejects a citation gate that passes with no measured rate', () => {
    const edited = report();
    edited.gates.verbatim = { required: 0.98, actual: null, passed: true };
    expect(pilotReportSchema.safeParse(edited).success).toBe(false);
  });

  it('rejects an overall pass when a gate failed', () => {
    const edited = report();
    edited.gates.elapsed = { ...edited.gates.elapsed, actual: 1_800_000, passed: false };
    expect(pilotReportSchema.safeParse(edited).success).toBe(false);
    edited.gates.passed = false;
    expect(pilotReportSchema.safeParse(edited).success).toBe(true);
  });
});
