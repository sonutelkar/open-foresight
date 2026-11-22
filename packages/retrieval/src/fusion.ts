export type Fused = { id: string; score: number; /** One-based rank in each input list, or null when absent. */ ranks: Array<number | null> };

/**
 * Reciprocal rank fusion. A document scores the sum of 1 / (k + rank) over the lists it appears in.
 * Ties break by id, so the result is deterministic.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): Fused[] {
  if (!(k > 0)) throw new Error('k must be positive');
  const scores = new Map<string, { score: number; ranks: Array<number | null> }>();
  lists.forEach((list, listIndex) => {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      const entry = scores.get(id) ?? { score: 0, ranks: lists.map(() => null) };
      entry.score += 1 / (k + i + 1);
      entry.ranks[listIndex] = i + 1;
      scores.set(id, entry);
    });
  });
  return [...scores].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
