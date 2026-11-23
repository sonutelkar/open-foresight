import { createHash } from 'node:crypto';
import { z } from 'zod';
import { levelSchema } from './kappa.js';
import type { LabelledSet } from './labels.js';

const id = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Frozen before any live scoring (PR 18). Changing either line is a new manifest version, never an edit.
 * - Unknown: a pair where either side says `unknown` leaves the kappa and exact agreement, and is counted in `excluded`. Stability counts `unknown` as a level.
 * - Masked-level change: see `maskingPolicy` in metrics.ts.
 * - Missing: a record with no scorer output is never dropped silently. It is counted, and a gate with any missing record is `incomplete`.
 */
export const missingPolicy = { unknown: 'kappa-excludes-and-reports', missing: 'counted-and-incomplete' } as const;

export const provenances = ['provisional-ai', 'ai-generated-human-sampled', 'human'] as const;
/** What the release gate may use. `provisional-ai` never qualifies. */
export const releaseProvenances = ['ai-generated-human-sampled', 'human'] as const;

export const flaws = ['wrong_issuer', 'stale_evidence', 'talk_without_numbers', 'none'] as const;

/** A stored copy of a public web page that a label cites: the passage, the stored page, its URL, when it was fetched and the sha256 of the fetched bytes. */
export const webCitationSchema = z.object({ passageId: id, sourceId: id, url: z.string().url(), fetchedAt: z.string().datetime(), sha256 }).strict();
const recordBase = { id, theme: id, symbol: id, snapshotId: id, evidenceIds: z.array(id), webCitations: z.array(webCitationSchema).optional() };

/** A stock by KPI pair and its label. */
export const kpiRecordSchema = z.object({ ...recordBase, kpiId: id, level: levelSchema, labelledBy: id, evidenceIds: z.array(id).min(1) }).strict();
/** A score for the Reviewer to judge. `flaw` is `none` for a clean control. */
export const reviewerRecordSchema = z.object({ ...recordBase, kpiId: id, flaw: z.enum(flaws), labelledBy: id, evidenceIds: z.array(id).min(1) }).strict();
/** A name and whether it is relevant to the theme. A name with no evidence has an empty `evidenceIds`: that is the missing-evidence case. */
export const relevanceRecordSchema = z.object({ ...recordBase, relevant: z.boolean(), labelledBy: id }).strict();

const labellerSchema = z.object({ name: id, kind: z.enum(['human', 'ai']), vendor: id.optional(), model: id.optional() }).strict();

const common = {
  schemaVersion: z.literal(1),
  manifestId: id,
  /** A change to any record is a new version with a new hash. `supersedes` names the manifest it replaces. */
  version: z.number().int().positive(),
  supersedes: id.nullable(),
  createdAt: z.string().datetime(),
  /** A checked-in fixture. It verifies tooling and is rejected as release data. */
  fixture: z.boolean(),
  provenance: z.enum(provenances),
  themes: z.array(id).min(1),
  labellers: z.array(labellerSchema).min(1),
  /** Vendors of every scorer and the Reviewer this set will judge. An AI labeller from one of them is not independent. */
  scorerVendors: z.array(id),
  sampling: z.object({ seed: z.number().int(), requested: z.number().int().positive(), pool: z.number().int().nonnegative() }).strict(),
  adjudication: z.object({ method: id, adjudicators: z.array(id) }).strict(),
  /** The human spot check of an AI labelled set: how many records a person checked and how many of those matched the label. */
  humanSample: z.object({ n: z.number().int().nonnegative(), agreed: z.number().int().nonnegative(), reviewers: z.array(id) }).strict().nullable(),
  missingPolicy: z.object({ unknown: z.literal(missingPolicy.unknown), missing: z.literal(missingPolicy.missing) }).strict(),
  /** sha256 of the canonical JSON of `records`. A mismatch means the manifest was edited in place. */
  contentHash: sha256,
};

function noDuplicates(records: readonly { id: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: `Duplicate record ${r.id}` });
    seen.add(r.id);
  }
}

export const manifestSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('kpi'), records: z.array(kpiRecordSchema) }).strict(),
  z.object({ ...common, kind: z.literal('reviewer'), records: z.array(reviewerRecordSchema) }).strict(),
  z.object({ ...common, kind: z.literal('relevance'), records: z.array(relevanceRecordSchema) }).strict(),
]).superRefine((m, ctx) => noDuplicates(m.records, ctx));
export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestKind = Manifest['kind'];
export type KpiRecord = z.infer<typeof kpiRecordSchema>;
export type ReviewerRecord = z.infer<typeof reviewerRecordSchema>;
export type RelevanceRecord = z.infer<typeof relevanceRecordSchema>;

/** JSON with sorted keys, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const hashRecords = (records: readonly unknown[]): string => createHash('sha256').update(canonicalJson(records)).digest('hex');

/** Wraps the PR 17 AI labelled set as a provisional KPI manifest. The set has no theme or snapshot of its own, so the caller names them. It can never pass release validation. */
export function provisionalKpiManifest(set: LabelledSet, args: { manifestId: string; theme: string; snapshotId: string }): Extract<Manifest, { kind: 'kpi' }> {
  const records = set.pairs.map(p => ({ id: p.id, theme: args.theme, symbol: p.symbol, snapshotId: args.snapshotId, evidenceIds: p.chunkIds, kpiId: p.kpiId, level: p.labelLevel, labelledBy: set.labeller.model }));
  return {
    schemaVersion: 1, manifestId: args.manifestId, version: 1, supersedes: null, createdAt: set.createdAt, fixture: false,
    provenance: 'provisional-ai', themes: [args.theme],
    labellers: [{ name: set.labeller.model, kind: 'ai', vendor: set.labeller.provider, model: set.labeller.model }],
    scorerVendors: [], sampling: set.sample, adjudication: { method: 'none', adjudicators: [] }, humanSample: null,
    missingPolicy: { ...missingPolicy }, contentHash: hashRecords(records), kind: 'kpi', records,
  };
}
