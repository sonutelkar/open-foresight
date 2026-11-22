import { z } from 'zod';
import { quantCatalog, quantIds, sourceIds, type QuantId, type SourceId } from './sources.js';

export const levelKeys = ['0', '1', '2', '3', '4'] as const;
export type Level = (typeof levelKeys)[number];
export type Rubric = { levels: Record<Level, string>; unknown: string };
export type SubTheme = { id: string; name: string; description: string };
type Base = { id: string; name: string; definition: string; subThemeId: string; sources: SourceId[]; lookbackDays: number; weightPercent: number; isGate: boolean };
type Thresholds = [number, number, number, number];
/** The number a model extracts for an `extract_then_quant` KPI, and its unit. Thresholds use the same unit. */
export type Extraction = { target: string; unit: 'fraction' | 'usd' | 'count' };
/** A validated KPI. Each scoring method carries exactly the fields it needs, so a half specified KPI cannot exist. */
export type Kpi =
  | (Base & { method: 'quant'; quantQuery: QuantId; thresholds: Thresholds })
  | (Base & { method: 'extract_then_quant'; thresholds: Thresholds; rubric: Rubric; extraction: Extraction })
  | (Base & { method: 'judgement'; rubric: Rubric });
export type Framework = { subThemes: SubTheme[]; kpis: Kpi[]; rationale: string };

export const limits = { subThemes: [2, 5], kpis: [3, 8], lookbackDays: [30, 3650], weightTotal: 100, marketFactorPercent: 20 } as const;
const idPattern = /^[a-z][a-z0-9_]{2,39}$/;

/** What a model returns. Every field is present, with null where a method does not use it. Sources stay free text so a bad one is reported, not rejected. */
const draftRubric = z.object({ level0: z.string(), level1: z.string(), level2: z.string(), level3: z.string(), level4: z.string(), unknownRule: z.string() }).strict();
const draftExtraction = z.object({ target: z.string(), unit: z.enum(['fraction', 'usd', 'count']) }).strict();
const draftKpi = z.object({
  id: z.string(), name: z.string(), definition: z.string(), subThemeId: z.string(),
  method: z.enum(['quant', 'extract_then_quant', 'judgement']),
  sources: z.array(z.string()), rubric: draftRubric.nullable(), thresholds: z.array(z.number()).nullable(), extraction: draftExtraction.nullable(), quantQuery: z.string().nullable(),
  lookbackDays: z.number().int(), weightPercent: z.number().int(), isGate: z.boolean(),
}).strict();
export const frameworkDraftSchema = z.object({
  subThemes: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).strict()),
  kpis: z.array(draftKpi), rationale: z.string(),
}).strict();
export type FrameworkDraft = z.infer<typeof frameworkDraftSchema>;

/** Quant functions whose sources are all enabled. */
export function availableQuantIds(availableSources: readonly SourceId[]): QuantId[] {
  return quantIds.filter(id => quantCatalog[id].sources.every(s => availableSources.includes(s)));
}

/** The same draft shape, but sources and quant functions are limited to the enabled values, so a provider enforces them. */
export function constrainedDraftSchema(availableSources: readonly SourceId[]) {
  const sources = z.enum(availableSources as [SourceId, ...SourceId[]]);
  const quant = z.enum(availableQuantIds(availableSources) as [QuantId, ...QuantId[]]);
  return frameworkDraftSchema.extend({ kpis: z.array(draftKpi.extend({ sources: z.array(sources), quantQuery: quant.nullable() })) });
}

export type FrameworkErrorCode =
  | 'shape' | 'sub_theme_count' | 'kpi_count' | 'duplicate_id' | 'bad_id' | 'unknown_sub_theme' | 'empty_sub_theme'
  | 'no_sources' | 'unknown_source' | 'unavailable_source' | 'missing_quant_source' | 'lookback'
  | 'weight' | 'weight_total' | 'factor_weight' | 'gate_count' | 'incomplete_rubric' | 'unexpected_rubric'
  | 'bad_thresholds' | 'unexpected_thresholds' | 'threshold_unit' | 'missing_extraction' | 'unexpected_extraction'
  | 'unknown_quant_query' | 'unexpected_quant_query' | 'text_too_short';
export type FrameworkError = { code: FrameworkErrorCode; path: string; message: string };
export type FrameworkResult = { ok: true; framework: Framework } | { ok: false; errors: FrameworkError[] };

const shortText = (value: string, min: number) => value.trim().length < min;

/**
 * Checks a drafted framework against the rules and returns every violation, so one repair request can name them all.
 * `availableSources` is what is enabled for the run. A configured source that is not enabled is reported as unavailable.
 */
export function validateFramework(input: unknown, context: { availableSources: readonly SourceId[] }): FrameworkResult {
  const parsed = frameworkDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(i => ({ code: 'shape' as const, path: i.path.join('.') || '(root)', message: i.message })) };
  const draft = parsed.data;
  const errors: FrameworkError[] = [];
  const fail = (code: FrameworkErrorCode, path: string, message: string) => errors.push({ code, path, message });
  const [minSub, maxSub] = limits.subThemes, [minKpi, maxKpi] = limits.kpis, [minLook, maxLook] = limits.lookbackDays;
  if (draft.subThemes.length < minSub || draft.subThemes.length > maxSub) fail('sub_theme_count', 'subThemes', `Need ${minSub} to ${maxSub} sub-themes, got ${draft.subThemes.length}.`);
  if (draft.kpis.length < minKpi || draft.kpis.length > maxKpi) fail('kpi_count', 'kpis', `Need ${minKpi} to ${maxKpi} KPIs, got ${draft.kpis.length}.`);
  const subIds = new Set<string>();
  draft.subThemes.forEach((s, i) => {
    if (!idPattern.test(s.id)) fail('bad_id', `subThemes.${i}.id`, `Sub-theme id "${s.id}" must be snake_case, 3 to 40 characters.`);
    if (subIds.has(s.id)) fail('duplicate_id', `subThemes.${i}.id`, `Duplicate sub-theme id "${s.id}".`);
    subIds.add(s.id);
    if (shortText(s.name, 3) || shortText(s.description, 20)) fail('text_too_short', `subThemes.${i}`, 'Sub-theme needs a name and a description of at least 20 characters.');
  });
  const kpiIds = new Set<string>();
  const used = new Set<string>();
  let gates = 0, total = 0, marketWeight = 0;
  const available = new Set<string>(context.availableSources);
  const valid: Kpi[] = [];
  draft.kpis.forEach((k, i) => {
    const at = `kpis.${i}`;
    const before = errors.length;
    if (!idPattern.test(k.id)) fail('bad_id', `${at}.id`, `KPI id "${k.id}" must be snake_case, 3 to 40 characters.`);
    if (kpiIds.has(k.id)) fail('duplicate_id', `${at}.id`, `Duplicate KPI id "${k.id}".`);
    kpiIds.add(k.id);
    if (shortText(k.name, 3) || shortText(k.definition, 20)) fail('text_too_short', at, `KPI "${k.id}" needs a name and a definition of at least 20 characters.`);
    if (!subIds.has(k.subThemeId)) fail('unknown_sub_theme', `${at}.subThemeId`, `KPI "${k.id}" names sub-theme "${k.subThemeId}", which does not exist.`);
    used.add(k.subThemeId);
    if (k.sources.length === 0) fail('no_sources', `${at}.sources`, `KPI "${k.id}" names no sources.`);
    for (const s of k.sources) {
      if (!(sourceIds as string[]).includes(s)) fail('unknown_source', `${at}.sources`, `KPI "${k.id}" names unknown source "${s}". Known sources: ${sourceIds.join(', ')}.`);
      else if (!available.has(s)) fail('unavailable_source', `${at}.sources`, `KPI "${k.id}" names source "${s}", which is not enabled for this run. Enabled: ${[...available].join(', ')}.`);
    }
    if (k.lookbackDays < minLook || k.lookbackDays > maxLook) fail('lookback', `${at}.lookbackDays`, `KPI "${k.id}" lookback must be ${minLook} to ${maxLook} days.`);
    if (k.weightPercent < 0 || k.weightPercent > 100) fail('weight', `${at}.weightPercent`, `KPI "${k.id}" weight must be a whole percent from 0 to 100.`);
    total += k.weightPercent;
    if (k.method === 'quant' && k.quantQuery && (quantIds as string[]).includes(k.quantQuery) && quantCatalog[k.quantQuery as QuantId].group === 'market') marketWeight += k.weightPercent;
    if (k.isGate) gates++;
    const ascending = k.thresholds?.length === 4 && k.thresholds.every((t, j, a) => Number.isFinite(t) && (j === 0 || t > a[j - 1]!));
    const rubric = k.rubric;
    const rubricComplete = !!rubric && [rubric.level0, rubric.level1, rubric.level2, rubric.level3, rubric.level4, rubric.unknownRule].every(t => !shortText(t, 10));
    if (k.method === 'quant') {
      if (!k.quantQuery || !(quantIds as string[]).includes(k.quantQuery)) fail('unknown_quant_query', `${at}.quantQuery`, `Quant KPI "${k.id}" must name a registered quant function: ${quantIds.join(', ')}.`);
      else for (const needed of quantCatalog[k.quantQuery as QuantId].sources) if (!k.sources.includes(needed)) fail('missing_quant_source', `${at}.sources`, `Quant function "${k.quantQuery}" reads source "${needed}", so KPI "${k.id}" must list it.`);
      if (!ascending) fail('bad_thresholds', `${at}.thresholds`, `Quant KPI "${k.id}" needs exactly 4 strictly increasing thresholds that map its value to levels 0 to 4.`);
      if (k.rubric) fail('unexpected_rubric', `${at}.rubric`, `Quant KPI "${k.id}" must not have a rubric. Use null.`);
      if (k.extraction) fail('unexpected_extraction', `${at}.extraction`, `Quant KPI "${k.id}" must not have an extraction. Use null.`);
    } else {
      if (!rubricComplete) fail('incomplete_rubric', `${at}.rubric`, `KPI "${k.id}" needs an anchored rubric with levels 0 to 4 and an unknown rule, each at least 10 characters.`);
      if (k.quantQuery) fail('unexpected_quant_query', `${at}.quantQuery`, `Non-quant KPI "${k.id}" must not name a quant function. Use null.`);
      if (k.method === 'extract_then_quant' && !ascending) fail('bad_thresholds', `${at}.thresholds`, `KPI "${k.id}" extracts a number, so it needs exactly 4 strictly increasing thresholds.`);
      if (k.method === 'judgement' && k.thresholds) fail('unexpected_thresholds', `${at}.thresholds`, `Judgement KPI "${k.id}" must not have thresholds. Use null.`);
      if (k.method === 'judgement' && k.extraction) fail('unexpected_extraction', `${at}.extraction`, `Judgement KPI "${k.id}" must not have an extraction. Use null.`);
      if (k.method === 'extract_then_quant') {
        if (!k.extraction || shortText(k.extraction.target, 15)) fail('missing_extraction', `${at}.extraction`, `KPI "${k.id}" extracts a number, so it needs an extraction with a target of at least 15 characters and a unit (fraction, usd or count).`);
        else if (ascending && k.thresholds) {
          const unit = k.extraction.unit;
          if (unit === 'fraction' && k.thresholds.some(t => t < 0 || t > 1)) fail('threshold_unit', `${at}.thresholds`, `KPI "${k.id}" has unit fraction, so thresholds must be between 0 and 1. Write 30 percent as 0.3.`);
          if (unit !== 'fraction' && k.thresholds.some(t => t < 0)) fail('threshold_unit', `${at}.thresholds`, `KPI "${k.id}" has unit ${unit}, so thresholds must not be negative.`);
        }
      }
    }
    if (errors.length === before) {
      const base: Base = { id: k.id, name: k.name.trim(), definition: k.definition.trim(), subThemeId: k.subThemeId, sources: k.sources as SourceId[], lookbackDays: k.lookbackDays, weightPercent: k.weightPercent, isGate: k.isGate };
      const thresholds = k.thresholds as Thresholds | null;
      const toRubric = (r: NonNullable<typeof rubric>): Rubric => ({ levels: { '0': r.level0.trim(), '1': r.level1.trim(), '2': r.level2.trim(), '3': r.level3.trim(), '4': r.level4.trim() }, unknown: r.unknownRule.trim() });
      if (k.method === 'quant' && thresholds && k.quantQuery) valid.push({ ...base, method: 'quant', quantQuery: k.quantQuery as QuantId, thresholds });
      else if (k.method === 'extract_then_quant' && thresholds && rubric && k.extraction) valid.push({ ...base, method: 'extract_then_quant', thresholds, rubric: toRubric(rubric), extraction: { target: k.extraction.target.trim(), unit: k.extraction.unit } });
      else if (k.method === 'judgement' && rubric) valid.push({ ...base, method: 'judgement', rubric: toRubric(rubric) });
    }
  });
  for (const s of draft.subThemes) if (!used.has(s.id) && subIds.has(s.id)) fail('empty_sub_theme', 'subThemes', `Sub-theme "${s.id}" has no KPI.`);
  if (total !== limits.weightTotal) fail('weight_total', 'kpis', `Weights must sum to ${limits.weightTotal} percent, got ${total}.`);
  if (marketWeight > limits.marketFactorPercent) fail('factor_weight', 'kpis', `KPIs built on market factors (size, liquidity, momentum) may carry at most ${limits.marketFactorPercent} percent of the weight, got ${marketWeight}. They describe a stock, not its exposure to the theme. Move the weight to exposure KPIs.`);
  if (gates > 1) fail('gate_count', 'kpis', `At most one KPI may be a gate, got ${gates}.`);
  if (errors.length > 0 || valid.length !== draft.kpis.length) return { ok: false, errors };
  return { ok: true, framework: { subThemes: draft.subThemes.map(s => ({ ...s, name: s.name.trim(), description: s.description.trim() })), kpis: valid, rationale: draft.rationale.trim() } };
}

/** Maps a measured value to a level 0 to 4. The level is how many thresholds the value has reached. */
export function bucketLevel(value: number, thresholds: readonly [number, number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value)) throw new Error('Cannot bucket a non finite value');
  return thresholds.filter(t => value >= t).length as 0 | 1 | 2 | 3 | 4;
}
