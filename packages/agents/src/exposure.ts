import { and, eq } from 'drizzle-orm';
import { decideExposure, exposureInstructions, exposureOptions, type ExposureVerdict, type Kpi } from '@open-foresight/core';
import { kpiScores } from '@open-foresight/db';
import { nextAttempt, save, type AnalystContext } from './analyst.js';
import { jevModel, type SpanJudge } from './verifier.js';

export const exposurePromptVersion = 'exposure-choice@v1';
const query = "Business overview: what the company does, its main products, services, segments and customers.";

export type ExposureResult = {
  verdict: ExposureVerdict;
  /** The Jev answer, kept for the audit row. Absent when there were no passages or the call failed. */
  answer?: { choice: string; probabilities: Record<string, number>; confidence: number; decisionId: string };
  evidence: Array<{ id: string; chunkId: string; docKind: string; docId: string; section: string; startOffset: number; endOffset: number; availableOn: string }>;
  failure?: string;
};

/**
 * Asks Jev which of four options describes a company's exposure to the theme, from the stored passages that describe what it does.
 * Code selects the passages, restricted to the security's own issuers and to evidence available by the as-of date, and code decides what the answer means.
 * It never throws on a provider failure, because the check is optional. The verdict is then unknown.
 */
export async function checkExposure(ctx: AnalystContext & { judge: SpanJudge }, theme: string): Promise<ExposureResult> {
  const hits = (await ctx.retriever.search({ snapshotId: ctx.snapshotId, asOf: ctx.asOf, securityId: ctx.security.id, query, limit: 4 }))
    .filter(h => ctx.security.issuerKeys.includes(h.issuerKey) && h.availableOn <= ctx.asOf);
  const evidence = hits.map((h, i) => ({ id: `p${i + 1}`, chunkId: h.chunkId, docKind: h.docKind, docId: h.docId, section: h.section, startOffset: h.startOffset, endOffset: h.endOffset, availableOn: h.availableOn }));
  if (hits.length === 0) return { verdict: 'unknown', evidence };
  try {
    const result = await ctx.judge.decide({
      runId: ctx.runId, role: 'exposure', promptVersion: exposurePromptVersion, model: jevModel,
      state: JSON.stringify({ company: ctx.security.name, as_of: ctx.asOf, passages: Object.fromEntries(hits.map((h, i) => [`p${i + 1}`, `${h.section}\n${h.text}`])) }),
      questions: { exposure: { type: 'choice', instructions: exposureInstructions(theme), criteria: { ...exposureOptions } } },
      inputEvidenceIds: hits.map(h => h.chunkId),
    });
    const a = result.answers.exposure;
    if (!a || a.type !== 'choice') return { verdict: 'unknown', evidence, failure: 'The decision had no choice answer' };
    return { verdict: decideExposure(a), evidence, answer: { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence, decisionId: result.id } };
  } catch (error) {
    return { verdict: 'unknown', evidence, failure: error instanceof Error ? error.message : 'unknown' };
  }
}

/**
 * Settles a gate KPI for a name that is plainly outside the theme. On a confident `none` it saves a valid level 0 score for the gate KPI, so the name fails the gate
 * as a known non-match and not as a name with no evidence, and the Analyst reuses that score without a model call. Every other verdict saves nothing and the Analyst scores the name as usual.
 * Only a judgement gate KPI is settled this way. Returns what happened for the log.
 */
export async function applyExposure(ctx: AnalystContext & { judge: SpanJudge }, gate: Kpi, theme: string): Promise<'skipped' | 'settled' | 'left_to_analyst'> {
  if (gate.method !== 'judgement') return 'skipped';
  const existing = await ctx.db.select({ valid: kpiScores.valid }).from(kpiScores).where(and(eq(kpiScores.runId, ctx.runId), eq(kpiScores.securityId, ctx.security.id), eq(kpiScores.kpiId, gate.id)));
  if (existing.some(r => r.valid)) return 'skipped';
  const r = await checkExposure(ctx, theme);
  if (r.verdict !== 'none' || !r.answer) return 'left_to_analyst';
  const p = r.answer.probabilities.none ?? 0;
  await save(ctx, gate, await nextAttempt(ctx, gate.id), {
    level: '0', valid: true, confidence: String(Math.round(p * 100) / 100), promptVersion: exposurePromptVersion,
    rationale: `The company's business passages describe what it does and none of it is in the theme (Jev exposure check, probability ${p.toFixed(2)} on "none").`,
    evidence: r.evidence, raw: r.answer,
  });
  return 'settled';
}
