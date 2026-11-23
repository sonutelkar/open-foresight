import { z } from 'zod';

const nonEmpty = z.string().min(1);
const day = z.string().date();
const ratio = z.number().finite().min(0).max(1);

/**
 * One stored score and its citations. `offered` is the labelled evidence the model was given, and `allowedIssuerKeys`
 * are the issuers whose filings count as evidence for the security. Extra keys, such as the rest of a stored evidence row, are dropped.
 */
export const citationCaseSchema = z.object({
  scoreId: nonEmpty, symbol: nonEmpty, kpiId: nonEmpty, method: nonEmpty, asOf: day,
  allowedIssuerKeys: z.array(nonEmpty),
  offered: z.array(z.object({ id: nonEmpty, chunkId: nonEmpty })),
  citations: z.array(z.object({ evidenceId: z.string(), chunkId: z.string(), quote: z.string(), availableOn: day })),
});
export type CitationCase = z.infer<typeof citationCaseSchema>;
/** A passage as the store holds it, which is the ground truth every citation is checked against. */
export type StoredChunk = { id: string; issuerKey: string; availableOn: string; docKind: string; text: string };

export const citationChecks = ['id', 'verbatim', 'point_in_time', 'issuer'] as const;
export type CitationCheck = (typeof citationChecks)[number];

/** The pilot gates as exact fractions: every cited ID must exist, and at least 98 of every 100 quotes must be verbatim. */
export const citationGates = {
  citationIds: { check: 'id', numerator: 1, denominator: 1 },
  verbatim: { check: 'verbatim', numerator: 98, denominator: 100 },
} as const satisfies Record<string, { check: CitationCheck; numerator: number; denominator: number }>;

const tallySchema = z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), rate: ratio.nullable() });
/** A gate with no citations to measure has no rate, and a gate without a rate cannot pass. */
export const gateResultSchema = z.union([
  z.object({ required: ratio, rate: z.null(), passed: z.literal(false) }),
  z.object({ required: ratio, rate: ratio, passed: z.boolean() }),
]);
export const citationReportSchema = z.object({
  totals: z.object({ scores: z.number().int().nonnegative(), scoresWithCitations: z.number().int().nonnegative(), citations: z.number().int().nonnegative() }),
  checks: z.object({ id: tallySchema, verbatim: tallySchema, point_in_time: tallySchema, issuer: tallySchema }),
  failures: z.array(z.object({ scoreId: z.string(), symbol: z.string(), kpiId: z.string(), evidenceId: z.string(), check: z.enum(citationChecks), detail: z.string() })),
  gates: z.object({ citationIds: gateResultSchema, verbatim: gateResultSchema }),
});
export type CitationReport = z.infer<typeof citationReportSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Each check's failure detail for one citation, or null where it passed. A citation whose chunk is missing fails all four. */
function judge(item: CitationCase, cite: CitationCase['citations'][number], chunk: StoredChunk | undefined): Record<CitationCheck, string | null> {
  if (!chunk) {
    const missing = `Chunk ${cite.chunkId} is not in the store.`;
    return { id: missing, verbatim: missing, point_in_time: missing, issuer: missing };
  }
  const offered = item.offered.find(o => o.id === cite.evidenceId);
  const quote = squash(cite.quote);
  return {
    id: !offered ? `${cite.evidenceId} was not offered. Offered: ${item.offered.map(o => o.id).join(', ') || 'none'}.`
      : offered.chunkId !== cite.chunkId ? `${cite.evidenceId} was offered as chunk ${offered.chunkId}, but the citation points to chunk ${cite.chunkId}.`
      : null,
    verbatim: !quote ? 'The quote is empty.'
      : squash(chunk.text).includes(quote) ? null
      : `The quote does not appear in chunk ${chunk.id}: "${quote.slice(0, 80)}".`,
    point_in_time: chunk.availableOn <= item.asOf ? null : `Chunk ${chunk.id} was available on ${chunk.availableOn}, after the as-of date ${item.asOf}.`,
    issuer: item.allowedIssuerKeys.includes(chunk.issuerKey) ? null : `Chunk ${chunk.id} belongs to ${chunk.issuerKey}, which is not an issuer of this security (${item.allowedIssuerKeys.join(', ') || 'none'}).`,
  };
}

/**
 * Checks every citation of every score against the stored chunks, independently of the check made at scoring time.
 * `id`: the evidence label was offered for this score and points to the same chunk, which exists.
 * `verbatim`: the quote, with whitespace collapsed, is in the chunk text, case sensitive.
 * `point_in_time`: the chunk was available on or before the as-of date. `issuer`: the chunk belongs to an allowed issuer.
 */
export function evaluateCitations(input: { cases: readonly CitationCase[]; chunks: ReadonlyMap<string, StoredChunk> }): CitationReport {
  const counts = Object.fromEntries(citationChecks.map(c => [c, { passed: 0, total: 0 }])) as Record<CitationCheck, { passed: number; total: number }>;
  const failures: CitationReport['failures'] = [];
  for (const item of input.cases) {
    for (const cite of item.citations) {
      const result = judge(item, cite, input.chunks.get(cite.chunkId));
      for (const check of citationChecks) {
        counts[check].total++;
        const detail = result[check];
        if (detail === null) counts[check].passed++;
        else failures.push({ scoreId: item.scoreId, symbol: item.symbol, kpiId: item.kpiId, evidenceId: cite.evidenceId, check, detail });
      }
    }
  }
  const tally = (check: CitationCheck) => ({ ...counts[check], rate: counts[check].total === 0 ? null : counts[check].passed / counts[check].total });
  const checks = { id: tally('id'), verbatim: tally('verbatim'), point_in_time: tally('point_in_time'), issuer: tally('issuer') };
  const gate = (name: keyof typeof citationGates): GateResult => {
    const { check, numerator, denominator } = citationGates[name];
    const { passed, total, rate } = checks[check];
    const required = numerator / denominator;
    return rate === null ? { required, rate, passed: false } : { required, rate, passed: passed * denominator >= total * numerator };
  };
  return {
    totals: {
      scores: input.cases.length,
      scoresWithCitations: input.cases.filter(c => c.citations.length > 0).length,
      citations: input.cases.reduce((n, c) => n + c.citations.length, 0),
    },
    checks,
    failures,
    gates: { citationIds: gate('citationIds'), verbatim: gate('verbatim') },
  };
}
