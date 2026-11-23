import { z } from 'zod';
import { bucketLevel, type Kpi } from './framework.js';

export type ScoreLevel = '0' | '1' | '2' | '3' | '4' | 'unknown';
export type DocKind = 'sec_filing' | 'esef_filing' | 'web_report';

/** A retrieved passage offered to the Analyst. `id` is a short label such as `e3`, so a model cannot cite an invented identifier. */
export type EvidenceItem = {
  id: string; chunkId: string; docKind: DocKind; docId: string; issuerKey: string;
  section: string; startOffset: number; endOffset: number; availableOn: string; text: string;
};
export type ResolvedCitation = { evidenceId: string; quote: string; chunkId: string; docKind: DocKind; docId: string; section: string; startOffset: number; endOffset: number; availableOn: string };

const citation = z.object({ evidenceId: z.string(), quote: z.string() }).strict();
/** Model output for a judgement KPI. Every field is present, as strict structured output needs. */
export const judgementOutputSchema = z.object({ level: z.enum(['0', '1', '2', '3', '4', 'unknown']), citations: z.array(citation), rationale: z.string(), conflicts: z.array(z.string()) }).strict();
/** Model output for an extract_then_quant KPI. The model returns the number and code sets the level. */
export const extractionOutputSchema = z.object({ extractedValue: z.number().nullable(), citations: z.array(citation), rationale: z.string(), conflicts: z.array(z.string()) }).strict();
export type JudgementOutput = z.infer<typeof judgementOutputSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

export const scoreLimits = { maxCitations: 4, quoteChars: [8, 300], rationaleChars: 600, maxConflicts: 5 } as const;

export type ScoreErrorCode =
  | 'unknown_evidence_id' | 'wrong_security' | 'outside_window' | 'quote_not_verbatim' | 'quote_length' | 'too_many_citations'
  | 'uncited_level' | 'uncited_value' | 'value_out_of_range' | 'rationale_length' | 'too_many_conflicts' | 'wrong_output';
export type ScoreError = { code: ScoreErrorCode; message: string };
export type ScoreCheck =
  | { ok: true; level: ScoreLevel; extractedValue: number | null; citations: ResolvedCitation[] }
  | { ok: false; errors: ScoreError[] };

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const dayMs = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);

/**
 * Checks a model's score against the evidence it was given and the rules, and returns every violation.
 * Quotes must appear verbatim, apart from whitespace, in the evidence they cite. An extracted value is bucketed here, by code.
 * `allowedIssuerKeys` are the issuers whose filings count as evidence for this security.
 */
export function validateScore(input: { kpi: Exclude<Kpi, { method: 'quant' }>; output: unknown; evidence: readonly EvidenceItem[]; asOf: string; allowedIssuerKeys: readonly string[] }): ScoreCheck {
  const { kpi, evidence } = input;
  const parsed = (kpi.method === 'judgement' ? judgementOutputSchema : extractionOutputSchema).safeParse(input.output);
  if (!parsed.success) return { ok: false, errors: [{ code: 'wrong_output', message: `The output does not match the ${kpi.method} schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` }] };
  const output = parsed.data;
  const errors: ScoreError[] = [];
  const fail = (code: ScoreErrorCode, message: string) => errors.push({ code, message });
  const byId = new Map(evidence.map(e => [e.id, e]));
  const [minQuote, maxQuote] = scoreLimits.quoteChars;
  if (output.citations.length > scoreLimits.maxCitations) fail('too_many_citations', `Cite at most ${scoreLimits.maxCitations} passages, got ${output.citations.length}.`);
  if (output.conflicts.length > scoreLimits.maxConflicts) fail('too_many_conflicts', `List at most ${scoreLimits.maxConflicts} conflicts.`);
  if (!output.rationale.trim() || output.rationale.length > scoreLimits.rationaleChars) fail('rationale_length', `The rationale must be 1 to ${scoreLimits.rationaleChars} characters.`);
  const resolved: ResolvedCitation[] = [];
  output.citations.forEach((c, i) => {
    const item = byId.get(c.evidenceId);
    if (!item) { fail('unknown_evidence_id', `Citation ${i + 1} cites "${c.evidenceId}", which was not offered. Offered: ${evidence.map(e => e.id).join(', ')}.`); return; }
    if (!input.allowedIssuerKeys.includes(item.issuerKey)) fail('wrong_security', `Evidence ${item.id} belongs to ${item.issuerKey}, which is not an issuer of this security.`);
    if (item.availableOn > input.asOf || daysBetween(item.availableOn, input.asOf) > kpi.lookbackDays) fail('outside_window', `Evidence ${item.id} was available on ${item.availableOn}, outside the ${kpi.lookbackDays} day lookback to ${input.asOf}.`);
    const quote = squash(c.quote);
    if (quote.length < minQuote || quote.length > maxQuote) fail('quote_length', `The quote for ${item.id} must be ${minQuote} to ${maxQuote} characters.`);
    else if (!squash(item.text).includes(quote)) fail('quote_not_verbatim', `The quote for ${item.id} does not appear verbatim in that passage: "${quote.slice(0, 80)}".`);
    resolved.push({ evidenceId: item.id, quote, chunkId: item.chunkId, docKind: item.docKind, docId: item.docId, section: item.section, startOffset: item.startOffset, endOffset: item.endOffset, availableOn: item.availableOn });
  });
  let level: ScoreLevel = 'unknown';
  let extractedValue: number | null = null;
  if (kpi.method === 'judgement') {
    const o = output as JudgementOutput;
    level = o.level;
    if (o.level !== 'unknown' && o.level !== '0' && o.citations.length === 0) fail('uncited_level', `Level ${o.level} needs at least one cited passage. Use unknown or level 0 when no passage supports a higher level.`);
  } else {
    const o = output as ExtractionOutput;
    extractedValue = o.extractedValue;
    if (extractedValue !== null) {
      const { unit } = kpi.extraction;
      if (!Number.isFinite(extractedValue) || extractedValue < 0 || (unit === 'fraction' && extractedValue > 1)) fail('value_out_of_range', `The value ${extractedValue} is out of range for unit ${unit}${unit === 'fraction' ? '. Write 30 percent as 0.3' : ''}.`);
      else level = String(bucketLevel(extractedValue, kpi.thresholds)) as ScoreLevel;
      if (o.citations.length === 0) fail('uncited_value', 'An extracted value needs at least one cited passage that contains it.');
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, level, extractedValue, citations: resolved };
}

/** The level for a quant KPI. A missing value is unknown. */
export function quantLevel(kpi: Extract<Kpi, { method: 'quant' }>, value: number | null): ScoreLevel {
  return value === null || !Number.isFinite(value) ? 'unknown' : (String(bucketLevel(value, kpi.thresholds)) as ScoreLevel);
}

/**
 * A confidence from 0 to 1, computed from the result and not asked of the model. It is a heuristic for v1.
 * An invalid score and a missing quant value get 0, a computed quant value gets 1, and an unknown level gets 0.2.
 * Otherwise it starts at 0.4, adds 0.2 for two or more citations, 0.2 for two or more distinct documents,
 * and 0.2 when the newest cited passage is within 400 days of the as-of date, and takes 0.2 off when conflicts are listed.
 */
export function computeConfidence(input: { method: Kpi['method']; valid: boolean; level: ScoreLevel; quantValue?: number | null; citations: readonly Pick<ResolvedCitation, 'docId' | 'availableOn'>[]; conflicts: readonly string[]; asOf: string }): number {
  if (!input.valid) return 0;
  if (input.method === 'quant') return input.quantValue === null || input.quantValue === undefined ? 0 : 1;
  if (input.level === 'unknown') return 0.2;
  let c = 0.4;
  if (input.citations.length >= 2) c += 0.2;
  if (new Set(input.citations.map(x => x.docId)).size >= 2) c += 0.2;
  const newest = input.citations.map(x => x.availableOn).sort().at(-1);
  if (newest && daysBetween(newest, input.asOf) <= 400) c += 0.2;
  if (input.conflicts.length > 0) c -= 0.2;
  return Math.round(Math.min(1, Math.max(0, c)) * 100) / 100;
}
