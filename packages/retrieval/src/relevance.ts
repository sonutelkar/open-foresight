import type { DecisionRequest, DecisionResult } from '@open-foresight/llm';
import type { Hit } from './search.js';

/** The part of the gateway the relevance filter uses. `createGateway` from `@open-foresight/llm` satisfies it. */
export type RelevanceJudge = { decide(input: DecisionRequest): Promise<Pick<DecisionResult, 'id' | 'answers'>> };

export const relevancePromptVersion = 'passage-relevance@v1';
/** The least probability of yes for a passage to stay. Provisional until a labelled evaluation sets it. */
export const relevanceThreshold = 0.5;
/** Passages per decision call. Five passages of about 2,500 characters keep the state well under the 32,000 byte long-context mark. */
const passagesPerCall = 5;

export type RelevanceScope = {
  judge: RelevanceJudge; runId: string; asOf: string;
  /** The company named in the question. */
  company: string;
  /** Issuers whose passages count for this company. Code drops any other passage before Jev sees it. */
  issuerKeys: readonly string[];
};
/** The fields the filter reads. A search `Hit` and the Analyst's evidence items both have them. */
export type Passage = Pick<Hit, 'chunkId' | 'issuerKey' | 'availableOn' | 'section' | 'text'>;
export type RelevanceResult<T extends Passage> = {
  /** The passages kept, in retrieval order. */
  hits: T[];
  /** Jev's probability that each judged passage helps answer the query, by chunk id. */
  probabilities: Record<string, number>;
  dropped: Array<{ chunkId: string; reason: 'wrong_company' | 'future_evidence' | 'irrelevant' }>;
  /** Set when a decision call failed. The eligible passages are then kept as retrieved. */
  failure?: string;
};

const instructions = (id: string) => `Does passage ${id}, from the company's own filing, contain information that helps answer the question about this company? Answer yes only for what the passage itself says.`;

/**
 * Removes retrieved passages that do not help answer the query. Code first drops passages from another issuer or dated after the as-of date,
 * so Jev never sees them and cannot keep them. Jev then answers one Noul per remaining passage, and code keeps those at or above `relevanceThreshold`.
 * The filter is optional and must not block retrieval, so a failed call keeps every eligible passage and records the failure.
 */
export async function filterByRelevance<T extends Passage>(scope: RelevanceScope, query: string, candidates: readonly T[]): Promise<RelevanceResult<T>> {
  const dropped: RelevanceResult<T>['dropped'] = [];
  const eligible = candidates.filter(h => {
    const reason = !scope.issuerKeys.includes(h.issuerKey) ? 'wrong_company' : h.availableOn > scope.asOf ? 'future_evidence' : undefined;
    if (reason) dropped.push({ chunkId: h.chunkId, reason });
    return !reason;
  });
  const batches = Array.from({ length: Math.ceil(eligible.length / passagesPerCall) }, (_, b) => eligible.slice(b * passagesPerCall, (b + 1) * passagesPerCall));
  const probabilities: Record<string, number> = {};
  try {
    await Promise.all(batches.map(async batch => {
      const ids = batch.map((_, i) => `p${i + 1}`);
      const result = await scope.judge.decide({
        runId: scope.runId, role: 'relevance', promptVersion: relevancePromptVersion, model: 'typesafe/jev-1.14',
        state: JSON.stringify({ company: scope.company, as_of: scope.asOf, question: query, passages: Object.fromEntries(batch.map((h, i) => [ids[i], `${h.section}\n${h.text}`])) }),
        questions: Object.fromEntries(ids.map(id => [`relevant_${id}`, { type: 'noul' as const, instructions: instructions(id) }])),
        inputEvidenceIds: batch.map(h => h.chunkId),
      });
      batch.forEach((h, i) => { const a = result.answers[`relevant_${ids[i]}`]; probabilities[h.chunkId] = a?.type === 'noul' ? a.noul : 0; });
    }));
  } catch (error) {
    return { hits: eligible, probabilities: {}, dropped, failure: error instanceof Error ? error.message : 'unknown' };
  }
  const hits = eligible.filter(h => {
    const keep = probabilities[h.chunkId]! >= relevanceThreshold;
    if (!keep) dropped.push({ chunkId: h.chunkId, reason: 'irrelevant' });
    return keep;
  });
  return { hits, probabilities, dropped };
}
