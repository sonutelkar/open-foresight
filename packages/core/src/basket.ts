import type { ScoreLevel } from './score.js';

/** How a KPI the Analyst could not score counts. Strict treats it as level 0. Lenient drops it and renormalises the remaining weights. */
export type UnknownMode = 'strict' | 'lenient';
export type WeightingId = 'score' | 'equal' | 'score_sqrt_cap';

/** A pure play basket penalises missing evidence. A broad basket does not punish a company for what its filings do not disclose. */
export const unknownModeFor = (exposureStyle: string): UnknownMode => (exposureStyle === 'strict' ? 'strict' : 'lenient');

export type BasketKpi = { id: string; /** Share of the theme score, 0 to 1. */ weight: number; isGate: boolean };
export type CandidateScore = { level: ScoreLevel; confidence: number };
export type BasketCandidate = {
  securityId: string; symbol: string; name: string; marketCapUsd: number; advUsd: number;
  /** One entry per KPI id. A KPI with no entry, or an invalid score, counts as unknown. */
  scores: Readonly<Record<string, CandidateScore | undefined>>;
};
export type BasketRules = { size: number; weightCapPercent: number; weighting: WeightingId; unknownMode: UnknownMode };

export type ExclusionReason = 'gate_failed' | 'gate_unknown' | 'zero_score' | 'below_cutoff';
export type Contribution = { kpiId: string; level: ScoreLevel; /** The weight used after any renormalising, 0 to 1. */ weight: number; /** weight times level over 4. The contributions plus `capAdjustment` sum to the score. */ contribution: number };
export type BasketMember = {
  securityId: string; symbol: string; name: string; rank: number; score: number; confidence: number; weightPercent: number; atCap: boolean;
  contributions: Contribution[];
  /** The share of the approved KPI weight that was unknown for this name, 0 to 1. */
  unknownWeight: number;
  /** Negative when the lenient unknown cap lowered the score. Zero otherwise. */
  capAdjustment: number;
};
export type Basket = {
  /** Phase 1 has no Reviewer or final approval, so every basket is provisional. */
  status: 'provisional';
  unknownMode: UnknownMode;
  members: BasketMember[];
  excluded: Array<{ securityId: string; symbol: string; reason: ExclusionReason; score: number | null }>;
  funnel: { candidates: number; gateFailed: number; gateUnknown: number; zeroScore: number; eligible: number; selected: number; belowCutoff: number };
  cap: { requestedPercent: number; usedPercent: number; relaxed: boolean };
};

export const lenientUnknownCap = 0.8;
const EPS = 1e-9;

type Scored = { c: BasketCandidate; score: number; confidence: number; contributions: Contribution[]; unknownWeight: number; capAdjustment: number; gate: 'pass' | 'fail' | 'unknown' };

const levelNumber = (level: ScoreLevel | undefined) => (level === undefined || level === 'unknown' ? null : Number(level));

function scoreOne(c: BasketCandidate, kpis: readonly BasketKpi[], mode: UnknownMode): Scored {
  const total = kpis.reduce((s, k) => s + k.weight, 0) || 1;
  const known = kpis.filter(k => levelNumber(c.scores[k.id]?.level) !== null);
  const knownWeight = known.reduce((s, k) => s + k.weight, 0);
  const unknownWeight = Math.max(0, (total - knownWeight) / total);
  const scale = mode === 'lenient' ? (knownWeight > 0 ? total / knownWeight : 0) : 1;
  const contributions: Contribution[] = kpis.map(k => {
    const level = c.scores[k.id]?.level ?? 'unknown';
    const n = levelNumber(level);
    const weight = mode === 'lenient' ? (n === null ? 0 : (k.weight / total) * scale) : k.weight / total;
    return { kpiId: k.id, level, weight, contribution: n === null ? 0 : (weight * n) / 4 };
  });
  const raw = contributions.reduce((s, x) => s + x.contribution, 0);
  const score = mode === 'lenient' && unknownWeight > 0.5 + EPS ? Math.min(raw, lenientUnknownCap) : raw;
  const confidence = kpis.reduce((s, k) => s + (k.weight / total) * (c.scores[k.id]?.confidence ?? 0), 0);
  const gateKpi = kpis.find(k => k.isGate);
  const gateLevel = gateKpi ? levelNumber(c.scores[gateKpi.id]?.level) : 1;
  const gate = gateLevel === null ? 'unknown' : gateLevel > 0 ? 'pass' : 'fail';
  return { c, score, confidence, contributions, unknownWeight, capAdjustment: score - raw, gate };
}

/** Higher score first. Ties go to higher confidence, then higher liquidity, then symbol, so the order never depends on input order. */
const byRank = (a: Scored, b: Scored) => b.score - a.score || b.confidence - a.confidence || b.c.advUsd - a.c.advUsd || (a.c.symbol < b.c.symbol ? -1 : a.c.symbol > b.c.symbol ? 1 : 0);

/**
 * Weights that sum to 100 with no name above the cap. Capped names are fixed at the cap and the rest share what is left in proportion
 * to their raw weight, repeated until nobody exceeds it. The caller guarantees `capPercent * raw.length >= 100`.
 */
export function capWeights(raw: readonly number[], capPercent: number): { weights: number[]; capped: boolean[] } {
  const n = raw.length;
  const weights = new Array<number>(n).fill(0);
  const capped = new Array<boolean>(n).fill(false);
  let remaining = 100;
  for (let pass = 0; pass <= n; pass++) {
    const freeSum = raw.reduce((s, r, i) => s + (capped[i] ? 0 : r), 0);
    let hit = false;
    for (let i = 0; i < n; i++) {
      if (capped[i]) continue;
      weights[i] = freeSum > 0 ? (remaining * raw[i]!) / freeSum : remaining / (n - capped.filter(Boolean).length);
      if (weights[i]! > capPercent + EPS) { capped[i] = true; hit = true; }
    }
    if (!hit) break;
    remaining = 100;
    for (let i = 0; i < n; i++) if (capped[i]) { weights[i] = capPercent; remaining -= capPercent; }
  }
  for (let i = 0; i < n; i++) if (capped[i]) weights[i] = capPercent;
  return { weights, capped };
}

/** Rounds to four decimals and puts the rounding residue on the name with the most room under the cap, so the total stays exactly 100. */
function roundWeights(weights: number[], capPercent: number): number[] {
  const rounded = weights.map(w => Math.round(w * 1e4) / 1e4);
  const residue = Math.round((100 - rounded.reduce((s, w) => s + w, 0)) * 1e4) / 1e4;
  if (residue !== 0 && rounded.length) {
    let best = 0;
    for (let i = 1; i < rounded.length; i++) if (capPercent - rounded[i]! > capPercent - rounded[best]!) best = i;
    rounded[best] = Math.round((rounded[best]! + residue) * 1e4) / 1e4;
  }
  return rounded;
}

/**
 * Turns scored candidates into a provisional basket. It is pure and deterministic.
 * Order: drop names that fail the gate KPI or score zero, rank, take the top N, weight, then cap.
 * An unknown gate KPI fails the gate in both modes, because unknown is not above zero.
 * When fewer names qualify than the cap needs to reach 100 percent, the cap is relaxed to the smallest feasible value, 100 over the name count, and the result says so.
 */
export function packageBasket(input: { candidates: readonly BasketCandidate[]; kpis: readonly BasketKpi[]; rules: BasketRules }): Basket {
  const { kpis, rules } = input;
  const scored = input.candidates.map(c => scoreOne(c, kpis, rules.unknownMode));
  const excluded: Basket['excluded'] = [];
  const eligible: Scored[] = [];
  for (const s of scored) {
    if (s.gate === 'fail') excluded.push({ securityId: s.c.securityId, symbol: s.c.symbol, reason: 'gate_failed', score: s.score });
    else if (s.gate === 'unknown') excluded.push({ securityId: s.c.securityId, symbol: s.c.symbol, reason: 'gate_unknown', score: s.score });
    else if (s.score <= EPS) excluded.push({ securityId: s.c.securityId, symbol: s.c.symbol, reason: 'zero_score', score: s.score });
    else eligible.push(s);
  }
  eligible.sort(byRank);
  const picked = eligible.slice(0, Math.max(0, rules.size));
  for (const s of eligible.slice(picked.length)) excluded.push({ securityId: s.c.securityId, symbol: s.c.symbol, reason: 'below_cutoff', score: s.score });

  const requested = rules.weightCapPercent;
  const used = picked.length > 0 && requested * picked.length < 100 - EPS ? Math.round((100 / picked.length) * 1e6) / 1e6 : requested;
  const rawWeight = (s: Scored) => rules.weighting === 'equal' ? 1 : rules.weighting === 'score' ? s.score : s.score * Math.sqrt(Math.max(0, s.c.marketCapUsd));
  const { weights } = capWeights(picked.map(rawWeight), used);
  const final = roundWeights(weights, used);
  const members: BasketMember[] = picked.map((s, i) => ({
    securityId: s.c.securityId, symbol: s.c.symbol, name: s.c.name, rank: i + 1, score: s.score, confidence: s.confidence, weightPercent: final[i]!, atCap: final[i]! >= used - 1e-4,
    contributions: s.contributions, unknownWeight: s.unknownWeight, capAdjustment: s.capAdjustment,
  }));
  const count = (r: ExclusionReason) => excluded.filter(e => e.reason === r).length;
  return {
    status: 'provisional', unknownMode: rules.unknownMode, members, excluded,
    funnel: { candidates: input.candidates.length, gateFailed: count('gate_failed'), gateUnknown: count('gate_unknown'), zeroScore: count('zero_score'), eligible: eligible.length, selected: picked.length, belowCutoff: count('below_cutoff') },
    cap: { requestedPercent: requested, usedPercent: used, relaxed: used !== requested },
  };
}
