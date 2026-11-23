import type { Kpi } from './framework.js';
import type { ResolvedCitation, ScoreLevel } from './score.js';

/** A change code made to a model's level after validation. The stored level is the changed one, and the original is kept here. */
export type ScoreAdjustment = {
  code: 'no_definition_term' | 'jev_unsupported' | 'jev_borderline' | 'jev_unavailable' | 'span_unverified';
  from: ScoreLevel; to: ScoreLevel; message: string;
  /** What the check saw, such as the probability each level got from the span check. */
  detail?: unknown;
};

/** The highest level a judgement KPI may keep when no cited quote names anything the KPI defines. */
export const unsupportedLevelCap: ScoreLevel = '2';

const stop = new Set((
  'about above across after also among and any are because been between both but can company companies could definition does each every for from has have how into its may more most not only other our over such than that the their them then there these they this through those under use used uses what when where which while whether with within would your ' +
  'business central contracted core filings filing mean means name named offering offerings product products programme programmes report reports revenue service services segment segments test tests'
).split(' '));

/** Lower case word stems of at least four letters, without common words, so "storage" and "Storage systems" match. */
export function definitionTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return [...new Set(words.filter(w => !stop.has(w)).map(w => w.replace(/s$/, '').slice(0, 6)))];
}

/**
 * Caps a judgement score at `unsupportedLevelCap` when it claims level 3 or 4 and no cited quote shares a term with the KPI's definition.
 * A level 3 or 4 means the offerings the KPI defines are a segment or the majority of revenue, so a quote must at least name one of them.
 * This is a coarse check by code. It can only lower a level, never raise it, and extraction KPIs are bucketed by code already.
 */
export function capUnsupportedLevel(input: { kpi: Kpi; level: ScoreLevel; citations: readonly Pick<ResolvedCitation, 'quote'>[] }): { level: ScoreLevel; adjustment: ScoreAdjustment | null } {
  const { kpi, level } = input;
  if (kpi.method !== 'judgement' || (level !== '3' && level !== '4')) return { level, adjustment: null };
  const terms = definitionTerms(kpi.definition);
  const quoted = input.citations.map(c => definitionTerms(c.quote));
  if (terms.length === 0 || quoted.some(q => q.some(t => terms.includes(t)))) return { level, adjustment: null };
  return { level: unsupportedLevelCap, adjustment: { code: 'no_definition_term', from: level, to: unsupportedLevelCap, message: `No cited quote names an offering from the KPI definition, so level ${level} was lowered to ${unsupportedLevelCap}.` } };
}
