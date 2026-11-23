import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { definitionTerms, isPublicHttpsUrl, labelSourcePolicy, levelKeys, type Heading } from '@open-foresight/core';
import type { StructuredGenerator } from '@open-foresight/agents';
import type { StoredPage, WebPageStore } from '@open-foresight/data';
import type { DiscoveryResult } from '@open-foresight/llm';
import {
  assembleRelease, checkSheet, checkSheetCsv, checkSheetSchema, companyMention, defaultLabelSeed, flawedFileSchema, flawLabelSchema, hashRecords, humanCheckSchema,
  kpiLabelSchema, labelFileSchema, parseHoldings, pickKpiPairs, pickRelevanceNames, planFlawed, recordedPagesSchema, recordedResponsesSchema, recordedSearchesSchema,
  recordHumanCheck, relevanceLabelSchema, releaseExtractSchema, releaseKinds, releaseThemeIds, releaseThemes, sourcesFileSchema, syntheticLabelExtract,
  syntheticLabelResponses, syntheticLabelSources, uuidFrom, windowStart,
  type FlawedFile, type Holding, type HumanCheck, type LabelFile, type LabelNote, type ManifestKind, type Passage, type RecordedResponses, type ReleaseExtract,
  type SourceEntry, type SourcesFile, type ThemeId, type WebSource,
} from '@open-foresight/evals';
import { loadPrompt, render } from '@open-foresight/prompts';

export type ThemeRun = { theme: ThemeId; runId: string };
/** A stored web page as the label generator reads it back. */
export type StoredSource = { id: string; url: string; finalUrl: string; fetchedAt: Date; rawSha256: string; text: string; headings: Heading[] };
/** Where label source pages are stored: `label_sources` when live, memory for the offline fixture. */
export type LabelPageStore = WebPageStore & { byUrl(url: string): Promise<StoredSource | undefined> };
/** One row of `label_source_attempts`. */
export type SourceAttempt = {
  id: string; subjectKind: ManifestKind; subjectId: string; issuerKey: string; entityName: string; outcome: SourceEntry['outcome'];
  candidates: string[]; rejected: SourceEntry['rejected']; promptVersion: string; result: DiscoveryResult | null; error: string | null;
};
/** The Postgres and network half of a live command. It is opened only after every gate has passed, and only with what the command needs. */
export type LiveSession = {
  extract(input: { snapshotIds: readonly string[]; runs: readonly ThemeRun[]; parts: ReadonlyArray<'scores' | 'names'>; holdings: readonly Holding[] }): Promise<ReleaseExtract>;
  /** Saves the copies in cancelled fixture runs and proves the Reviewer loads each with the passages planned. Saving the same plan again changes nothing. */
  saveFlawed(file: FlawedFile): Promise<{ inserted: number; existing: number }>;
  /** The cancelled run that audits the labeller calls on these snapshots. */
  labelRun(snapshotIds: readonly string[]): Promise<string>;
  /** The labeller route through the gateway, when the session was opened to label. */
  generator: StructuredGenerator | null;
  /** The web search model of report discovery, when the session was opened to collect sources. */
  discoverer: { model: string; discover(prompt: string): Promise<DiscoveryResult> } | null;
  pages: LabelPageStore;
  recordAttempt(attempt: SourceAttempt): Promise<void>;
  /** The stored copies with these ids, to check that a label cites what the store holds. */
  storedSources(ids: readonly string[]): Promise<Array<{ id: string; rawSha256: string; text: string }>>;
  fetch: typeof fetch;
  close(): Promise<void>;
};
export type LabelsDeps = {
  open(input: { databaseUrl: string; apiKey: string | null; use: 'store' | 'search' | 'label' }): Promise<LiveSession>;
  /** The labeller route and every other route, from config/models.ts. The others are the scorers and the Reviewer the labels will judge. */
  routes: { labeller: { model: string }; others: ReadonlyArray<{ model: string }> };
  /** The frozen issuer files of docs/reference. */
  referenceDir: string;
};
export type LabelsResult = { code: number; stdout: string; stderr: string };
type Env = Readonly<Record<string, string | undefined>>;

export const labelsUsage = `Usage: phase2-labels.ts <command> [--work <dir>] ...
  build-flawed --snapshot <id>... --run <theme>=<runId>... [--seed N] [--flawed 100] [--clean 100] --yes-write
  collect-sources --manifest-kind kpi|reviewer|relevance [--snapshot <id>... --run <theme>=<runId>...] [--seed N] [--count N] --yes-spend
  label --manifest-kind kpi|reviewer|relevance [--snapshot <id>... --run <theme>=<runId>...] [--seed N] [--count N] [--concurrency 4] --yes-spend
  sample-human [--seed N]
  record-human-check --kind kpi|reviewer|relevance --sheet <returned.csv> --reviewer <name>...
  assemble --out <dir> [--allow-fixture]
  fixture --out <dir>                    writes a recorded extract, web searches, pages and labeller answers for the offline path
Offline path: add --from <extract.json> to build-flawed, collect-sources and label, --searches and --pages to collect-sources, and --responses to label.
Themes: ${releaseThemeIds.join(', ')}. Give one --run per theme or more, and --snapshot for every snapshot those runs use.`;

type Options = {
  command: string; work: string; snapshots: string[]; runs: ThemeRun[]; seed: number; flawed: number; clean: number; count?: number;
  manifestKind?: ManifestKind; kind?: ManifestKind; from?: string; responses?: string; searches?: string; pages?: string; sheet?: string; reviewers: string[]; out?: string;
  yesSpend: boolean; yesWrite: boolean; allowFixture: boolean; concurrency: number;
};

class UsageError extends Error {}
const themeIds = new Set<string>(releaseThemeIds);
function parseOptions(args: readonly string[]): Options {
  const [command, ...rest] = args;
  if (!command || command.startsWith('--')) throw new UsageError('Name a command.');
  const o: Options = { command, work: 'docs/evaluation/labelling', snapshots: [], runs: [], seed: defaultLabelSeed, flawed: 100, clean: 100, reviewers: [], yesSpend: false, yesWrite: false, allowFixture: false, concurrency: 4 };
  const value = (i: number) => { const v = rest[i + 1]; if (v === undefined || v.startsWith('--')) throw new UsageError(`${rest[i]} needs a value.`); return v; };
  const whole = (i: number, min: number) => { const n = Number(value(i)); if (!Number.isSafeInteger(n) || n < min) throw new UsageError(`${rest[i]} takes a whole number of at least ${min}.`); return n; };
  const kind = (i: number) => { const v = value(i); if (!(releaseKinds as readonly string[]).includes(v)) throw new UsageError(`${rest[i]} takes kpi, reviewer or relevance.`); return v as ManifestKind; };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--work') o.work = value(i++);
    else if (a === '--snapshot') o.snapshots.push(value(i++));
    else if (a === '--run') {
      const [theme, runId] = value(i++).split('=');
      if (!themeIds.has(theme ?? '') || !runId) throw new UsageError(`--run takes <theme>=<runId>, with a theme of ${releaseThemeIds.join(', ')}.`);
      o.runs.push({ theme: theme as ThemeId, runId });
    } else if (a === '--seed') o.seed = whole(i++, 0);
    else if (a === '--flawed') o.flawed = whole(i++, 1);
    else if (a === '--clean') o.clean = whole(i++, 1);
    else if (a === '--count') o.count = whole(i++, 1);
    else if (a === '--concurrency') o.concurrency = Math.min(whole(i++, 1), 16);
    else if (a === '--manifest-kind') o.manifestKind = kind(i++);
    else if (a === '--kind') o.kind = kind(i++);
    else if (a === '--from') o.from = value(i++);
    else if (a === '--responses') o.responses = value(i++);
    else if (a === '--searches') o.searches = value(i++);
    else if (a === '--pages') o.pages = value(i++);
    else if (a === '--sheet') o.sheet = value(i++);
    else if (a === '--reviewer') o.reviewers.push(value(i++));
    else if (a === '--out') o.out = value(i++);
    else if (a === '--yes-spend') o.yesSpend = true;
    else if (a === '--yes-write') o.yesWrite = true;
    else if (a === '--allow-fixture') o.allowFixture = true;
    else throw new UsageError(`Unknown argument ${a}.`);
  }
  return o;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
function writeJson(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}
const snapshotsOf = (runs: ReadonlyArray<{ snapshotId: string }>) => [...new Set(runs.map(r => r.snapshotId))].sort();
const vendorOf = (model: string) => model.slice(0, model.indexOf('/')).toLowerCase();
const scorerVendors = (deps: LabelsDeps) => [...new Set(deps.routes.others.map(r => vendorOf(r.model)))].sort();
const defaultCount: Record<'kpi' | 'relevance', number> = { kpi: 200, relevance: 500 };
const prompts = { kpi: ['labeller-kpi', 'kpi_label'], reviewer: ['labeller-flaw', 'flaw_label'], relevance: ['labeller-relevance', 'relevance_label'] } as const;
/** The version of the web search question below. Stored with every attempt. */
export const sourceSearchPromptVersion = 'label-source-search@v1';
/** A generic client name, so no personal detail goes to a site. The fetcher obeys robots.txt and spaces requests per host. */
const userAgent = 'open-foresight-educational';

const blocked = (reasons: string[], extra = '') => ({ code: 1, stdout: '', stderr: `BLOCKED: ${reasons.join('; ')}. No model or search call was made and nothing was written.${extra}\n` });
const fail = (message: string) => ({ code: 1, stdout: '', stderr: `FAIL ${message}\n` });

/** What a live command still lacks. Each is checked before any database, gateway or search code loads. */
function liveBlockers(o: Options, env: Env, needs: { key?: boolean; snapshot?: boolean; flag: '--yes-spend' | '--yes-write' }): string[] {
  const out: string[] = [];
  if (needs.key && !env.OPENROUTER_API_KEY?.trim()) out.push('OPENROUTER_API_KEY is not set');
  if (!env.DATABASE_URL?.trim()) out.push('DATABASE_URL is not set');
  if (needs.snapshot) {
    if (o.snapshots.length === 0) out.push('no --snapshot was given');
    const missing = releaseThemeIds.filter(t => !o.runs.some(r => r.theme === t));
    if (missing.length) out.push(`no --run for ${missing.join(', ')}`);
  }
  if (needs.flag === '--yes-spend' && !o.yesSpend) out.push('--yes-spend was not given, so no paid call is allowed');
  if (needs.flag === '--yes-write' && !o.yesWrite) out.push('--yes-write was not given, so no fixture score is written to the database');
  return out;
}

function readExtract(path: string): ReleaseExtract {
  const extract = releaseExtractSchema.parse(readJson(path));
  if (!extract.fixture) throw new Error(`${path} is not marked as a fixture. Live data is read from the database, never from a file.`);
  return extract;
}

async function withSession<T>(deps: LabelsDeps, env: Env, use: 'store' | 'search' | 'label', work: (s: LiveSession) => Promise<T>): Promise<T> {
  const session = await deps.open({ databaseUrl: env.DATABASE_URL!, apiKey: use === 'store' ? null : env.OPENROUTER_API_KEY!, use });
  try { return await work(session); } finally { await session.close(); }
}

async function buildFlawed(o: Options, env: Env, deps: LabelsDeps): Promise<LabelsResult> {
  if (!o.from) {
    const reasons = liveBlockers(o, env, { snapshot: true, flag: '--yes-write' });
    if (reasons.length) return blocked(reasons);
  }
  const path = join(o.work, 'flawed.json');
  if (existsSync(path)) return fail(`${path} already exists. Labels may have been built from it, so move it away to build again.`);
  const run = async (session: LiveSession | null) => {
    const extract = session ? await session.extract({ snapshotIds: o.snapshots, runs: o.runs, parts: ['scores'], holdings: [] }) : readExtract(o.from!);
    const plan = planFlawed(extract, { seed: o.seed, flawed: o.flawed, clean: o.clean });
    const lines = releaseThemeIds.map(t => `  ${t}: ${(['wrong_issuer', 'stale_evidence', 'talk_without_numbers', 'none'] as const).map(f => `${f} ${plan.file.items.filter(i => i.theme === t && i.flaw === f).length}`).join(', ')}`);
    const summary = `Snapshots ${snapshotsOf(extract.runs).join(', ')}${extract.fixture ? ' (fixture)' : ''}, seed ${o.seed}: ${plan.file.pool} eligible base scores.\n${lines.join('\n')}\n`;
    if (plan.shortages.length) return { code: 1, stdout: summary, stderr: `FAIL the snapshot cannot fill every theme and flaw, so nothing was written:\n${plan.shortages.map(s => `  - ${s}`).join('\n')}\n` };
    const saved = session ? await session.saveFlawed(plan.file) : null;
    mkdirSync(o.work, { recursive: true });
    writeJson(path, plan.file);
    const where = saved ? `Saved ${saved.inserted} kpi_scores rows (${saved.existing} already present) in ${plan.file.runs.length} cancelled fixture run(s), which can never be packaged.` : 'Fixture: no database row was written.';
    return { code: 0, stdout: `${summary}${where}\nWrote ${path}\n`, stderr: '' };
  };
  return o.from ? run(null) : withSession(deps, env, 'store', run);
}

type Local = ReadonlyArray<readonly [string, Passage]>;
type LabelRecord = LabelFile['records'][number];
/** A web passage as one label shows it. */
type ShownWeb = { label: string; source: WebSource; passage: WebSource['passages'][number] };
/** What the labeller answered, read through the kind's schema. `outcome` is the record, or why a contradicted record is dropped. */
type Parsed = { evidence: string[]; rationale: string; outcome(labelledBy: string): { record: LabelRecord } | { drop: string } };
/**
 * One thing to label: a reviewer record, a KPI pair or a name. `topic` says what a web page about it should cover, for the search
 * question and to choose the passages of a stored page. `local` are the store passages shown with their labels.
 */
type Subject = {
  id: string; company: string; symbol: string; issuerKey: string | null; topic: string; subject: string; local: Local; evidenceIds: string[];
  schema: Parameters<StructuredGenerator['generate']>[0]['schema']; user(webPassages: string): string; parse(raw: unknown): Parsed;
};

const kindLabel: Record<Passage['docKind'], string> = { sec_filing: 'SEC filing', esef_filing: 'ESEF report', web_report: 'Company report', company_profile: 'Company profile' };
const unique = (ids: readonly string[]) => [...new Set(ids)];
const rubricText = (rubric: { levels: Record<'0' | '1' | '2' | '3' | '4', string> }) => levelKeys.map(l => `${l}: ${rubric.levels[l]}`).join('\n');
const joinPassages = (parts: string[], none: string) => (parts.length ? parts.join('\n\n---\n\n') : none);

function reviewerSubjects(file: FlawedFile, prompt: ReturnType<typeof loadPrompt>): Subject[] {
  return file.items.map(item => {
    const local = [...new Map(item.citations.map(c => [c.chunkId, [c.evidenceId, item.passages.find(p => p.chunkId === c.chunkId)!] as const])).values()];
    const evidenceIds = unique(item.citations.map(c => c.chunkId));
    return {
      id: item.id, company: item.company, symbol: item.symbol, issuerKey: item.issuerKeys[0] ?? null, local, evidenceIds, schema: flawLabelSchema,
      topic: `its ${item.kpi.name.toLowerCase()}: ${item.kpi.definition}`, subject: `${item.kpi.name}, level ${item.level}`,
      user: web => render(prompt.user, {
        company: item.company, symbol: item.symbol, issuers: item.issuerKeys.join(', ') || '(none recorded)', as_of: item.asOf,
        kpi_name: item.kpi.name, definition: item.kpi.definition, lookback_days: String(item.kpi.lookbackDays), window_start: windowStart(item.asOf, item.kpi.lookbackDays),
        rubric: rubricText(item.kpi.rubric), level: item.level, web_passages: web,
        passages: joinPassages(local.map(([label, p]) => `[${label}] issuer ${p.issuerKey} | available ${p.availableOn} | ${p.section}\n${p.text}`), '(none)'),
      }),
      parse(raw) {
        const out = flawLabelSchema.parse(raw);
        return {
          evidence: out.evidence, rationale: out.rationale,
          outcome: labelledBy => (out.flaw !== item.flaw
            ? { drop: `contradicted: the labeller found ${out.flaw}, the record carries ${item.flaw}` }
            : { record: { id: item.id, theme: item.theme, symbol: item.symbol, snapshotId: item.snapshotId, kpiId: item.kpiId, flaw: item.flaw, labelledBy, evidenceIds } }),
        };
      },
    };
  });
}

function kpiSubjects(extract: ReleaseExtract, picked: ReturnType<typeof pickKpiPairs>['picked'], prompt: ReturnType<typeof loadPrompt>): Subject[] {
  const byId = new Map(extract.passages.map(p => [p.chunkId, p]));
  const snapshotOf = new Map(extract.runs.map(r => [r.runId, r.snapshotId]));
  return picked.map(s => {
    const local = s.offered.map(o => [o.id, byId.get(o.chunkId)!] as const);
    const evidenceIds = unique(local.map(([, p]) => p.chunkId));
    return {
      id: s.id, company: s.company, symbol: s.symbol, issuerKey: s.issuerKeys[0] ?? null, local, evidenceIds, schema: kpiLabelSchema,
      topic: `its ${s.kpi.name.toLowerCase()}: ${s.kpi.definition}`, subject: s.kpi.name,
      user: web => render(prompt.user, {
        company: s.company, symbol: s.symbol, as_of: s.asOf, kpi_name: s.kpi.name, definition: s.kpi.definition, rubric: rubricText(s.kpi.rubric), unknown_rule: s.kpi.rubric.unknown, web_passages: web,
        passages: joinPassages(local.map(([label, p]) => `[${label}] ${kindLabel[p.docKind]} available ${p.availableOn} | ${p.section}\n${p.text}`), '(none)'),
      }),
      parse(raw) {
        const out = kpiLabelSchema.parse(raw);
        return { evidence: out.evidence, rationale: out.rationale, outcome: labelledBy => ({ record: { id: s.id, theme: s.theme, symbol: s.symbol, snapshotId: snapshotOf.get(s.runId)!, kpiId: s.kpiId, level: out.level, labelledBy, evidenceIds } }) };
      },
    };
  });
}

function relevanceSubjects(extract: ReleaseExtract, picked: ReturnType<typeof pickRelevanceNames>['picked'], prompt: ReturnType<typeof loadPrompt>): Subject[] {
  const byId = new Map(extract.passages.map(p => [p.chunkId, p]));
  const runOf = new Map(extract.runs.map(r => [r.runId, r]));
  return picked.map(n => {
    const theme = releaseThemes.find(t => t.id === n.theme)!;
    const local = n.passageIds.map((cid, i) => [`p${i + 1}`, byId.get(cid)!] as const);
    const id = `${n.theme}:${n.symbol}`, evidenceIds = unique(n.passageIds);
    return {
      id, company: n.name, symbol: n.symbol, issuerKey: n.issuerKeys[0] ?? null, local, evidenceIds, schema: relevanceLabelSchema,
      topic: `what it makes or sells, in relation to ${theme.name}: ${theme.description}`, subject: theme.name,
      user: web => render(prompt.user, {
        theme_name: theme.name, theme_description: theme.description, company: n.name, symbol: n.symbol, as_of: runOf.get(n.runId)!.asOf, web_passages: web,
        passages: joinPassages(local.map(([l, p]) => `[${l}] ${kindLabel[p.docKind]} available ${p.availableOn} | ${p.section}\n${p.text}`), '(none: the local store has no filing or report text for this company)'),
      }),
      parse(raw) {
        const out = relevanceLabelSchema.parse(raw);
        return { evidence: out.evidence, rationale: out.rationale, outcome: labelledBy => ({ record: { id, theme: n.theme, symbol: n.symbol, snapshotId: runOf.get(n.runId)!.snapshotId, relevant: out.relevant, labelledBy, evidenceIds } }) };
      },
    };
  });
}

function readHoldings(dir: string): Holding[] {
  const files: Record<string, string> = { GRID: 'grid-holdings-2026-11-20.csv', ICLN: 'icln-holdings-2026-11-20.csv', CIBR: 'cibr-holdings-2026-11-20.csv', BOTZ: 'botz-holdings-2026-11-20.csv' };
  return Object.entries(files).flatMap(([fund, file]) => parseHoldings(fund, readFileSync(join(dir, file), 'utf8')));
}

type Inputs = { kind: ManifestKind; flawed: FlawedFile | null; fixture: boolean; requested: number };
/** The labelling inputs every subject command shares. The reviewer subjects come from `flawed.json`, so they carry their own fixture mark. */
function inputs(o: Options): Inputs | LabelsResult {
  const kind = o.manifestKind;
  if (!kind) return { code: 2, stdout: '', stderr: `${o.command} needs --manifest-kind.\n${labelsUsage}\n` };
  const flawedPath = join(o.work, 'flawed.json');
  if (kind === 'reviewer' && !existsSync(flawedPath)) return fail(`${flawedPath} does not exist. Run build-flawed first.`);
  const flawed = kind === 'reviewer' ? flawedFileSchema.parse(readJson(flawedPath)) : null;
  return { kind, flawed, fixture: flawed ? flawed.fixture : Boolean(o.from), requested: flawed ? flawed.items.length : o.count ?? defaultCount[kind as 'kpi' | 'relevance'] };
}

/** The subjects of one kind, chosen exactly as `label` chooses them, so the sources collected are the ones labelled. */
async function subjectsOf(o: Options, input: Inputs, session: LiveSession | null, deps: LabelsDeps, prompt: ReturnType<typeof loadPrompt>):
  Promise<{ subjects: Subject[]; snapshotIds: string[]; sampling: LabelFile['sampling'] } | LabelsResult> {
  if (input.flawed) {
    const f = input.flawed;
    return { subjects: reviewerSubjects(f, prompt), snapshotIds: snapshotsOf(f.runs), sampling: { seed: f.seed, requested: f.requested.flawed + f.requested.clean, pool: f.pool } };
  }
  const extract = session
    ? await session.extract({ snapshotIds: o.snapshots, runs: o.runs, parts: [input.kind === 'kpi' ? 'scores' : 'names'], holdings: input.kind === 'relevance' ? readHoldings(deps.referenceDir) : [] })
    : readExtract(o.from!);
  const pick = { seed: o.seed, count: input.requested };
  const selected = input.kind === 'kpi'
    ? (s => ({ ...s, subjects: kpiSubjects(extract, s.picked, prompt) }))(pickKpiPairs(extract, pick))
    : (s => ({ ...s, subjects: relevanceSubjects(extract, s.picked, prompt) }))(pickRelevanceNames(extract, pick));
  if (selected.shortages.length) return fail(`the snapshot cannot fill the ${input.kind} sample, so no call was made:\n${selected.shortages.map(s => `  - ${s}`).join('\n')}`);
  return { subjects: selected.subjects, snapshotIds: snapshotsOf(extract.runs), sampling: { seed: o.seed, requested: input.requested, pool: selected.pool } };
}

/** The web search question for one subject. The model only proposes URLs. Code checks, fetches and stores every page. */
const searchQuestion = (s: Subject) => `Find up to ${labelSourcePolicy.maxUrls} public web pages about ${s.company} (${s.symbol}) that describe ${s.topic} Prefer the company's own investor relations, annual report and product pages, then reputable news. Do not use a login, a paywall, social media or a search results page. Answer with JSON only: {"candidates":[{"url":"https://..."}]}`;

/** The two chunks of a stored page that share the most words with the subject's topic, or its first chunk when none does. */
function webPassages(chunkText: typeof import('@open-foresight/retrieval').chunkText, chunker: string, page: StoredSource, topic: string): WebSource['passages'] {
  const terms = new Set(definitionTerms(topic));
  const chunks = chunkText({ text: page.text, headings: page.headings }).map(c => ({ c, score: new Set(definitionTerms(c.text).filter(t => terms.has(t))).size }));
  const best = chunks.filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.c.ordinal - b.c.ordinal).slice(0, 2);
  return (best.length ? best : chunks.slice(0, 1)).sort((a, b) => a.c.ordinal - b.c.ordinal)
    .map(({ c }) => ({ id: uuidFrom('label-source-passage', page.id, chunker, String(c.ordinal)), start: c.start, end: c.end, text: page.text.slice(c.start, c.end) }));
}

export function memoryPageStore(): LabelPageStore {
  const rows: StoredSource[] = [];
  return {
    previous: async url => (rows.some(x => x.url === url) ? { etag: null, lastModified: null } : undefined),
    async save(page: StoredPage) {
      if (rows.some(r => r.url === page.url && r.rawSha256 === page.rawSha256)) return null;
      const row: StoredSource = { id: uuidFrom('label-source', page.url, page.rawSha256), url: page.url, finalUrl: page.finalUrl, fetchedAt: page.fetchedAt, rawSha256: page.rawSha256, text: page.text, headings: page.headings as Heading[] };
      rows.push(row);
      return row.id;
    },
    byUrl: async url => rows.filter(r => r.url === url).at(-1),
  };
}

/** A web of recorded answers: a URL that is not listed, robots.txt included, answers 404. */
const recordedFetch = (pages: Record<string, { status: number; contentType?: string; body?: string }>): typeof fetch => async input => {
  const page = pages[new URL(String(input)).href];
  return new Response(page?.body ?? null, { status: page?.status ?? 404, headers: page?.contentType ? { 'content-type': page.contentType } : {} });
};

async function collectSources(o: Options, env: Env, deps: LabelsDeps): Promise<LabelsResult> {
  const input = inputs(o);
  if ('code' in input) return input;
  const { kind, fixture } = input;
  if (fixture && (!o.searches || !o.pages)) return blocked(['fixture data collects sources only from recorded searches and pages, and --searches or --pages was not given']);
  if (!fixture && (o.searches || o.pages)) return fail('recorded searches and pages are only for fixture data. Drop --searches and --pages to search live.');
  const path = join(o.work, `sources-${kind}.json`);
  const existing = existsSync(path) ? sourcesFileSchema.parse(readJson(path)) : null;
  if (existing && (existing.kind !== kind || existing.fixture !== fixture || existing.promptVersion !== sourceSearchPromptVersion)) return fail(`${path} was collected for other data or with another question. Move it away to collect again.`);
  const kept = (e: SourceEntry) => e.outcome !== 'error';
  if (!fixture) {
    const reasons = liveBlockers(o, env, { key: true, snapshot: kind !== 'reviewer', flag: '--yes-spend' });
    const done = Object.values(existing?.entries ?? {}).filter(kept).length;
    const left = input.flawed ? input.flawed.items.length - done : Math.max(0, input.requested - done);
    if (reasons.length) return blocked(reasons, ` A run would make about ${left} web search call(s), at most ${left * 2} if no provider serves zero data retention, and fetch up to ${left * labelSourcePolicy.maxUrls} page(s).`);
  }
  const prompt = loadPrompt(prompts[kind][0], 'v1');
  const run = async (session: LiveSession | null): Promise<LabelsResult> => {
    const chosen = await subjectsOf(o, input, session, deps, prompt);
    if ('code' in chosen) return chosen;
    const [{ createWebReportsProvider }, { CHUNKER_VERSION, chunkText }, { parseCandidates }] = await Promise.all([import('@open-foresight/data'), import('@open-foresight/retrieval'), import('@open-foresight/agents')]);
    const searches = o.searches ? recordedSearchesSchema.parse(readJson(o.searches)).searches : null;
    const pages = session ? session.pages : memoryPageStore();
    const model = session ? session.discoverer!.model : 'fixture/recorded-search';
    const search = async (s: Subject): Promise<DiscoveryResult> => {
      if (session) return session.discoverer!.discover(searchQuestion(s));
      const answer = searches![`${kind}:${s.id}`];
      if (!answer) throw new Error('no recorded search');
      return { ...answer, cost: 0, usage: null, latencyMs: 0, params: {} };
    };
    const fetcher = createWebReportsProvider({
      userAgent, hostAllowed: url => isPublicHttpsUrl(url), store: pages, maxBytes: labelSourcePolicy.maxBytes,
      fetch: session ? session.fetch : recordedFetch(recordedPagesSchema.parse(readJson(o.pages!)).pages),
      ...(session ? {} : { minDelayMs: 0, now: () => new Date('2026-11-24T09:00:00.000Z') }),
    });
    const entries: SourcesFile['entries'] = { ...existing?.entries };
    const todo = chosen.subjects.filter(s => !entries[s.id] || !kept(entries[s.id]!));
    const out = [`Collecting web sources for ${todo.length} of ${chosen.subjects.length} ${kind} subjects with ${model}: about ${todo.length} web search call(s), at most ${todo.length * 2} if no provider serves zero data retention, and up to ${todo.length * labelSourcePolicy.maxUrls} page fetch(es).`];
    const save = () => writeJson(path, sourcesFileSchema.parse({ schemaVersion: 1, kind, fixture, promptVersion: sourceSearchPromptVersion, entries }));
    mkdirSync(o.work, { recursive: true });

    const collect = async (s: Subject): Promise<SourceEntry> => {
      const entry = (outcome: SourceEntry['outcome'], more: Partial<SourceEntry> = {}): SourceEntry => ({ outcome, attemptId: null, model: null, provider: null, zdr: null, candidates: [], rejected: [], error: null, sources: [], ...more });
      if (!s.issuerKey) return entry('no_issuer');
      const attemptId = session ? randomUUID() : uuidFrom('label-source-attempt', kind, s.id);
      const finish = async (outcome: SourceEntry['outcome'], result: DiscoveryResult | null, more: Partial<SourceEntry> = {}) => {
        const e = entry(outcome, { attemptId, model: result?.model ?? model, provider: result?.provider ?? null, zdr: result?.zdr ?? null, ...more });
        await session?.recordAttempt({ id: attemptId, subjectKind: kind, subjectId: s.id, issuerKey: s.issuerKey!, entityName: s.company, outcome, candidates: e.candidates, rejected: e.rejected, promptVersion: sourceSearchPromptVersion, result, error: e.error });
        return e;
      };
      let result: DiscoveryResult;
      try { result = await search(s); }
      catch (error) { return finish('error', null, { error: error instanceof Error ? error.message : String(error) }); }
      const parsed = parseCandidates(result.text);
      if ('error' in parsed) return finish('error', result, { error: parsed.error });
      const candidates = parsed.urls.slice(0, labelSourcePolicy.maxUrls);
      if (candidates.length === 0) return finish('no_candidates', result);
      const rejected: SourceEntry['rejected'] = candidates.filter(u => !isPublicHttpsUrl(u)).map(url => ({ url, reason: 'not_public_https' }));
      const urls = candidates.filter(u => isPublicHttpsUrl(u));
      const fetched = urls.length ? await fetcher.sync({ issuerKey: s.issuerKey, entityName: s.company, mustMention: [companyMention(s.company)], urls, attemptId }) : { stored: [], unchanged: [], rejected: [] };
      rejected.push(...fetched.rejected);
      const stored = await Promise.all([...fetched.stored.map(x => x.url), ...fetched.unchanged].map(u => { const at = new URL(u); at.hash = ''; return pages.byUrl(at.href); }));
      const sources = [...new Map(stored.flatMap(p => (p ? [[p.id, p] as const] : []))).values()].map(p => ({
        sourceId: p.id, url: p.url, finalUrl: p.finalUrl, fetchedAt: p.fetchedAt.toISOString(), sha256: p.rawSha256, passages: webPassages(chunkText, CHUNKER_VERSION, p, s.topic),
      }));
      return finish(sources.length ? 'stored' : 'all_rejected', result, { candidates, rejected, sources });
    };

    let next = 0, savedAt = 0;
    await Promise.all(Array.from({ length: Math.min(o.concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const s = todo[next++]!;
        entries[s.id] = await collect(s);
        if (Date.now() - savedAt > 2000) { save(); savedAt = Date.now(); }
      }
    }));
    save();
    const all = chosen.subjects.map(s => entries[s.id]!);
    const tally = (['stored', 'no_candidates', 'all_rejected', 'no_issuer', 'error'] as const).map(k => `${k} ${all.filter(e => e.outcome === k).length}`).join(', ');
    out.push(`Sources: ${tally}. ${all.filter(e => e.zdr === false).length} search(es) ran without zero data retention.`, `Wrote ${path}`);
    if (all.some(e => e.outcome === 'error')) out.push('Rerun the same command to retry the searches that failed.');
    return { code: all.some(e => e.outcome === 'error') ? 1 : 0, stdout: `${out.join('\n')}\n`, stderr: '' };
  };
  return fixture ? run(null) : withSession(deps, env, 'search', run);
}

const noSourceReason = (e: SourceEntry) => ({
  stored: 'the stored copy is missing from the store or changed', no_issuer: 'no issuer key, so no page could be stored for it', no_candidates: 'the search proposed no page',
  all_rejected: `every proposed page was rejected: ${e.rejected.map(r => `${r.url} ${r.reason}`).join('; ') || 'none stored'}`, error: `the search failed: ${e.error ?? 'unknown'}`,
}[e.outcome]);

async function label(o: Options, env: Env, deps: LabelsDeps): Promise<LabelsResult> {
  const input = inputs(o);
  if ('code' in input) return input;
  const { kind, fixture } = input;
  if (fixture && !o.responses) return blocked(['fixture data is labelled only from recorded answers, and no --responses was given']);
  if (!fixture && o.responses) return fail('recorded answers label only fixture data. Drop --responses to label live data.');
  const recorded: RecordedResponses | null = o.responses ? recordedResponsesSchema.parse(readJson(o.responses)) : null;
  const labeller = recorded ? recorded.labeller : { name: deps.routes.labeller.model, vendor: vendorOf(deps.routes.labeller.model), model: deps.routes.labeller.model };
  const [promptName, schemaName] = prompts[kind];
  const prompt = loadPrompt(promptName, 'v1');
  const path = join(o.work, `labels-${kind}.json`);
  const existing = existsSync(path) ? labelFileSchema.parse(readJson(path)) : null;
  const seed = input.flawed ? input.flawed.seed : o.seed;
  if (existing && (existing.kind !== kind || existing.labeller.model !== labeller.model || existing.labeller.promptVersion !== prompt.promptVersion || existing.sampling.seed !== seed)) {
    return fail(`${path} was labelled by ${existing.labeller.model} with ${existing.labeller.promptVersion} and seed ${existing.sampling.seed}. Move it away to label with ${labeller.model}, ${prompt.promptVersion} and seed ${seed}.`);
  }
  const done = new Set([...(existing?.records ?? []), ...(existing?.dropped ?? []), ...(existing?.rejected ?? [])].map(r => r.id));

  if (!fixture) {
    const reasons = liveBlockers(o, env, { key: true, snapshot: kind !== 'reviewer', flag: '--yes-spend' });
    if (scorerVendors(deps).includes(labeller.vendor)) reasons.push(`the labeller ${labeller.model} shares the vendor ${labeller.vendor} with a scorer or the Reviewer, so its labels would not be independent`);
    const left = input.flawed ? input.flawed.items.filter(i => !done.has(i.id)).length : Math.max(0, input.requested - done.size);
    if (reasons.length) return blocked(reasons, ` A run would make about ${left} ${labeller.model} call(s) and no web search.`);
  }
  const sourcesPath = join(o.work, `sources-${kind}.json`);
  if (!existsSync(sourcesPath)) return fail(`${sourcesPath} does not exist. Run collect-sources --manifest-kind ${kind} first, because every label cites the web pages stored for it.`);
  const sources = sourcesFileSchema.parse(readJson(sourcesPath));
  if (sources.fixture !== fixture) return fail(`${sourcesPath} was collected for ${sources.fixture ? 'fixture' : 'live'} data.`);

  const run = async (session: LiveSession | null): Promise<LabelsResult> => {
    const chosen = await subjectsOf(o, input, session, deps, prompt);
    if ('code' in chosen) return chosen;
    const missing = chosen.subjects.filter(s => !sources.entries[s.id]);
    if (missing.length) return fail(`${missing.length} ${kind} subject(s) have no entry in ${sourcesPath}. Run collect-sources with the same --seed and --count first.`);
    // A live label cites only a page whose stored copy still holds the bytes and the passage text it was shown.
    const ids = unique(chosen.subjects.flatMap(s => sources.entries[s.id]!.sources.map(x => x.sourceId)));
    const stored = session ? new Map((await session.storedSources(ids)).map(r => [r.id, r])) : null;
    const verified = (x: WebSource) => !stored || (stored.get(x.sourceId)?.rawSha256 === x.sha256 && x.passages.every(p => stored.get(x.sourceId)!.text.slice(p.start, p.end) === p.text));
    const webOf = (s: Subject): ShownWeb[] => sources.entries[s.id]!.sources.filter(verified).flatMap(source => source.passages.map(passage => ({ source, passage }))).map((w, i) => ({ ...w, label: `w${i + 1}` }));

    const todo = chosen.subjects.filter(s => !done.has(s.id));
    const out: string[] = [`Labelling ${todo.length} of ${chosen.subjects.length} ${kind} records with ${labeller.model} (${prompt.promptVersion})${session ? ', cache off' : ', from recorded answers'}: about ${todo.length} call(s), at most ${todo.length * 2} with one repair each. No web search is made here.`];
    const auditRunId = session ? await session.labelRun(chosen.snapshotIds) : 'fixture';
    const generatorFor = (id: string): StructuredGenerator => (session
      ? { generate: request => session.generator!.generate({ ...request, cache: false }) }
      : {
        async generate(request) {
          const raw = recorded!.responses[`${kind}:${id}`];
          if (raw === undefined) throw new Error('no recorded answer');
          return request.schema.parse(JSON.parse(raw));
        },
      });

    const records = new Map<string, LabelRecord>((existing?.records ?? []).map(r => [r.id, r]));
    const notes: Record<string, LabelNote> = { ...existing?.notes };
    const dropped = new Map((existing?.dropped ?? []).map(d => [d.id, d.reason]));
    const rejected = new Map((existing?.rejected ?? []).map(d => [d.id, d.reason]));
    const noWeb = new Map((existing?.noWebSource ?? []).map(d => [d.id, d.reason]));
    const failed = new Map<string, string>();
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const order = new Map(chosen.subjects.map((s, i) => [s.id, i]));
    let savedAt = 0;
    // Saved at most every two seconds while calls run, so a crash loses little and a large file is not rewritten per call.
    const save = (final: boolean) => {
      if (!final && Date.now() - savedAt < 2000) return null;
      const pairs = (m: Map<string, string>) => [...m].map(([id, reason]) => ({ id, reason }));
      const doc = {
        schemaVersion: 1, kind, fixture, snapshotIds: chosen.snapshotIds, labeller: { ...labeller, promptVersion: prompt.promptVersion }, sampling: chosen.sampling, createdAt,
        records: [...records.values()].sort((a, b) => order.get(a.id)! - order.get(b.id)!), notes,
        dropped: pairs(dropped), rejected: pairs(rejected), noWebSource: pairs(noWeb), failed: [...failed].map(([id, error]) => ({ id, error })),
      };
      const file = final ? labelFileSchema.parse(doc) : doc;
      writeJson(path, file);
      savedAt = Date.now();
      return file as LabelFile;
    };

    const labelOne = async (s: Subject) => {
      const web = webOf(s);
      const raw = await generatorFor(s.id).generate({
        runId: auditRunId, role: 'labeller', promptVersion: prompt.promptVersion, system: prompt.system, schemaName, schema: s.schema, maxOutputTokens: 8000,
        user: s.user(joinPassages(web.map(w => `[${w.label}] ${w.source.finalUrl} | stored copy fetched ${w.source.fetchedAt}\n${w.passage.text}`), '(none: no public web page about this company could be stored)')),
        inputEvidenceIds: [...s.evidenceIds, ...web.map(w => w.passage.id)],
      });
      const parsed = s.parse(raw);
      const shown = new Set([...s.local.map(([l]) => l), ...web.map(w => w.label)]);
      const unseen = parsed.evidence.filter(l => !shown.has(l));
      if (unseen.length) { rejected.set(s.id, `cited ${unseen.join(', ')}, which it was not shown`); return; }
      const cited = web.filter(w => parsed.evidence.includes(w.label));
      if (web.length > 0 && cited.length === 0) { rejected.set(s.id, 'cited no stored web page although it was shown one'); return; }
      const outcome = parsed.outcome(labeller.name);
      if ('drop' in outcome) { dropped.set(s.id, outcome.drop); return; }
      const webCitations = cited.map(w => ({ passageId: w.passage.id, sourceId: w.source.sourceId, url: w.source.finalUrl, fetchedAt: w.source.fetchedAt, sha256: w.source.sha256 }));
      records.set(s.id, webCitations.length ? { ...outcome.record, webCitations } : outcome.record);
      if (web.length === 0) noWeb.set(s.id, noSourceReason(sources.entries[s.id]!));
      notes[s.id] = {
        company: s.company, subject: s.subject, rationale: parsed.rationale,
        cited: unique([...s.local.filter(([l]) => parsed.evidence.includes(l)).map(([, p]) => p.chunkId), ...cited.map(w => w.passage.id)]),
        passages: [
          ...s.local.map(([l, p]) => ({ label: l, chunkId: p.chunkId, source: p.source, issuerKey: p.issuerKey, availableOn: p.availableOn, text: p.text })),
          ...web.map(w => ({ label: w.label, chunkId: w.passage.id, source: w.source.finalUrl, issuerKey: s.issuerKey!, availableOn: w.source.fetchedAt.slice(0, 10), text: w.passage.text, fetchedAt: w.source.fetchedAt, sha256: w.source.sha256 })),
        ],
      };
    };

    mkdirSync(o.work, { recursive: true });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(o.concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const s = todo[next++]!;
        try { await labelOne(s); failed.delete(s.id); } catch (error) { failed.set(s.id, error instanceof Error ? error.message : String(error)); }
        save(false);
      }
    }));
    const file = save(true)!;
    out.push(`Labelled ${file.records.length} of ${chosen.subjects.length} records, ${file.noWebSource.length} of them with no stored web page to cite. Dropped ${file.dropped.length} record(s) the labeller contradicted. Rejected ${file.rejected.length} for their citations. ${file.failed.length} failed.`);
    for (const d of file.dropped) out.push(`  dropped ${d.id}: ${d.reason}`);
    for (const r of file.rejected) out.push(`  rejected ${r.id}: ${r.reason}`);
    for (const f of file.failed) out.push(`  failed ${f.id}: ${f.error}`);
    const reasons = Object.entries(file.noWebSource.reduce<Record<string, number>>((t, n) => ({ ...t, [n.reason.split(':')[0]!]: (t[n.reason.split(':')[0]!] ?? 0) + 1 }), {}));
    if (reasons.length) out.push(`  no web source: ${reasons.map(([r, n]) => `${n} ${r}`).join('; ')}`);
    out.push(`Wrote ${path}`);
    if (file.failed.length) out.push('Rerun the same command to retry the failed records. Labelled records are kept.');
    return { code: file.failed.length ? 1 : 0, stdout: `${out.join('\n')}\n`, stderr: '' };
  };
  return fixture ? run(null) : withSession(deps, env, 'label', run);
}

function sampleHuman(o: Options): LabelsResult {
  const out: string[] = [];
  let drawn = 0;
  for (const kind of releaseKinds) {
    const path = join(o.work, `labels-${kind}.json`);
    if (!existsSync(path)) { out.push(`${kind}: no labels yet, nothing drawn`); continue; }
    const labels = labelFileSchema.parse(readJson(path));
    if (labels.failed.length) return fail(`${path} still has ${labels.failed.length} failed record(s). Rerun label for ${kind} first, so the sample is drawn from the final labels.`);
    const sheet = checkSheet(labels, o.seed);
    const jsonPath = join(o.work, `check-${kind}.json`), csvPath = join(o.work, `check-${kind}.csv`);
    if (existsSync(jsonPath)) {
      const previous = checkSheetSchema.parse(readJson(jsonPath));
      if (previous.recordsHash !== sheet.recordsHash || previous.seed !== sheet.seed) return fail(`${jsonPath} was drawn from other labels or another seed. Move it away to draw again.`);
    }
    writeJson(jsonPath, sheet);
    writeFileSync(csvPath, checkSheetCsv(sheet));
    drawn++;
    out.push(`${kind}: drew ${sheet.rows.length} of ${sheet.records} records with seed ${o.seed}. The colleague fills agree (yes or no) in ${csvPath}. Passages and stored web copies are in ${jsonPath}.`);
  }
  if (drawn === 0) return fail(`no labels in ${o.work}. Run label first.`);
  return { code: 0, stdout: `${out.join('\n')}\n`, stderr: '' };
}

function recordCheck(o: Options): LabelsResult {
  if (!o.kind || !o.sheet) return { code: 2, stdout: '', stderr: `record-human-check needs --kind and --sheet.\n${labelsUsage}\n` };
  const sheetPath = join(o.work, `check-${o.kind}.json`), labelsPath = join(o.work, `labels-${o.kind}.json`);
  if (!existsSync(sheetPath) || !existsSync(labelsPath)) return fail(`${sheetPath} or ${labelsPath} does not exist. Run label and sample-human first.`);
  const sheet = checkSheetSchema.parse(readJson(sheetPath));
  if (hashRecords(labelFileSchema.parse(readJson(labelsPath)).records) !== sheet.recordsHash) return fail(`the ${o.kind} labels changed after the sample was drawn. Run sample-human again and have the new sheet checked.`);
  const result = recordHumanCheck(sheet, readFileSync(o.sheet, 'utf8'), o.reviewers);
  if (!result.ok) return fail(`the returned sheet ${o.sheet} is not complete:\n${result.errors.map(e => `  - ${e}`).join('\n')}`);
  const path = join(o.work, `human-${o.kind}.json`);
  writeJson(path, result.check);
  return { code: 0, stdout: `${o.kind}: ${result.check.agreed} of ${result.check.n} sampled labels agreed by ${result.check.reviewers.join(', ')}.\nWrote ${path}\n`, stderr: '' };
}

function assemble(o: Options, deps: LabelsDeps): LabelsResult {
  if (!o.out) return { code: 2, stdout: '', stderr: `assemble needs --out.\n${labelsUsage}\n` };
  const labels = {} as Record<ManifestKind, LabelFile>, human: Partial<Record<ManifestKind, HumanCheck>> = {};
  for (const kind of releaseKinds) {
    const path = join(o.work, `labels-${kind}.json`);
    if (!existsSync(path)) return fail(`${path} does not exist. Run label --manifest-kind ${kind} first.`);
    labels[kind] = labelFileSchema.parse(readJson(path));
    const humanPath = join(o.work, `human-${kind}.json`);
    if (existsSync(humanPath)) human[kind] = humanCheckSchema.parse(readJson(humanPath));
  }
  if (existsSync(o.out) && readdirSync(o.out).some(n => n.endsWith('.json'))) return fail(`${o.out} already holds manifests. A manifest is immutable, so write a new set elsewhere.`);
  const result = assembleRelease({ labels, human, scorerVendors: scorerVendors(deps), createdAt: new Date().toISOString(), allowFixture: o.allowFixture });
  if (!result.ok) return fail(`the assembled set does not pass release validation, so nothing was written:\n${result.errors.map(e => `  - ${e}`).join('\n')}`);
  mkdirSync(o.out, { recursive: true });
  for (const kind of releaseKinds) writeJson(join(o.out, `${kind}.json`), result.manifests[kind]);
  const counts = releaseKinds.map(k => {
    const m = result.manifests[k];
    return `${k} ${m.records.length} records, ${m.records.filter(r => !r.webCitations?.length).length} with no web citation, ${m.humanSample!.agreed} of ${m.humanSample!.n} spot-checked labels agreed`;
  }).join('; ');
  return { code: 0, stdout: `OK wrote ${releaseKinds.length} manifests to ${o.out}: ${counts}.\nThe labels are AI generated and sample-verified by a person. Kappa against them measures agreement with AI labels, not ground truth.\n`, stderr: '' };
}

function writeFixture(o: Options): LabelsResult {
  if (!o.out) return { code: 2, stdout: '', stderr: `fixture needs --out.\n${labelsUsage}\n` };
  const extract = syntheticLabelExtract(o.seed);
  const { searches, pages } = syntheticLabelSources(extract, o.seed);
  mkdirSync(o.out, { recursive: true });
  const files = { 'extract.json': extract, 'searches.json': searches, 'pages.json': pages, 'responses.json': syntheticLabelResponses(extract, o.seed) };
  for (const [name, value] of Object.entries(files)) writeJson(join(o.out, name), value);
  return { code: 0, stdout: `Wrote ${Object.keys(files).map(n => join(o.out!, n)).join(', ')}, built by rule, not from a store, a search or a model.\n`, stderr: '' };
}

/** The release label generator. Offline commands touch only the work directory. Live ones open the database, search and gateway only after every gate passes. */
export async function runPhase2Labels(args: readonly string[], env: Env, deps: LabelsDeps): Promise<LabelsResult> {
  try {
    const o = parseOptions(args);
    switch (o.command) {
      case 'build-flawed': return await buildFlawed(o, env, deps);
      case 'collect-sources': return await collectSources(o, env, deps);
      case 'label': return await label(o, env, deps);
      case 'sample-human': return sampleHuman(o);
      case 'record-human-check': return recordCheck(o);
      case 'assemble': return assemble(o, deps);
      case 'fixture': return writeFixture(o);
      default: return { code: 2, stdout: '', stderr: `Unknown command ${o.command}.\n${labelsUsage}\n` };
    }
  } catch (error) {
    if (error instanceof UsageError) return { code: 2, stdout: '', stderr: `${error.message}\n${labelsUsage}\n` };
    return fail(error instanceof Error ? error.message : String(error));
  }
}
