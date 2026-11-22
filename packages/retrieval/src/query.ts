const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'what', 'which', 'who', 'whom', 'how', 'does', 'did', 'has', 'have', 'had', 'its', 'their', 'there', 'about', 'into', 'than', 'then', 'them', 'they', 'you', 'your', 'our', 'any', 'all', 'can', 'will', 'not', 'but', 'also', 'such', 'these', 'those', 'over', 'under']);

/**
 * Turns a question into an OR query for Postgres full-text search with the `simple` configuration.
 * Terms are lowercased letters and digits, so no input can inject query syntax.
 * Returns undefined when nothing searchable is left.
 */
export function orTsQuery(query: string, maxTerms = 24): string | undefined {
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length >= 3 && !stop.has(t)))].slice(0, maxTerms);
  return terms.length ? terms.map(t => `'${t}'`).join(' | ') : undefined;
}
