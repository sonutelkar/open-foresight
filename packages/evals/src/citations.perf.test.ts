import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { citationCaseSchema, citationGates, evaluateCitations } from './citations.js';

/** The citations of the real PR 17 pilot run, recorded with the stored text they cite. See apps/worker/scripts/record-pilot-citations.ts. */
const recorded = JSON.parse(readFileSync(new URL('../fixtures/pilot-citations.json', import.meta.url), 'utf8')) as { cases: unknown[]; chunks: Array<{ id: string; issuerKey: string; availableOn: string; docKind: string; text: string }> };
const cases = recorded.cases.map(c => citationCaseSchema.parse(c));
const chunks = new Map(recorded.chunks.map(c => [c.id, c]));

describe('citation evaluation on the recorded pilot', () => {
  it('passes both gates on the real recorded citations, with every check at its full denominator', () => {
    const report = evaluateCitations({ cases, chunks });
    const total = cases.reduce((s, c) => s + c.citations.length, 0);
    expect(total).toBeGreaterThan(100);
    for (const check of ['id', 'verbatim', 'point_in_time', 'issuer'] as const) expect(report.checks[check]).toMatchObject({ passed: total, total });
    expect(report.failures).toEqual([]);
    expect(report.gates.citationIds.passed).toBe(true);
    expect(report.gates.verbatim.passed).toBe(true);
    expect(citationGates.citationIds.numerator).toBe(1);
  });

  it('fails the same recording once one quote is altered, so the pass above is not vacuous', () => {
    const altered = structuredClone(cases);
    const first = altered.find(c => c.citations.length > 0)!;
    first.citations[0]!.quote = `${first.citations[0]!.quote} and a claim the filing never makes`;
    const report = evaluateCitations({ cases: altered, chunks });
    expect(report.failures.map(f => f.check)).toEqual(['verbatim']);
    expect(report.gates.verbatim.rate).toBeLessThan(1);
  });

  it('evaluates 1,000 recorded citations well inside the 30 second ceiling', () => {
    const repeats = Math.ceil(1000 / cases.reduce((s, c) => s + c.citations.length, 0));
    const big = Array.from({ length: repeats }, (_, i) => cases.map(c => ({ ...c, scoreId: `${c.scoreId}-${i}` }))).flat();
    const times: number[] = [];
    for (let run = 0; run < 5; run++) { const t = performance.now(); evaluateCitations({ cases: big, chunks }); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: 'citation evaluation on recorded pilot citations', citations: big.reduce((s, c) => s + c.citations.length, 0), medianMs: Math.round(times[2]!) })}\n`);
    expect(times[2]!).toBeLessThan(30_000);
  });
});
