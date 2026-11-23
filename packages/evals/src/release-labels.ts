import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateScore, type EvidenceItem, type Kpi, type ResolvedCitation } from '@open-foresight/core';
import { levelSchema, type RubricLevel } from './kappa.js';
import { numbersIn } from './leakage.js';
import { flaws, hashRecords, kpiRecordSchema, missingPolicy, relevanceRecordSchema, reviewerRecordSchema, webCitationSchema, type Manifest, type ManifestKind } from './manifest.js';
import { releaseKinds, releaseRequirements, validateReleaseSet } from './validate.js';

/**
 * The release label set of the 2026-11-23 decision: three themes, each with its frozen reference funds in docs/reference.
 * The funds only shape the candidate pool of the relevance sample. They are never a label.
 */
export const releaseThemes = [
  { id: 'smart-energy', name: 'Smart Energy', funds: ['GRID', 'ICLN'], description: 'Companies that make, sell or run the equipment, software and services of the electricity transition: grid transmission and distribution equipment, grid automation and smart meters, energy storage, inverters, demand response and energy efficiency, and renewable generation.' },
  { id: 'cybersecurity', name: 'Cybersecurity', funds: ['CIBR'], description: 'Companies whose products or services protect networks, devices, applications, identities and data from attack: security software, security appliances, managed security services and security consulting.' },
  { id: 'robotics-ai', name: 'Robotics & AI', funds: ['BOTZ'], description: 'Companies that make robots, industrial automation and motion control, autonomous systems, or artificial intelligence hardware and software, such as AI chips and machine learning platforms.' },
] as const;
export const themeIdSchema = z.enum(['smart-energy', 'cybersecurity', 'robotics-ai']);
export type ThemeId = z.infer<typeof themeIdSchema>;
export const releaseThemeIds: ThemeId[] = releaseThemes.map(t => t.id);

export const defaultLabelSeed = 20261123;
export type InjectedFlaw = Exclude<(typeof flaws)[number], 'none'>;
export const injectedFlaws: InjectedFlaw[] = ['wrong_issuer', 'stale_evidence', 'talk_without_numbers'];

const id = z.string().trim().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const int = z.number().int();
const docKind = z.enum(['sec_filing', 'esef_filing', 'web_report', 'company_profile']);
const rubricSchema = z.object({ levels: z.object({ 0: id, 1: id, 2: id, 3: id, 4: id }).strict(), unknown: id }).strict();
const kpiInfoSchema = z.object({ name: id, definition: id, lookbackDays: int.positive(), rubric: rubricSchema }).strict();
const citationSchema = z.object({ evidenceId: id, quote: z.string(), chunkId: id, docKind, docId: id, section: z.string(), startOffset: int, endOffset: int, availableOn: isoDate }).strict();

/** A stored passage. `source` is where a person can read the document: its URL, or `<docKind>:<docId>` when the store has none. */
export const passageSchema = z.object({ chunkId: id, docKind, docId: id, issuerKey: id, availableOn: isoDate, section: z.string(), startOffset: int, endOffset: int, text: z.string().min(1), source: id }).strict();
export type Passage = z.infer<typeof passageSchema>;

/** One stored score attempt: the latest valid attempt per run, security and KPI, on a KPI with a rubric. `offered` are the passages the scorer was shown. */
export const extractScoreSchema = z.object({
  id, runId: id, frameworkDraftId: id, securityId: id, symbol: id, company: id, kpiId: id,
  method: z.enum(['judgement', 'extract_then_quant']), promptVersion: z.string().nullable(), asOf: isoDate, level: levelSchema, confidence: z.number(),
  /** The issuers whose filings count as evidence for this security. */
  issuerKeys: z.array(id), kpi: kpiInfoSchema, citations: z.array(citationSchema), offered: z.array(z.object({ id, chunkId: id }).strict()),
}).strict();
export type ExtractScore = z.infer<typeof extractScoreSchema>;

/** A name a theme run considers. `funds` are the reference funds whose issuer file lists it. No `passageIds` means the store has no evidence for it. */
export const extractNameSchema = z.object({ runId: id, symbol: id, name: id, issuerKeys: z.array(id), funds: z.array(id), passageIds: z.array(id) }).strict();

/**
 * What labelling reads from the local store, and nothing else: the theme runs with their snapshots, their scores with cited and offered passages,
 * donor passages for the injections, and the names with their passages. `apps/worker/src/release-store.ts` builds it from Postgres. A recorded one is a fixture.
 */
export const releaseExtractSchema = z.object({
  schemaVersion: z.literal(1), fixture: z.boolean(),
  runs: z.array(z.object({ runId: id, theme: themeIdSchema, asOf: isoDate, snapshotId: id }).strict()).min(1),
  scores: z.array(extractScoreSchema), names: z.array(extractNameSchema), passages: z.array(passageSchema),
}).strict();
export type ReleaseExtract = z.infer<typeof releaseExtractSchema>;

/** mulberry32, so a seed gives the same choice on every machine. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function shuffled<T>(items: readonly T[], key: (t: T) => string, random: () => number): T[] {
  const out = [...items].sort((a, b) => cmp(key(a), key(b)));
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}
/** `n` split over `parts`, the remainder to the first parts. */
const quota = (n: number, parts: number) => Array.from({ length: parts }, (_, i) => Math.floor(n / parts) + (i < n % parts ? 1 : 0));
const themeSeed = (seed: number, theme: ThemeId) => seed ^ (releaseThemeIds.indexOf(theme) + 1) * 0x9e3779b1;

/** A UUID derived from its parts, so the same build gives the same rows and a repeat finds them. */
export function uuidFrom(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\n')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const dayMs = 86_400_000;
/** The first day a passage may be from: the KPI lookback before the as-of date. */
export const windowStart = (asOf: string, lookbackDays: number) => new Date(Date.parse(`${asOf}T00:00:00Z`) - lookbackDays * dayMs).toISOString().slice(0, 10);

type Cited = { evidenceId: string; quote: string; passage: Passage };
export type ScoreEvidence = { level: RubricLevel; asOf: string; lookbackDays: number; issuerKeys: readonly string[]; cited: readonly Cited[] };

const checkRubric = { levels: { 0: 'x', 1: 'x', 2: 'x', 3: 'x', 4: 'x' }, unknown: 'x' };
/**
 * The flaws code finds in a score's cited evidence. `wrong_issuer` and `stale_evidence` are the issuer and lookback checks of core's `validateScore`.
 * `talk_without_numbers` is a level of 2 or more where no cited passage holds a figure. Any other validation error is listed in `invalid`.
 */
export function detectFlaws(e: ScoreEvidence): { flaws: InjectedFlaw[]; invalid: string[] } {
  const kpi: Kpi = { id: 'check', name: 'check', definition: 'check', subThemeId: 'check', sources: [], lookbackDays: e.lookbackDays, weightPercent: 0, isGate: false, method: 'judgement', rubric: checkRubric };
  const evidence: EvidenceItem[] = e.cited.map(c => ({ id: c.evidenceId, chunkId: c.passage.chunkId, docKind: c.passage.docKind, docId: c.passage.docId, issuerKey: c.passage.issuerKey, section: c.passage.section, startOffset: c.passage.startOffset, endOffset: c.passage.endOffset, availableOn: c.passage.availableOn, text: c.passage.text }));
  const check = validateScore({ kpi, output: { level: e.level, citations: e.cited.map(c => ({ evidenceId: c.evidenceId, quote: c.quote })), rationale: 'check', conflicts: [] }, evidence, asOf: e.asOf, allowedIssuerKeys: e.issuerKeys });
  const codes = new Set(check.ok ? [] : check.errors.map(x => x.code));
  const found: InjectedFlaw[] = [];
  if (codes.has('wrong_security')) found.push('wrong_issuer');
  if (codes.has('outside_window')) found.push('stale_evidence');
  if (['2', '3', '4'].includes(e.level) && e.cited.length > 0 && e.cited.every(c => numbersIn(c.passage.text).length === 0)) found.push('talk_without_numbers');
  return { flaws: found, invalid: [...codes].filter(c => c !== 'wrong_security' && c !== 'outside_window') };
}

/** One score for the Reviewer evaluation: a copy of a stored score, with an injected flaw or, for a clean control, unchanged. */
export const flawItemSchema = z.object({
  id, baseScoreId: id, sourceRunId: id, fixtureRunId: id, snapshotId: id, theme: themeIdSchema, flaw: z.enum(flaws),
  frameworkDraftId: id, securityId: id, symbol: id, company: id, kpiId: id, method: z.enum(['judgement', 'extract_then_quant']),
  asOf: isoDate, level: levelSchema, confidence: z.number(), issuerKeys: z.array(id), kpi: kpiInfoSchema,
  citations: z.array(citationSchema).min(1), passages: z.array(passageSchema).min(1),
}).strict();
export type FlawItem = z.infer<typeof flawItemSchema>;

/** The output of `build-flawed`: flawed scores and clean controls, each a `kpi_scores` row in a cancelled fixture run of its source run. */
export const flawedFileSchema = z.object({
  schemaVersion: z.literal(1), fixture: z.boolean(), seed: int,
  requested: z.object({ flawed: int.nonnegative(), clean: int.nonnegative() }).strict(), pool: int.nonnegative(),
  runs: z.array(z.object({ sourceRunId: id, fixtureRunId: id, snapshotId: id, theme: themeIdSchema }).strict()),
  items: z.array(flawItemSchema),
}).strict();
export type FlawedFile = z.infer<typeof flawedFileSchema>;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
/** A verbatim quote from the start of a passage, at most 200 characters, cut at a word. */
const quoteOf = (text: string) => { const t = squash(text); return t.length <= 200 ? t : t.slice(0, Math.max(t.lastIndexOf(' ', 200), 8)); };
const asCitation = (p: Passage, i: number): ResolvedCitation => ({ evidenceId: `e${i + 1}`, quote: quoteOf(p.text), chunkId: p.chunkId, docKind: p.docKind, docId: p.docId, section: p.section, startOffset: p.startOffset, endOffset: p.endOffset, availableOn: p.availableOn });
const pick = <T,>(items: readonly T[], n: number, random: () => number, key: (t: T) => string) => shuffled(items, key, random).slice(0, n);

export type FlawPlan = { file: FlawedFile; shortages: string[] };

/**
 * Chooses flawed scores and clean controls from the extract by seed, balanced over the three themes and, within a theme, over the three flaws.
 * A base score has a level of 1 to 4, cites at least one passage, and passes the code checks. Each flaw replaces every cited passage:
 * `wrong_issuer` with the cited passages of another issuer's score on the same KPI and run, `stale_evidence` with the same issuer's passages from
 * before the lookback, and `talk_without_numbers` with the same issuer's in-window passages that hold no figure, preferring ones the scorer was shown.
 * A copy is kept only when `detectFlaws` finds exactly the intended flaw, or nothing for a clean control. A cell that runs short is a shortage, never filled from another.
 */
export function planFlawed(extract: ReleaseExtract, options: { seed: number; flawed: number; clean: number }): FlawPlan {
  const passages = new Map(extract.passages.map(p => [p.chunkId, p]));
  const themeOf = new Map(extract.runs.map(r => [r.runId, r.theme]));
  const snapshotOf = new Map(extract.runs.map(r => [r.runId, r.snapshotId]));
  const citedOf = (citations: readonly ResolvedCitation[]): Cited[] | null => {
    const out = citations.map(c => ({ evidenceId: c.evidenceId, quote: c.quote, passage: passages.get(c.chunkId) }));
    return out.every((c): c is Cited => c.passage !== undefined) ? out : null;
  };
  const evidenceOf = (s: ExtractScore, cited: Cited[]): ScoreEvidence => ({ level: s.level, asOf: s.asOf, lookbackDays: s.kpi.lookbackDays, issuerKeys: s.issuerKeys, cited });
  const isClean = (s: ExtractScore) => { const cited = citedOf(s.citations); if (!cited) return false; const d = detectFlaws(evidenceOf(s, cited)); return d.flaws.length === 0 && d.invalid.length === 0; };
  const base = extract.scores.filter(s => s.level !== 'unknown' && s.level !== '0' && s.citations.length > 0 && themeOf.has(s.runId) && isClean(s));
  const inWindow = (s: ExtractScore, p: Passage) => p.availableOn <= s.asOf && p.availableOn >= windowStart(s.asOf, s.kpi.lookbackDays);
  const own = (s: ExtractScore, p: Passage) => s.issuerKeys.includes(p.issuerKey);
  const figures = (p: Passage) => numbersIn(p.text).length > 0;

  // Donors for wrong_issuer and stale_evidence carry a figure, so the injected flaw is the only one the checks find.
  const inject = (s: ExtractScore, flaw: InjectedFlaw, random: () => number): ResolvedCitation[] | null => {
    const n = s.citations.length;
    if (flaw === 'wrong_issuer') {
      const donors = extract.scores.filter(d => d.runId === s.runId && d.kpiId === s.kpiId && d.securityId !== s.securityId && d.citations.length > 0
        && d.citations.every(c => { const p = passages.get(c.chunkId); return p !== undefined && !own(s, p) && inWindow(s, p); })
        && d.citations.some(c => figures(passages.get(c.chunkId)!)));
      const donor = pick(donors, 1, random, d => d.id)[0];
      return donor ? donor.citations.map((c, i) => ({ ...c, evidenceId: `e${i + 1}` })) : null;
    }
    const candidates = flaw === 'stale_evidence'
      ? extract.passages.filter(p => own(s, p) && p.availableOn < windowStart(s.asOf, s.kpi.lookbackDays) && figures(p))
      : extract.passages.filter(p => own(s, p) && inWindow(s, p) && !figures(p));
    const offered = new Set(s.offered.map(o => o.chunkId));
    const preferred = candidates.filter(p => offered.has(p.chunkId));
    const chosen = pick(preferred.length > 0 ? preferred : candidates, n, random, p => p.chunkId);
    return chosen.length > 0 ? chosen.map(asCitation) : null;
  };

  const items: FlawItem[] = [];
  const shortages: string[] = [];
  const fixtureRunId = (runId: string) => uuidFrom('reviewer-fixture-run', String(options.seed), runId);
  const item = (s: ExtractScore, flaw: FlawItem['flaw'], citations: ResolvedCitation[]): FlawItem => ({
    id: uuidFrom('reviewer-fixture-score', String(options.seed), s.id, flaw), baseScoreId: s.id, sourceRunId: s.runId, fixtureRunId: fixtureRunId(s.runId), snapshotId: snapshotOf.get(s.runId)!,
    theme: themeOf.get(s.runId)!, flaw, frameworkDraftId: s.frameworkDraftId, securityId: s.securityId, symbol: s.symbol, company: s.company, kpiId: s.kpiId,
    method: s.method, asOf: s.asOf, level: s.level, confidence: s.confidence, issuerKeys: s.issuerKeys, kpi: s.kpi, citations,
    passages: [...new Map(citations.map(c => [c.chunkId, passages.get(c.chunkId)!])).values()],
  });
  const flawedQuota = quota(options.flawed, releaseThemeIds.length), cleanQuota = quota(options.clean, releaseThemeIds.length);
  releaseThemeIds.forEach((theme, t) => {
    const random = seeded(themeSeed(options.seed, theme));
    const pool = shuffled(base.filter(s => themeOf.get(s.runId) === theme), s => s.id, random);
    const used = new Set<string>();
    quota(flawedQuota[t]!, injectedFlaws.length).forEach((need, f) => {
      const flaw = injectedFlaws[f]!;
      let got = 0;
      for (const s of pool) {
        if (got === need) break;
        if (used.has(s.id)) continue;
        const citations = inject(s, flaw, random);
        const cited = citations && citedOf(citations);
        if (!citations || !cited) continue;
        const d = detectFlaws(evidenceOf(s, cited));
        if (d.invalid.length > 0 || d.flaws.length !== 1 || d.flaws[0] !== flaw) continue;
        items.push(item(s, flaw, citations));
        used.add(s.id);
        got++;
      }
      if (got < need) shortages.push(`${theme} ${flaw}: ${got} of ${need} (pool ${pool.length} scores)`);
    });
    const clean = pool.filter(s => !used.has(s.id)).slice(0, cleanQuota[t]);
    for (const s of clean) items.push(item(s, 'none', s.citations));
    if (clean.length < cleanQuota[t]!) shortages.push(`${theme} clean: ${clean.length} of ${cleanQuota[t]} (pool ${pool.length} scores)`);
  });
  const runs = [...new Map(items.map(i => [i.sourceRunId, { sourceRunId: i.sourceRunId, fixtureRunId: i.fixtureRunId, snapshotId: i.snapshotId, theme: i.theme }])).values()].sort((a, b) => cmp(a.sourceRunId, b.sourceRunId));
  return {
    file: { schemaVersion: 1, fixture: extract.fixture, seed: options.seed, requested: { flawed: options.flawed, clean: options.clean }, pool: base.length, runs, items },
    shortages,
  };
}

/** The code checks of one item, for anyone who wants to see the flaw it carries. */
export const itemFlaws = (i: FlawItem) => detectFlaws({ level: i.level, asOf: i.asOf, lookbackDays: i.kpi.lookbackDays, issuerKeys: i.issuerKeys, cited: i.citations.map(c => ({ evidenceId: c.evidenceId, quote: c.quote, passage: i.passages.find(p => p.chunkId === c.chunkId)! })) });

/** The pairs the KPI labeller may label: judgement scores by the Analyst's judgement prompt, with a level 0 to 4 and the passages it was shown. */
export function kpiPool(extract: ReleaseExtract): ExtractScore[] {
  const known = new Set(extract.passages.map(p => p.chunkId));
  return extract.scores.filter(s => s.method === 'judgement' && s.level !== 'unknown' && (s.promptVersion?.startsWith('analyst-judgement@') ?? false)
    && s.offered.length > 0 && s.offered.every(o => known.has(o.chunkId)));
}

export type Selection<T> = { picked: Array<T & { theme: ThemeId }>; pool: number; shortages: string[] };

/** `count` pairs by seed, split evenly over the themes and, within a theme, taken in turn from each level so every level the pool has is present. */
export function pickKpiPairs(extract: ReleaseExtract, options: { seed: number; count: number }): Selection<ExtractScore> {
  const themeOf = new Map(extract.runs.map(r => [r.runId, r.theme]));
  const pool = kpiPool(extract).filter(s => themeOf.has(s.runId));
  const picked: Selection<ExtractScore>['picked'] = [];
  const shortages: string[] = [];
  const want = quota(options.count, releaseThemeIds.length);
  releaseThemeIds.forEach((theme, t) => {
    const random = seeded(themeSeed(options.seed, theme));
    const groups = (['0', '1', '2', '3', '4'] as const).map(l => shuffled(pool.filter(s => themeOf.get(s.runId) === theme && s.level === l), s => s.id, random));
    const taken: ExtractScore[] = [];
    for (let round = 0; taken.length < want[t]! && groups.some(g => g.length > round); round++) {
      for (const g of groups) if (g[round] && taken.length < want[t]!) taken.push(g[round]!);
    }
    picked.push(...taken.map(s => ({ ...s, theme })));
    if (taken.length < want[t]!) shortages.push(`${theme}: ${taken.length} of ${want[t]} KPI pairs`);
  });
  return { picked, pool: pool.length, shortages };
}

export type ExtractName = z.infer<typeof extractNameSchema>;
/**
 * `count` names by seed, split evenly over the themes. Within a theme half come from names a reference fund holds and half from the rest,
 * each a seeded shuffle, and either half tops up the other when it runs out. Names with no evidence are kept at their share of the pool.
 */
export function pickRelevanceNames(extract: ReleaseExtract, options: { seed: number; count: number }): Selection<ExtractName> {
  const themeOf = new Map(extract.runs.map(r => [r.runId, r.theme]));
  const picked: Selection<ExtractName>['picked'] = [];
  const shortages: string[] = [];
  const want = quota(options.count, releaseThemeIds.length);
  let pool = 0;
  releaseThemeIds.forEach((theme, t) => {
    const random = seeded(themeSeed(options.seed, theme));
    const names = [...new Map(extract.names.filter(n => themeOf.get(n.runId) === theme).sort((a, b) => cmp(a.runId, b.runId)).map(n => [n.symbol, n])).values()];
    pool += names.length;
    const held = shuffled(names.filter(n => n.funds.length > 0), n => n.symbol, random), rest = shuffled(names.filter(n => n.funds.length === 0), n => n.symbol, random);
    const fromHeld = Math.min(held.length, Math.max(Math.ceil(want[t]! / 2), want[t]! - rest.length));
    const taken = [...held.slice(0, fromHeld), ...rest.slice(0, want[t]! - fromHeld)];
    picked.push(...taken.map(n => ({ ...n, theme })));
    if (taken.length < want[t]!) shortages.push(`${theme}: ${taken.length} of ${want[t]} names`);
  });
  return { picked, pool, shortages };
}

/** What the labeller returns when it checks a reviewer record. `other` is a different serious problem, so the record is not a clean control. */
export const flawLabelSchema = z.object({ flaw: z.enum([...flaws, 'other']), evidence: z.array(z.string()), rationale: z.string() }).strict();
/** What the KPI labeller returns: the level, and the passages it relies on. */
export const kpiLabelSchema = z.object({ level: levelSchema, evidence: z.array(z.string()), rationale: z.string() }).strict();
/** What the labeller returns for one name and theme. */
export const relevanceLabelSchema = z.object({ relevant: z.boolean(), evidence: z.array(z.string()), rationale: z.string() }).strict();

/**
 * Why the label says what it says: the labeller's rationale, the passages it named, and every passage it was shown with where to read it.
 * A web passage also carries the stored page's fetch time and content hash.
 */
export const labelNoteSchema = z.object({
  company: id, subject: id, rationale: z.string(), cited: z.array(id),
  passages: z.array(z.object({ label: id, chunkId: id, source: id, issuerKey: id, availableOn: isoDate, text: z.string(), fetchedAt: z.string().datetime().optional(), sha256: z.string().optional() }).strict()),
}).strict();
export type LabelNote = z.infer<typeof labelNoteSchema>;

const labelFileBase = {
  schemaVersion: z.literal(1), fixture: z.boolean(), snapshotIds: z.array(id).min(1),
  labeller: z.object({ name: id, vendor: id, model: id, promptVersion: id }).strict(),
  sampling: z.object({ seed: int, requested: int.positive(), pool: int.nonnegative() }).strict(),
  createdAt: z.string().datetime(),
  notes: z.record(id, labelNoteSchema),
  /** Records the labeller contradicted. They never enter a manifest, and their count is printed. */
  dropped: z.array(z.object({ id, reason: id }).strict()),
  /** Records whose label cited a passage it was not shown, or cited no stored web page when it was shown one. They never enter a manifest. */
  rejected: z.array(z.object({ id, reason: id }).strict()),
  /** Labelled records with no stored web page to cite, and why. They are kept, with no `webCitations`. */
  noWebSource: z.array(z.object({ id, reason: id }).strict()),
  /** Records whose call failed. A rerun retries them. */
  failed: z.array(z.object({ id, error: z.string() }).strict()),
};
/** The labels of one manifest kind, as `label` writes them. `records` are manifest records. */
export const labelFileSchema = z.discriminatedUnion('kind', [
  z.object({ ...labelFileBase, kind: z.literal('kpi'), records: z.array(kpiRecordSchema) }).strict(),
  z.object({ ...labelFileBase, kind: z.literal('reviewer'), records: z.array(reviewerRecordSchema) }).strict(),
  z.object({ ...labelFileBase, kind: z.literal('relevance'), records: z.array(relevanceRecordSchema) }).strict(),
]);
export type LabelFile = z.infer<typeof labelFileSchema>;

/** A passage of a stored web page: its id, its span in the stored text, and that text. */
export const webPassageSchema = z.object({ id, start: int.nonnegative(), end: int.positive(), text: z.string().min(1) }).strict();
/** A web page stored for a label subject, and the passages of it a labeller is shown. */
export const webSourceSchema = z.object({ sourceId: id, url: z.string().url(), finalUrl: z.string().url(), fetchedAt: z.string().datetime(), sha256: z.string().regex(/^[0-9a-f]{64}$/), passages: z.array(webPassageSchema).min(1) }).strict();
/** `no_issuer` is a subject with no issuer key, so nothing can be stored for it and no search is made. */
export const sourceOutcomes = ['stored', 'no_candidates', 'all_rejected', 'error', 'no_issuer'] as const;
/** The search for one label subject: what the discoverer proposed, what code rejected and why, and what was stored. */
export const sourceEntrySchema = z.object({
  outcome: z.enum(sourceOutcomes), attemptId: id.nullable(), model: z.string().nullable(), provider: z.string().nullable(), zdr: z.boolean().nullable(),
  candidates: z.array(z.string()), rejected: z.array(z.object({ url: z.string(), reason: id }).strict()), error: z.string().nullable(), sources: z.array(webSourceSchema),
}).strict();
/** The output of `collect-sources` for one manifest kind, keyed by record id. */
export const sourcesFileSchema = z.object({ schemaVersion: z.literal(1), kind: z.enum(['kpi', 'reviewer', 'relevance']), fixture: z.boolean(), promptVersion: id, entries: z.record(id, sourceEntrySchema) }).strict();
export type SourcesFile = z.infer<typeof sourcesFileSchema>;
export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export type WebSource = z.infer<typeof webSourceSchema>;
export type WebCitation = z.infer<typeof webCitationSchema>;

/** The human spot check sample: a seeded draw of `ceil(share × n)` record ids, never fewer than the release gate needs. */
export function drawHumanSample(ids: readonly string[], seed: number, share: number = releaseRequirements.minHumanSampleShare): string[] {
  return shuffled([...new Set(ids)], x => x, seeded(seed)).slice(0, Math.ceil(share * new Set(ids).size)).sort(cmp);
}

const labelText = (file: LabelFile, recordId: string): string => {
  if (file.kind === 'kpi') return `level ${file.records.find(r => r.id === recordId)!.level}`;
  if (file.kind === 'reviewer') return file.records.find(r => r.id === recordId)!.flaw;
  return file.records.find(r => r.id === recordId)!.relevant ? 'relevant' : 'not relevant';
};

/** The sheet a colleague fills: the sampled records with the AI label, its rationale and the passages and sources behind it. */
export const checkSheetSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(['kpi', 'reviewer', 'relevance']), seed: int, recordsHash: z.string().regex(/^[0-9a-f]{64}$/), records: int.nonnegative(),
  rows: z.array(z.object({ id, theme: id, symbol: id, company: id, subject: id, label: id, rationale: z.string(), sources: z.array(id), webCitations: z.array(webCitationSchema), passages: labelNoteSchema.shape.passages }).strict()),
}).strict();
export type CheckSheet = z.infer<typeof checkSheetSchema>;

export function checkSheet(file: LabelFile, seed: number): CheckSheet {
  const ids = drawHumanSample(file.records.map(r => r.id), seed);
  return {
    schemaVersion: 1, kind: file.kind, seed, recordsHash: hashRecords(file.records), records: file.records.length,
    rows: ids.map(rid => {
      const r = file.records.find(x => x.id === rid)!, note = file.notes[rid]!;
      return { id: rid, theme: r.theme, symbol: r.symbol, company: note.company, subject: note.subject, label: labelText(file, rid), rationale: note.rationale, sources: [...new Set(note.passages.map(p => p.source))], webCitations: r.webCitations ?? [], passages: note.passages };
    }),
  };
}

export const checkSheetColumns = ['id', 'theme', 'symbol', 'company', 'subject', 'ai_label', 'ai_rationale', 'sources', 'web_citations', 'agree', 'note'] as const;
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
/** The sheet as CSV for a spreadsheet. The colleague writes `yes` or `no` in `agree`, and may add a `note`. Passage texts are in the JSON sheet. */
const citationText = (c: WebCitation) => `${c.url} (stored copy fetched ${c.fetchedAt}, sha256 ${c.sha256})`;
export const checkSheetCsv = (sheet: CheckSheet) => [checkSheetColumns.join(','), ...sheet.rows.map(r => [r.id, r.theme, r.symbol, r.company, r.subject, r.label, r.rationale, r.sources.join(' '), r.webCitations.map(citationText).join(' | '), '', ''].map(csvCell).join(','))].join('\n') + '\n';

/** RFC 4180 CSV: quoted fields may hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/** The recorded spot check of one manifest kind. `recordsHash` ties it to the records the sample was drawn from. */
export const humanCheckSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(['kpi', 'reviewer', 'relevance']), seed: int, recordsHash: z.string().regex(/^[0-9a-f]{64}$/),
  n: int.nonnegative(), agreed: int.nonnegative(), reviewers: z.array(id).min(1), disagreements: z.array(z.object({ id, note: z.string() }).strict()),
}).strict();
export type HumanCheck = z.infer<typeof humanCheckSchema>;

/** Reads the returned sheet. Every sampled record, and only those, must carry `yes` or `no` in `agree`. */
export function recordHumanCheck(sheet: CheckSheet, returnedCsv: string, reviewers: readonly string[]): { ok: true; check: HumanCheck } | { ok: false; errors: string[] } {
  const [header, ...rows] = parseCsv(returnedCsv);
  const col = (name: string) => header?.indexOf(name) ?? -1;
  const errors: string[] = [];
  if (col('id') < 0 || col('agree') < 0) return { ok: false, errors: ['the sheet needs an id and an agree column'] };
  if (reviewers.length === 0 || reviewers.some(r => !r.trim())) errors.push('name the colleague who checked the sheet with --reviewer');
  const answers = new Map<string, { agree: string; note: string }>();
  for (const r of rows) {
    const rid = (r[col('id')] ?? '').trim();
    if (answers.has(rid)) errors.push(`record ${rid} appears twice`);
    answers.set(rid, { agree: (r[col('agree')] ?? '').trim().toLowerCase(), note: col('note') < 0 ? '' : (r[col('note')] ?? '').trim() });
  }
  const drawn = new Set(sheet.rows.map(r => r.id));
  for (const rid of answers.keys()) if (!drawn.has(rid)) errors.push(`record ${rid} was not in the drawn sample`);
  for (const rid of drawn) {
    const a = answers.get(rid);
    if (!a) errors.push(`record ${rid} is missing from the returned sheet`);
    else if (a.agree !== 'yes' && a.agree !== 'no') errors.push(`record ${rid}: agree must be yes or no, got "${a.agree}"`);
  }
  if (errors.length) return { ok: false, errors };
  const no = [...drawn].filter(rid => answers.get(rid)!.agree === 'no');
  return { ok: true, check: { schemaVersion: 1, kind: sheet.kind, seed: sheet.seed, recordsHash: sheet.recordsHash, n: drawn.size, agreed: drawn.size - no.length, reviewers: [...new Set(reviewers.map(r => r.trim()))], disagreements: no.map(rid => ({ id: rid, note: answers.get(rid)!.note })) } };
}

const adjudication: Record<ManifestKind, string> = {
  kpi: 'one AI labeller; a colleague spot-checked a seeded 10% sample and disagreements are recorded, not adjudicated',
  reviewer: 'flaw injected by code and confirmed by one AI labeller, contradicted records dropped; a colleague spot-checked a seeded 10% sample',
  relevance: 'one AI labeller; a colleague spot-checked a seeded 10% sample and disagreements are recorded, not adjudicated',
};

/**
 * Builds the three release manifests and runs the release validation on them. Provenance is `ai-generated-human-sampled` only for a kind
 * with a recorded spot check of exactly its records; otherwise it is `provisional-ai`, which the validation rejects. Nothing is returned as
 * writable unless the whole set passes.
 */
export function assembleRelease(input: {
  labels: Readonly<Record<ManifestKind, LabelFile>>; human: Readonly<Partial<Record<ManifestKind, HumanCheck>>>;
  scorerVendors: readonly string[]; createdAt: string; allowFixture: boolean;
}): { ok: boolean; errors: string[]; manifests: Record<ManifestKind, Manifest> } {
  const errors: string[] = [];
  const build = (kind: ManifestKind): Manifest => {
    const file = input.labels[kind];
    if (file.kind !== kind) throw new Error(`The ${kind} labels file holds ${file.kind} labels`);
    const contentHash = hashRecords(file.records);
    let human = input.human[kind];
    if (human && human.recordsHash !== contentHash) { errors.push(`${kind}: the spot check was drawn from other records than these labels; draw and check the sample again`); human = undefined; }
    else if (!human) errors.push(`${kind}: no spot check is recorded, so the labels stay provisional-ai; run sample-human and record-human-check`);
    return {
      schemaVersion: 1, manifestId: `release-${kind}`, version: 1, supersedes: null, createdAt: input.createdAt, fixture: file.fixture,
      provenance: human ? 'ai-generated-human-sampled' : 'provisional-ai', themes: [...releaseThemeIds],
      labellers: [{ name: file.labeller.name, kind: 'ai', vendor: file.labeller.vendor, model: file.labeller.model }],
      scorerVendors: [...input.scorerVendors], sampling: file.sampling, adjudication: { method: adjudication[kind], adjudicators: [] },
      humanSample: human ? { n: human.n, agreed: human.agreed, reviewers: human.reviewers } : null,
      missingPolicy: { ...missingPolicy }, contentHash, kind, records: file.records,
    } as Manifest;
  };
  const manifests = Object.fromEntries(releaseKinds.map(k => [k, build(k)])) as Record<ManifestKind, Manifest>;
  const validation = validateReleaseSet(releaseKinds.map(k => ({ name: `${k}.json`, raw: manifests[k] })), { allowFixture: input.allowFixture });
  errors.push(...validation.errors);
  return { ok: errors.length === 0, errors, manifests };
}

export type Holding = { fund: string; ticker: string; name: string };
/** The equity rows of a frozen issuer file in docs/reference. Cash, currency, futures, swaps and the disclaimer lines are left out. */
export function parseHoldings(fund: string, csv: string): Holding[] {
  const rows = parseCsv(csv);
  const at = rows.findIndex(r => r.some(c => /^(ticker|identifier)$/i.test(c.trim())));
  if (at < 0) throw new Error(`No holdings header in the ${fund} file`);
  const header = rows[at]!.map(c => c.trim().toLowerCase());
  const ticker = header.findIndex(c => c === 'ticker' || c === 'identifier'), name = header.findIndex(c => c === 'name' || c === 'security_name'), type = header.indexOf('type');
  return rows.slice(at + 1).filter(r => r.length === header.length && (r[ticker] ?? '').trim() && (type < 0 || r[type] === 'EQUITY'))
    .map(r => ({ fund, ticker: r[ticker]!.trim(), name: r[name]!.trim() }));
}

const corporate = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'plc', 'ltd', 'limited', 'sa', 'ag', 'nv', 'se', 'asa', 'ab', 'oyj', 'spa', 'holdings', 'holding', 'group', 'class', 'cl', 'the', 'adr', 'sps', 'a', 'b', 'h']);
const nameKey = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !corporate.has(w)).join(' ');
const tickerRoot = (s: string) => s.toUpperCase().split(/[.\s]/)[0] ?? '';
/** The words of a company name a page about it must contain: the name without corporate suffixes, lower case. */
export const companyMention = (name: string) => nameKey(name) || name.toLowerCase();
/** The funds whose file lists this name: the same name without corporate suffixes, or the same ticker root and first name word. A loose match for the candidate pool only. */
export function fundsHolding(name: { symbol: string; name: string }, holdings: readonly Holding[]): string[] {
  const key = nameKey(name.name), first = key.split(' ')[0];
  return [...new Set(holdings.filter(h => { const hk = nameKey(h.name); return hk === key || (tickerRoot(h.ticker) === tickerRoot(name.symbol) && hk.split(' ')[0] === first); }).map(h => h.fund))].sort();
}
