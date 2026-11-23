import { z } from 'zod';
import { compareOnLabels, type BakeOffReport, type SideRun } from './bakeoff.js';
import { levelSchema, type RubricLevel } from './kappa.js';
import type { LabelledSet } from './labels.js';

export const policyNames = { fallback: 'fallback to Luna', jevOnly: 'treat Jev unknown as unknown', lunaAlone: 'Luna alone' } as const;
export type PolicyId = keyof typeof policyNames;

/**
 * The part of a saved bake-off file the policy report reads. Each pair has the Analyst's own level, before the code checks, and Jev's first pass.
 * A pair Jev failed on has a null first pass.
 */
export const bakeoffFileSchema = z.object({
  pairs: z.array(z.object({
    id: z.string().min(1),
    analyst: z.object({ stored: levelSchema.nullable(), confidence: z.number().nullable() }),
    jev: z.array(z.object({ level: levelSchema, confidence: z.number() }).nullable()).min(1),
  })),
});
export type BakeoffFile = z.infer<typeof bakeoffFileSchema>;

/** One policy's level for one pair. The fallback keeps Luna's level and discounts its confidence by `factor`. A pair Jev failed on has no answer under a policy that needs Jev. */
export function routeLevel(jev: { level: RubricLevel; confidence: number } | null, luna: { level: RubricLevel; confidence: number | null } | null, factor: number): { level: RubricLevel; confidence: number | null } | null {
  if (!jev) return null;
  if (jev.level !== 'unknown' || !luna || luna.level === 'unknown') return jev;
  return { level: luna.level, confidence: luna.confidence === null ? null : luna.confidence * factor };
}

/**
 * Compares the three policies on one labelled set, from a saved bake-off file and so with no model call. Each policy is a side, and the numbers are over the pairs every policy answered.
 * `factor` is the confidence discount of a fallback score. Every number stays provisional, and the release gates stay unsatisfied, because the labels are AI-generated.
 */
export function comparePolicies(set: LabelledSet, file: BakeoffFile, factor: number): BakeOffReport {
  const jev = (p: BakeoffFile['pairs'][number]) => p.jev[0] ?? null;
  const luna = (p: BakeoffFile['pairs'][number]) => (p.analyst.stored ? { level: p.analyst.stored, confidence: p.analyst.confidence } : null);
  const runOf = (pick: (p: BakeoffFile['pairs'][number]) => { level: RubricLevel; confidence: number | null } | null): SideRun =>
    Object.fromEntries(file.pairs.flatMap(p => { const r = pick(p); return r ? [[p.id, r]] : []; }));
  const side = (id: PolicyId, pick: Parameters<typeof runOf>[0]) => ({ name: policyNames[id], model: 'policy', runs: [runOf(pick)] as const, cost: null });
  return compareOnLabels(set, [
    side('fallback', p => routeLevel(jev(p), luna(p), factor)),
    side('jevOnly', p => routeLevel(jev(p), null, factor)),
    side('lunaAlone', luna),
  ]);
}
