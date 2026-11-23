import { compareBaskets, packageBasket, type BasketCandidate, type BasketKpi, type BasketRules, type CandidateScore } from '@open-foresight/core';
import { routeLevel, type BakeoffFile, type LabelledPair, type PolicyId } from '@open-foresight/evals';

type JevFirstPass = BakeoffFile['pairs'][number]['jev'][number];

/**
 * The candidates as a scoring policy would have scored the labelled pairs. Only a labelled pair changes. Every other KPI keeps the level saved in the store, which is Luna's.
 * `lunaAlone` is the store as it is. A pair Jev failed on keeps its saved level under every policy.
 */
export function applyPolicy(candidates: readonly BasketCandidate[], pairs: readonly LabelledPair[], jev: ReadonlyMap<string, JevFirstPass>, policy: PolicyId, factor: number): BasketCandidate[] {
  if (policy === 'lunaAlone') return [...candidates];
  return candidates.map(c => {
    const scores: Record<string, CandidateScore | undefined> = { ...c.scores };
    for (const p of pairs.filter(x => x.symbol === c.symbol)) {
      const luna = c.scores[p.kpiId], j = jev.get(p.id) ?? null;
      const r = routeLevel(j, policy === 'fallback' && luna ? luna : null, factor);
      if (!r || !j) continue;
      scores[p.kpiId] = r.level === 'unknown' ? { level: 'unknown', confidence: 0 }
        : j.level !== 'unknown' ? { level: r.level, confidence: r.confidence ?? 0, route: 'jev' } : { level: r.level, confidence: r.confidence ?? 0, route: 'luna-fallback' };
    }
    return { ...c, scores };
  });
}

/** The basket under each policy, and how the other two differ from the basket the store gives today. */
export function policyBasketEffects(input: { candidates: readonly BasketCandidate[]; kpis: readonly BasketKpi[]; rules: BasketRules }, pairs: readonly LabelledPair[], jev: ReadonlyMap<string, JevFirstPass>, factor: number) {
  const basket = (policy: PolicyId) => packageBasket({ ...input, candidates: applyPolicy(input.candidates, pairs, jev, policy, factor) });
  const base = basket('lunaAlone');
  return { lunaAlone: compareBaskets(base, base), fallback: compareBaskets(base, basket('fallback')), jevOnly: compareBaskets(base, basket('jevOnly')) } satisfies Record<PolicyId, ReturnType<typeof compareBaskets>>;
}
