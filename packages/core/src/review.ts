import { z } from 'zod';

const scoreLevel = z.enum(['0', '1', '2', '3', '4', 'unknown']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string().trim().min(1);

export const reviewVerdicts = ['accept', 'retry', 'escalate'] as const;
export const reviewIssues = ['none', 'unsupported_level', 'wrong_entity', 'stale_evidence', 'talk_not_numbers', 'conflict', 'other'] as const;

/** The spec's Reviewer verdict. */
export const reviewSchema = z.object({
  verdict: z.enum(reviewVerdicts),
  issue: z.enum(reviewIssues),
  note: z.string().max(400),
  suggestedLevel: scoreLevel.optional(),
}).strict();
export type Review = z.infer<typeof reviewSchema>;

/** What the Reviewer model returns. Strict structured output needs every field present, so `suggestedLevel` is null where the spec leaves it out. */
export const reviewOutputSchema = reviewSchema.extend({ suggestedLevel: scoreLevel.nullable() });

export function reviewFromOutput(output: z.infer<typeof reviewOutputSchema>): Review {
  const { suggestedLevel, ...rest } = output;
  return suggestedLevel === null ? rest : { ...rest, suggestedLevel };
}

/**
 * Everything the Reviewer sees: the score's level and subject, the KPI with its rubric, and the passages the score cites.
 * Strict at every level, so the Analyst's rationale, conflicts or raw output cannot reach the Reviewer.
 */
export const reviewerInputSchema = z.object({
  score: z.object({ company: text, symbol: text, asOf: isoDate, level: scoreLevel }).strict(),
  kpi: z.object({
    name: text, definition: text, lookbackDays: z.number().int().positive(),
    rubric: z.object({ levels: z.object({ 0: text, 1: text, 2: text, 3: text, 4: text }).strict(), unknown: text }).strict(),
  }).strict(),
  passages: z.array(z.object({ id: text, chunkId: text, issuer: text, availableOn: isoDate, section: z.string(), text }).strict()).max(10),
}).strict();
export type ReviewerInput = z.infer<typeof reviewerInputSchema>;
