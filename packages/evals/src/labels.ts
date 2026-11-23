import { z } from 'zod';
import { levelSchema, weightedKappa, type KappaResult } from './kappa.js';

/** Printed with every number from an AI labelled set. The operator decided on 2026-11-23 that such numbers never count as the release gate. */
export const provisionalLabel = 'provisional, AI labelled, not the full release gate';

const uuid = z.string().uuid();

/** What the labeller model returns for one pair. Strict, as structured output needs. */
export const labelOutputSchema = z.object({ level: levelSchema, rationale: z.string() }).strict();

/** One stock by KPI pair: the Analyst's stored level and an independent label for the same passages. `id` is the Analyst's score id. */
export const labelledPairSchema = z.object({
  id: uuid, runId: uuid, symbol: z.string().min(1), kpiId: z.string().min(1),
  /** Only judgement levels are labelled. An extract_then_quant level is set by code from a number, so a level label would not be independent. */
  method: z.literal('judgement'),
  analystLevel: levelSchema, labelLevel: levelSchema, labelRationale: z.string(),
  /** The passages both sides saw, in the order they were shown. */
  chunkIds: z.array(z.string().min(1)).min(1),
}).strict();
export type LabelledPair = z.infer<typeof labelledPairSchema>;

/** A labelled set made by an AI labeller. It is provisional by construction: `source` is `ai` and `provisional` is true, and nothing else parses. */
export const labelledSetSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal('ai'),
  provisional: z.literal(true),
  labeller: z.object({ model: z.string().min(1), provider: z.string().min(1), promptVersion: z.string().min(1) }).strict(),
  analyst: z.object({ model: z.string().min(1) }).strict(),
  runIds: z.array(uuid).min(1),
  createdAt: z.string().datetime(),
  /** What was asked for and what existed. When `pool` is below `requested`, every pool pair is labelled and N is the pool. */
  sample: z.object({ requested: z.number().int().positive(), pool: z.number().int().nonnegative(), seed: z.number().int() }).strict(),
  /** States N, how the pairs were chosen, and that the set is provisional, in words a reader of the file sees first. */
  note: z.string().min(1),
  pairs: z.array(labelledPairSchema),
}).strict().superRefine((doc, ctx) => {
  const seen = new Set<string>();
  for (const p of doc.pairs) {
    if (seen.has(p.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pairs'], message: `Duplicate pair ${p.id}` });
    seen.add(p.id);
  }
});
export type LabelledSet = z.infer<typeof labelledSetSchema>;

/** Agreement of the Analyst (side A) with the labeller (side B), with the provisional label that must travel with it. */
export function summarizeLabelled(doc: LabelledSet): KappaResult & { label: typeof provisionalLabel } {
  return { ...weightedKappa(doc.pairs.map(p => [p.analystLevel, p.labelLevel] as const)), label: provisionalLabel };
}
