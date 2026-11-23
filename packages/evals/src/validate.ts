import { hashRecords, manifestSchema, releaseProvenances, type Manifest, type ManifestKind } from './manifest.js';

/** What a release set must hold. The counts come from the spec and docs/PHASE-2-PLAN.md. */
export const releaseRequirements = {
  kpi: { minRecords: 200 },
  reviewer: { minFlawed: 100, minClean: 1 },
  relevance: { minRecords: 500 },
  minThemes: 3,
  /** The share of an AI labelled set a person must have spot checked. */
  minHumanSampleShare: 0.1,
} as const;
export const releaseKinds: readonly ManifestKind[] = ['kpi', 'reviewer', 'relevance'];

export type Validation = { ok: boolean; errors: string[]; manifest: Manifest | null };

/** Parses a manifest and checks its hash. Accepts provisional and fixture sets, which are fine for tooling but not for release. */
export function parseManifest(raw: unknown): Validation {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, manifest: null, errors: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const m = parsed.data;
  const errors: string[] = [];
  if (hashRecords(m.records) !== m.contentHash) errors.push('contentHash does not match the records: the manifest was edited in place, make a new version');
  const themes = new Set(m.themes);
  for (const r of m.records) if (!themes.has(r.theme)) { errors.push(`record ${r.id} has theme "${r.theme}" outside the manifest themes`); break; }
  const labellers = new Set(m.labellers.map(l => l.name));
  for (const r of m.records) if (!labellers.has(r.labelledBy)) { errors.push(`record ${r.id} is labelled by "${r.labelledBy}", who is not a listed labeller`); break; }
  return { ok: errors.length === 0, errors, manifest: m };
}

/** Checks one manifest against the release gate. It rejects anything missing, provisional, incomplete or not independent, and never passes it by default. */
export function validateRelease(raw: unknown, options: { allowFixture?: boolean } = {}): Validation {
  const base = parseManifest(raw);
  if (!base.manifest) return base;
  const m = base.manifest;
  const errors = [...base.errors];
  const req = releaseRequirements;
  if (m.fixture && !options.allowFixture) errors.push('this is a fixture: it verifies tooling and is not release data');
  if (!(releaseProvenances as readonly string[]).includes(m.provenance)) errors.push(`provenance "${m.provenance}" is provisional and cannot satisfy the release gate`);

  const vendors = new Set(m.scorerVendors.map(v => v.toLowerCase()));
  if (m.scorerVendors.length === 0) errors.push('scorerVendors is empty, so independence cannot be checked');
  if (m.provenance === 'ai-generated-human-sampled') {
    for (const l of m.labellers) {
      if (l.kind !== 'ai') errors.push(`labeller ${l.name} is not an AI labeller, but provenance is ai-generated-human-sampled`);
      else if (!l.vendor) errors.push(`AI labeller ${l.name} has no vendor, so independence cannot be checked`);
      else if (vendors.has(l.vendor.toLowerCase())) errors.push(`AI labeller ${l.name} is from ${l.vendor}, the vendor of a scorer or the Reviewer`);
    }
    const s = m.humanSample;
    if (!s) errors.push('no human spot check is recorded');
    else {
      if (s.reviewers.length === 0) errors.push('the human spot check names no reviewer');
      if (s.agreed > s.n) errors.push('humanSample.agreed is greater than humanSample.n');
      if (m.records.length > 0 && s.n < Math.ceil(req.minHumanSampleShare * m.records.length)) errors.push(`the human spot check covers ${s.n} of ${m.records.length} records, below ${req.minHumanSampleShare * 100}%`);
    }
  }
  if (m.provenance === 'human') {
    if (m.labellers.some(l => l.kind !== 'human')) errors.push('provenance is human, but a labeller is not a human');
    if (m.labellers.length >= 2 && m.adjudication.adjudicators.length === 0) errors.push('two or more labellers need a named adjudicator');
  }

  if (m.themes.length < req.minThemes) errors.push(`${m.themes.length} themes, ${req.minThemes} required`);
  const used = new Set(m.records.map(r => r.theme));
  for (const t of m.themes) if (!used.has(t)) errors.push(`theme "${t}" has no records`);
  if (m.sampling.pool < m.records.length) errors.push(`sampling.pool (${m.sampling.pool}) is smaller than the records (${m.records.length})`);

  if (m.kind === 'kpi' && m.records.length < req.kpi.minRecords) errors.push(`${m.records.length} KPI pairs, ${req.kpi.minRecords} required`);
  if (m.kind === 'relevance') {
    if (m.records.length < req.relevance.minRecords) errors.push(`${m.records.length} relevance labels, ${req.relevance.minRecords} required`);
    if (!m.records.some(r => r.relevant) || m.records.every(r => r.relevant)) errors.push('relevance labels need both relevant and not relevant records');
  }
  if (m.kind === 'reviewer') {
    const flawed = m.records.filter(r => r.flaw !== 'none').length;
    if (flawed < req.reviewer.minFlawed) errors.push(`${flawed} flawed scores, ${req.reviewer.minFlawed} required`);
    if (m.records.length - flawed < req.reviewer.minClean) errors.push('no clean control scores');
  }
  return { ok: errors.length === 0, errors, manifest: m };
}

/** Validates a release directory's manifests, one per kind. A missing manifest, or two of one kind, is an error. */
export function validateReleaseSet(files: ReadonlyArray<{ name: string; raw: unknown }>, options: { allowFixture?: boolean } = {}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const found = new Map<ManifestKind, string>();
  for (const { name, raw } of files) {
    const v = validateRelease(raw, options);
    errors.push(...v.errors.map(e => `${name}: ${e}`));
    if (!v.manifest) continue;
    if (found.has(v.manifest.kind)) errors.push(`${name}: a second ${v.manifest.kind} manifest, already have ${found.get(v.manifest.kind)}`);
    else found.set(v.manifest.kind, name);
  }
  for (const k of releaseKinds) if (!found.has(k)) errors.push(`missing the ${k} manifest`);
  return { ok: errors.length === 0, errors };
}
