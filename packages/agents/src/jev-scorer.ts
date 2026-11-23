import type { DecisionRequest, DecisionResult } from '@open-foresight/llm';
import { jevScoreQuestions, jevScoreVersion, readJevLevel, type EvidenceItem, type JevLevel, type Kpi } from '@open-foresight/core';
import { jevModel } from './verifier.js';

/** The part of the gateway the Jev scorer uses. `createGateway` from `@open-foresight/llm` satisfies it. */
export type ScoreJudge = { decide(input: DecisionRequest): Promise<Pick<DecisionResult, 'id' | 'answers' | 'usage'>> };

export type JevScore = JevLevel & {
  version: typeof jevScoreVersion;
  /** Jev's answer as returned, kept for the record. Null when there were no passages, so no call was made. */
  answer: { decisionId: string; score: number; probabilities: Record<string, number>; confidence: number; known: number; costUsd: number } | null;
};

/**
 * Scores one judgement KPI for one company with Jev instead of the Analyst model, from the passages the Analyst is offered.
 * Jev answers a Score question over the approved rubric levels and a Noul on the rubric's unknown rule, and `readJevLevel` turns the answer into a level in code.
 * Weights and the theme score stay in code, as they are for the Analyst. It writes nothing, and a failed call throws, so the caller decides what a failure means.
 * No product path calls it. It is for the bake-off against the Analyst until the labelled gates pass.
 */
export async function scoreWithJev(judge: ScoreJudge, input: {
  runId: string; company: string; asOf: string; kpi: Extract<Kpi, { method: 'judgement' }>;
  passages: ReadonlyArray<Pick<EvidenceItem, 'id' | 'chunkId' | 'section' | 'text'>>;
}): Promise<JevScore> {
  if (input.passages.length === 0) return { level: 'unknown', reason: 'no_evidence', weighted: null, confidence: 0, version: jevScoreVersion, answer: null };
  const result = await judge.decide({
    runId: input.runId, role: 'jev-scorer', promptVersion: jevScoreVersion, model: jevModel,
    state: JSON.stringify({ company: input.company, as_of: input.asOf, kpi: input.kpi.name, kpi_definition: input.kpi.definition, passages: Object.fromEntries(input.passages.map(p => [p.id, `${p.section}\n${p.text}`])) }),
    questions: jevScoreQuestions(input.kpi),
    inputEvidenceIds: input.passages.map(p => p.chunkId),
  });
  const level = result.answers.level, known = result.answers.known;
  if (level?.type !== 'score' || known?.type !== 'noul') throw new Error('The decision did not answer both the level and the known question');
  return {
    ...readJevLevel(level.probabilities, known.noul), version: jevScoreVersion,
    answer: { decisionId: result.id, score: level.score, probabilities: level.probabilities, confidence: level.confidence, known: known.noul, costUsd: result.usage.cost },
  };
}
