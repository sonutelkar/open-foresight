import type { Kpi } from './framework.js';
import type { ScoreAdjustment } from './support.js';
import type { ScoreLevel } from './score.js';

/**
 * Thresholds for the Jev span check, on the probability that a stored span supports a claim. They are provisional until the labelled evaluation sets them.
 * At or above `supported` the claim stands. Below `borderline` it does not. In between the level stays and the doubt is recorded.
 */
export const supportThresholds = { supported: 0.6, borderline: 0.4 } as const;

/** The lowest level the span check steps down to. Level 0 means no exposure, which a failed check does not establish. */
export const verifyFloor: ScoreLevel = '1';

const order: ScoreLevel[] = ['4', '3', '2', '1'];
/** The claimed level and every level below it down to the floor, highest first. Levels 0 and unknown, and extraction KPIs, are not checked. */
export const levelsToCheck = (level: ScoreLevel): ScoreLevel[] => { const i = order.indexOf(level); return i < 0 || i > 1 ? [] : order.slice(i); };

/** The rubric sentence for a level of a judgement KPI. It becomes the claim the span must support. */
export const claimFor = (kpi: Kpi, level: ScoreLevel): string | null => (kpi.method === 'judgement' && level !== 'unknown' ? kpi.rubric.levels[level] : null);

export type SupportProbe = { level: ScoreLevel; /** The highest probability any span got for this level's claim. */ best: number };
export type SupportDecision = { level: ScoreLevel; adjustment: ScoreAdjustment | null };

/**
 * Decides a level from probes of the claimed level and the levels below it. It can only lower a level.
 * Walk from the claimed level: a supported level stands. A borderline claimed level stands with a note. Below it, a weaker claim needs less,
 * so the first level at or above the borderline probability wins, and if none reaches it the level falls to the floor.
 */
export function decideSupport(claimed: ScoreLevel, probes: readonly SupportProbe[]): SupportDecision {
  const detail = probes.map(p => ({ level: p.level, probability: p.best }));
  const first = probes.find(p => p.level === claimed);
  if (!first || levelsToCheck(claimed).length === 0) return { level: claimed, adjustment: null };
  if (first.best >= supportThresholds.supported) return { level: claimed, adjustment: null };
  if (first.best >= supportThresholds.borderline) return { level: claimed, adjustment: { code: 'jev_borderline', from: claimed, to: claimed, message: `The span check was unsure that the cited quotes support level ${claimed} (${first.best.toFixed(2)}). The level stands for review.`, detail } };
  const lower = probes.find(p => p.level !== claimed && order.indexOf(p.level) > order.indexOf(claimed) && p.best >= supportThresholds.borderline);
  const to = lower?.level ?? verifyFloor;
  return { level: to, adjustment: { code: 'jev_unsupported', from: claimed, to, message: `The span check found that the cited quotes do not support level ${claimed} (${first.best.toFixed(2)}), so it was lowered to ${to}.`, detail } };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The stored text around a quote, so a judge sees the sentence in its setting. Null when the quote is not verbatim in the stored text.
 * The window is cut on word boundaries and is at most `radius` characters on each side.
 */
export function spanWindow(storedText: string, quote: string, radius = 600): string | null {
  const text = squash(storedText), q = squash(quote);
  const i = q ? text.indexOf(q) : -1;
  if (i < 0) return null;
  const start = Math.max(0, i - radius), end = Math.min(text.length, i + q.length + radius);
  const from = start === 0 ? 0 : text.indexOf(' ', start) + 1 || start, to = end === text.length ? end : text.lastIndexOf(' ', end) > i + q.length ? text.lastIndexOf(' ', end) : end;
  return text.slice(from, to);
}
