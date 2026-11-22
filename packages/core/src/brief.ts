import { z } from 'zod';

export const regionOptions = ['US', 'EU', 'UK', 'CH'] as const;
export const exposureStyles = ['strict', 'broad'] as const;
export const weightings = ['equal', 'score', 'score_sqrt_cap'] as const;
export const reviewLevels = ['kpis_and_flags', 'every_stage'] as const;
export const modelProfiles = ['quality'] as const;
export const briefLimits = { minWords: 20, maxChars: 4000, basketSize: [5, 200], keywords: 30, seedNames: 100, exclusions: 50 } as const;

const list = (max: number) => z.array(z.string()).max(max).default([]).transform(items => [...new Set(items.map(i => i.trim()).filter(Boolean))]);

/** The inputs of a theme run, as the brief form collects them. */
export const briefSchema = z.object({
  brief: z.string().trim().max(briefLimits.maxChars),
  keywords: list(briefLimits.keywords), seedNames: list(briefLimits.seedNames), exclusions: list(briefLimits.exclusions),
  regions: z.array(z.enum(regionOptions)).min(1),
  minMarketCapUsd: z.number().finite().positive(), minAdvUsd: z.number().finite().positive(),
  asOf: z.string().date(),
  exposureStyle: z.enum(exposureStyles),
  basketSize: z.number().int().min(briefLimits.basketSize[0]).max(briefLimits.basketSize[1]),
  weightCapPercent: z.number().finite().gt(0).max(100),
  weighting: z.enum(weightings), reviewLevel: z.enum(reviewLevels), modelProfile: z.enum(modelProfiles),
}).strict();
export type Brief = z.output<typeof briefSchema>;

export type BriefErrorCode = 'shape' | 'brief_too_short' | 'future_date' | 'infeasible_cap';
export type BriefError = { field: string; code: BriefErrorCode; message: string };
export type BriefResult = { ok: true; brief: Brief } | { ok: false; errors: BriefError[] };

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const isCalendarDate = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

/**
 * Checks a brief. `today` is the current date, so the as-of date can be checked without reading a clock.
 * An as-of date may be today or earlier. The weight cap times the basket size must reach 100 percent, or no basket can be filled.
 */
export function validateBrief(input: unknown, context: { today: string }): BriefResult {
  const parsed = briefSchema.safeParse(input);
  const errors: BriefError[] = [];
  if (!parsed.success) for (const i of parsed.error.issues) errors.push({ field: i.path.join('.') || '(root)', code: 'shape', message: i.message });
  const value = parsed.success ? parsed.data : undefined;
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const text = value?.brief ?? (typeof raw.brief === 'string' ? raw.brief : '');
  if (words(text) < briefLimits.minWords) errors.push({ field: 'brief', code: 'brief_too_short', message: `The brief needs at least ${briefLimits.minWords} words, and has ${words(text)}.` });
  const asOf = value?.asOf ?? (typeof raw.asOf === 'string' ? raw.asOf : undefined);
  if (asOf && isCalendarDate(asOf) && asOf > context.today) errors.push({ field: 'asOf', code: 'future_date', message: `The as-of date ${asOf} is after today, ${context.today}.` });
  if (value && value.basketSize * value.weightCapPercent < 100) errors.push({ field: 'weightCapPercent', code: 'infeasible_cap', message: `${value.basketSize} names at a ${value.weightCapPercent} percent cap can hold at most ${Math.round(value.basketSize * value.weightCapPercent * 100) / 100} percent. Raise the cap or the basket size.` });
  const seen = new Set<string>();
  const unique = errors.filter(e => { const k = `${e.field}:${e.code}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return unique.length || !value ? { ok: false, errors: unique } : { ok: true, brief: value };
}
