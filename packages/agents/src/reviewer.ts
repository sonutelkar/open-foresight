import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { reviewerInputSchema, reviewFromOutput, reviewOutputSchema, type Framework, type ResolvedCitation, type Review, type ReviewerInput, type ScoreLevel } from '@open-foresight/core';
import { documentChunks, kpiFrameworkVersions, kpiScores, llmCalls, reviews, runs, securities } from '@open-foresight/db';
import { loadPrompt, render } from '@open-foresight/prompts';
import type { StructuredGenerator } from './designer.js';

/** The spec's sampling: every score at level 2 or above or with confidence below 0.6, and a seeded share of the rest. */
export const reviewSampling = { minLevel: 2, maxConfidence: 0.6, share: 0.1 } as const;

/** Whether a score goes to the Reviewer. A pure function of the seed and the score, so a restart makes the same choice. */
export function sampledForReview(seed: string, score: { id: string; level: ScoreLevel; confidence: number }): boolean {
  if (score.level !== 'unknown' && Number(score.level) >= reviewSampling.minLevel) return true;
  if (score.confidence < reviewSampling.maxConfidence) return true;
  return createHash('sha256').update(`${seed}\n${score.id}`).digest().readUInt32BE(0) / 2 ** 32 < reviewSampling.share;
}

const vendorOf = (model: string) => model.slice(0, model.indexOf('/')).toLowerCase();

/**
 * The Reviewer's route out of every configured route, model and decision routes alike.
 * It throws when the Reviewer is missing or shares a vendor with any other route, so no scorer is reviewed by its own vendor.
 */
export function reviewerRoute<T extends { role: string; model: string }>(routes: readonly T[]): T {
  const reviewer = routes.find(r => r.role === 'reviewer');
  if (!reviewer) throw new Error('No reviewer route is configured');
  const vendor = vendorOf(reviewer.model);
  const shared = routes.filter(r => r !== reviewer && vendorOf(r.model) === vendor);
  if (shared.length > 0) throw new Error(`The Reviewer ${reviewer.model} shares the vendor ${vendor} with ${shared.map(r => `${r.role} (${r.model})`).join(', ')}`);
  return reviewer;
}

export type ReviewerContext = { db: PostgresJsDatabase; gateway: StructuredGenerator; runId: string; /** False sends the call to the model even when a cached answer exists. */ cache?: boolean };
export type ReviewOutcome = { reviewId: string; review: Review; llmCallId: string; model: string; provider: string | null };

const rubricText = (input: ReviewerInput) => (['0', '1', '2', '3', '4'] as const).map(l => `${l}: ${input.kpi.rubric.levels[l]}`).join('\n');
const passagesText = (input: ReviewerInput) => input.passages.length === 0
  ? '(none)'
  : input.passages.map(p => `[${p.id}] issuer ${p.issuer} | available ${p.availableOn} | ${p.section}\n${p.text}`).join('\n\n---\n\n');

/**
 * Reviews one score attempt and saves the verdict linked to it, with the model and provider that served the call.
 * The input is parsed strictly here, so nothing beyond the score, the rubric and the cited passages reaches the model.
 * An answer that is still invalid after the gateway's one repair throws and saves no review. Its calls stay in llm_calls.
 */
export async function reviewScore(ctx: ReviewerContext, scoreId: string, raw: ReviewerInput): Promise<ReviewOutcome> {
  const input = reviewerInputSchema.parse(raw);
  const prompt = loadPrompt('reviewer', 'v1');
  const user = render(prompt.user, {
    company: input.score.company, symbol: input.score.symbol, as_of: input.score.asOf, level: input.score.level,
    kpi_name: input.kpi.name, definition: input.kpi.definition, lookback_days: String(input.kpi.lookbackDays),
    rubric: rubricText(input), unknown_rule: input.kpi.rubric.unknown, passages: passagesText(input),
  });
  let auditId = '';
  const output = await ctx.gateway.generate({
    runId: ctx.runId, role: 'reviewer', promptVersion: prompt.promptVersion, system: prompt.system, user, schemaName: 'review', schema: reviewOutputSchema,
    inputEvidenceIds: input.passages.map(p => p.chunkId), cache: ctx.cache, onAudit: id => { auditId = id; },
  });
  const [call] = await ctx.db.select({ model: llmCalls.model, provider: llmCalls.provider }).from(llmCalls).where(eq(llmCalls.id, auditId));
  if (!call) throw new Error('The gateway did not report an audit record for the Reviewer call');
  const review = reviewFromOutput(output);
  const [row] = await ctx.db.insert(reviews).values({
    runId: ctx.runId, scoreId, llmCallId: auditId, promptVersion: prompt.promptVersion, model: call.model, provider: call.provider,
    verdict: review.verdict, issue: review.issue, note: review.note, suggestedLevel: review.suggestedLevel ?? null,
  }).returning({ id: reviews.id });
  if (!row) throw new Error('The review was not saved');
  return { reviewId: row.id, review, llmCallId: auditId, model: call.model, provider: call.provider };
}

/** Builds the Reviewer's input for a stored score attempt from the local store: its level and security, the approved KPI, and the passages it cites. */
export async function loadReviewerInput(db: PostgresJsDatabase, scoreId: string): Promise<{ runId: string; input: ReviewerInput }> {
  const [row] = await db.select({ score: kpiScores, company: securities.name, frameworkVersion: runs.frameworkVersion }).from(kpiScores)
    .innerJoin(securities, eq(securities.id, kpiScores.securityId)).innerJoin(runs, eq(runs.id, kpiScores.runId)).where(eq(kpiScores.id, scoreId));
  if (!row) throw new Error(`No score ${scoreId}`);
  if (!row.frameworkVersion) throw new Error(`The run of score ${scoreId} has no approved framework`);
  const [version] = await db.select({ framework: kpiFrameworkVersions.framework }).from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.id, row.frameworkVersion));
  const kpi = (version?.framework as Framework | undefined)?.kpis.find(k => k.id === row.score.kpiId);
  if (!kpi || kpi.method === 'quant') throw new Error(`Score ${scoreId} is not for a KPI with a rubric`);
  const citations = row.score.citations as ResolvedCitation[];
  const chunks = citations.length === 0 ? [] : await db.select({ id: documentChunks.id, issuerKey: documentChunks.issuerKey, text: documentChunks.text })
    .from(documentChunks).where(inArray(documentChunks.id, citations.map(c => c.chunkId)));
  const passages = [...new Map(citations.map(c => [c.chunkId, c])).values()].map(c => {
    const chunk = chunks.find(x => x.id === c.chunkId);
    if (!chunk) throw new Error(`Cited chunk ${c.chunkId} of score ${scoreId} is not in the store`);
    return { id: c.evidenceId, chunkId: c.chunkId, issuer: chunk.issuerKey, availableOn: c.availableOn, section: c.section, text: chunk.text };
  });
  return {
    runId: row.score.runId,
    input: {
      score: { company: row.company, symbol: row.score.symbol, asOf: row.score.asOf, level: row.score.level as ScoreLevel },
      kpi: { name: kpi.name, definition: kpi.definition, lookbackDays: kpi.lookbackDays, rubric: kpi.rubric },
      passages,
    },
  };
}
