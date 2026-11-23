import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@open-foresight/llm';
import { filterByRelevance, type Passage, type RelevanceJudge } from './relevance.js';

/** Real Jev decisions on 20 passages from Apple's 10-K, recorded by apps/worker/scripts/jev-relevance-check.ts. */
const recorded = JSON.parse(readFileSync(new URL('../fixtures/jev-relevance.json', import.meta.url), 'utf8')) as {
  query: string; company: string; asOf: string; issuerKeys: string[]; candidates: Passage[];
  decisions: Array<{ inputEvidenceIds: string[]; answers: Record<string, { type: 'noul'; noul: number }> }>;
};
const recordedNoul = new Map(recorded.decisions.flatMap(d => d.inputEvidenceIds.map((id, i) => [id, d.answers[`relevant_p${i + 1}`]!.noul] as const)));

/** Replays the recorded answer for each passage. A passage with no recording gets a confident yes, so a passage that should never reach Jev would be kept if it did. */
function recordedJudge(fail = false) {
  const requests: DecisionRequest[] = [];
  const judge: RelevanceJudge = {
    async decide(input) {
      requests.push(input);
      if (fail) throw new Error('Decision call failed: 503');
      return { id: `dec-${requests.length}`, answers: Object.fromEntries(input.inputEvidenceIds.map((id, i) => [`relevant_p${i + 1}`, { type: 'noul' as const, noul: recordedNoul.get(id) ?? 0.99 }])) };
    },
  };
  return { judge, requests };
}
const scope = (judge: RelevanceJudge) => ({ judge, runId: '3cc9c80f-e6d0-4a3f-a34e-6c3fb562d152', asOf: recorded.asOf, company: recorded.company, issuerKeys: recorded.issuerKeys });
const sent = (requests: DecisionRequest[]) => requests.flatMap(r => r.inputEvidenceIds);

const SEGMENT_TABLE = 'cb110524-6d53-4e41-ad1d-212f9b4c31ab';
const KEPT = ['104a8d80-64c8-4e86-bae3-8a4d8215caa8', '797cd847-d083-4c72-8d04-30705f2f9b06', SEGMENT_TABLE];
const cited = recorded.candidates.find(c => c.chunkId === SEGMENT_TABLE)!;

describe('Jev passage relevance filter', () => {
  it('keeps relevant passages in retrieval order and drops irrelevant ones, with the recorded decisions', async () => {
    const { judge, requests } = recordedJudge();
    const r = await filterByRelevance(scope(judge), recorded.query, recorded.candidates);
    expect(r.failure).toBeUndefined();
    // The passage the Analyst cited sits at 0.50 and stays. Its near duplicate at 0.48 and the risk factors at 0.04 go.
    expect(r.hits.map(h => h.chunkId)).toEqual(KEPT);
    expect(r.dropped).toContainEqual({ chunkId: 'c8dbeb8a-1100-46cf-bab5-1ee38c05de2a', reason: 'irrelevant' });
    expect(r.dropped).toContainEqual({ chunkId: '7130a727-0157-4376-ab62-8b5530b14528', reason: 'irrelevant' });
    expect(r.dropped).toHaveLength(17);
    expect(r.probabilities[SEGMENT_TABLE]).toBe(0.5);
    // What Jev receives: every passage once, the company and the question in the state, and an audited role and model.
    expect(sent(requests).sort()).toEqual(recorded.candidates.map(c => c.chunkId).sort());
    expect(requests.every(q => q.role === 'relevance' && q.model === 'typesafe/jev-1.14' && q.inputEvidenceIds.length <= 5)).toBe(true);
    const state = JSON.parse(requests[0]!.state) as { company: string; question: string; as_of: string };
    expect(state).toMatchObject({ company: 'APPLE INC', question: recorded.query, as_of: '2026-11-23' });
  });

  it("drops another company's passage in code before Jev sees it, even one Jev would keep", async () => {
    const { judge, requests } = recordedJudge();
    const other = { ...cited, chunkId: 'other-company-chunk', issuerKey: 'cik:0001652044' };
    const r = await filterByRelevance(scope(judge), recorded.query, [other, ...recorded.candidates]);
    expect(r.dropped).toContainEqual({ chunkId: 'other-company-chunk', reason: 'wrong_company' });
    expect(sent(requests)).not.toContain('other-company-chunk');
    expect(r.hits.map(h => h.chunkId)).toEqual(KEPT);
  });

  it('drops a passage dated after the as-of date in code before Jev sees it, even one Jev would keep', async () => {
    const { judge, requests } = recordedJudge();
    const future = { ...cited, chunkId: 'future-chunk', availableOn: '2026-11-24' };
    const r = await filterByRelevance(scope(judge), recorded.query, [...recorded.candidates, future]);
    expect(r.dropped).toContainEqual({ chunkId: 'future-chunk', reason: 'future_evidence' });
    expect(sent(requests)).not.toContain('future-chunk');
    expect(r.hits.map(h => h.chunkId)).toEqual(KEPT);
  });

  it('keeps every eligible passage when Jev fails, and still drops wrong-company and future passages', async () => {
    const { judge } = recordedJudge(true);
    const other = { ...cited, chunkId: 'other-company-chunk', issuerKey: 'cik:0001652044' };
    const future = { ...cited, chunkId: 'future-chunk', availableOn: '2026-11-24' };
    const r = await filterByRelevance(scope(judge), recorded.query, [other, ...recorded.candidates, future]);
    expect(r.failure).toContain('503');
    expect(r.hits.map(h => h.chunkId)).toEqual(recorded.candidates.map(c => c.chunkId));
    expect(r.dropped).toEqual([{ chunkId: 'other-company-chunk', reason: 'wrong_company' }, { chunkId: 'future-chunk', reason: 'future_evidence' }]);
  });

  it('makes no call when no passage is eligible', async () => {
    const { judge, requests } = recordedJudge();
    const r = await filterByRelevance(scope(judge), recorded.query, [{ ...cited, issuerKey: 'cik:0001652044' }]);
    expect(requests).toHaveLength(0);
    expect(r.hits).toEqual([]);
  });
});
