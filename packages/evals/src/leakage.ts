/**
 * Probes for facts in a rationale that no cited evidence holds. A hit is a signal that the model used memory, not proof: a number can be a
 * sum or a rounding of numbers in the evidence, and an entity can be a fair paraphrase. Treat a flag as a reason to look.
 */
export type LeakageFinding = { unsupportedNumbers: string[]; unsupportedEntities: string[]; flagged: boolean };

/** Words that start a sentence or name a rubric term and are not entities. */
const notEntities = new Set(['the', 'this', 'that', 'these', 'those', 'however', 'because', 'while', 'although', 'evidence', 'level', 'company', 'score', 'rubric', 'unknown', 'kpi', 'there', 'its', 'it', 'and', 'but', 'for', 'with', 'based', 'given', 'since', 'overall']);

const normalizeNumber = (s: string) => s.replace(/,/g, '').replace(/\.0+(?=%|$)/, '');
const numberPattern = /\d[\d,]*(?:\.\d+)?%?/g;
const entityPattern = /\b[A-Z][A-Za-z&.-]{2,}(?:\s+[A-Z][A-Za-z&.-]{2,})*\b/g;

/** Numbers in `text`, normalised: no thousands commas, no trailing zero decimals. */
export const numbersIn = (text: string): string[] => (text.match(numberPattern) ?? []).map(normalizeNumber);

/** Capitalised words and runs of them, lower-cased, minus sentence starters and rubric terms. A run is kept whole and also as its single words. */
export function entitiesIn(text: string): string[] {
  const out = new Set<string>();
  for (const run of text.match(entityPattern) ?? []) {
    const words = run.split(/\s+/).filter(w => !notEntities.has(w.toLowerCase()));
    if (words.length) out.add(words.join(' ').toLowerCase());
  }
  return [...out];
}

/** Numbers and entities in the rationale that appear in none of the cited evidence passages. An entity counts as supported when the evidence holds it, or each of its words. */
export function leakageProbe(input: { rationale: string; evidence: readonly string[] }): LeakageFinding {
  const haystack = input.evidence.join('\n').toLowerCase();
  const evidenceNumbers = new Set(numbersIn(input.evidence.join('\n')));
  const unsupportedNumbers = [...new Set(numbersIn(input.rationale))].filter(n => !evidenceNumbers.has(n));
  const unsupportedEntities = entitiesIn(input.rationale).filter(e => !haystack.includes(e) && !e.split(' ').every(w => haystack.includes(w)));
  return { unsupportedNumbers, unsupportedEntities, flagged: unsupportedNumbers.length + unsupportedEntities.length > 0 };
}

/** Names or tickers still present in text that was meant to be masked. Matches whole words, ignoring case. */
export function maskLeaks(maskedText: string, names: readonly string[]): string[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return names.filter(n => n.trim() && new RegExp(`(?<![A-Za-z0-9])${escape(n.trim())}(?![A-Za-z0-9])`, 'i').test(maskedText));
}
