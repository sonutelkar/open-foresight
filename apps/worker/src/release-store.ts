import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { esefReportLink, type Framework, type ResolvedCitation } from '@open-foresight/core';
import { loadReviewerInput } from '@open-foresight/agents';
import { esefFilings, kpiFrameworkVersions, kpiScores, labelSourceAttempts, labelSources, runs, runUniverse, secFilings, secSourceDocuments, securities, webDocuments } from '@open-foresight/db';
import { fundsHolding, releaseExtractSchema, releaseThemes, uuidFrom, type ExtractScore, type FlawedFile, type Holding, type Passage, type ReleaseExtract } from '@open-foresight/evals';
import { orTsQuery } from '@open-foresight/retrieval';
import type { EvidenceRef } from './labelling.js';
import type { LabelPageStore, SourceAttempt, StoredSource, ThemeRun } from './release-labels.js';

/** Donor passages kept per issuer for each injection, enough for a seeded choice without loading an issuer's whole history. */
const donorsPerIssuer = 12;
const namePassages = 4;
/** Marks every run the generator creates. Such a run is inserted and cancelled in one transaction, and a cancelled run can never move again. */
export const fixtureProfiles = { flawed: 'reviewer-flawed-fixture', labels: 'release-labels' } as const;

type ChunkRow = { id: string; doc_kind: Passage['docKind']; doc_id: string; issuer_key: string; available_on: string; section: string; start_offset: number; end_offset: number; text: string };
const columns = sql`dc.id, dc.doc_kind, dc.doc_id, dc.issuer_key, dc.available_on::text as available_on, dc.section, dc.start_offset, dc.end_offset, dc.text`;
const inSnapshot = (snapshotId: string) => sql`((dc.doc_kind = 'sec_filing' and dc.doc_id in (select filing_id from snapshot_filings where snapshot_id = ${snapshotId}::uuid))
  or (dc.doc_kind = 'esef_filing' and dc.doc_id in (select filing_id from snapshot_esef_filings where snapshot_id = ${snapshotId}::uuid))
  or (dc.doc_kind in ('web_report', 'company_profile') and dc.doc_id in (select document_id from snapshot_web_documents where snapshot_id = ${snapshotId}::uuid)))`;
const list = (values: readonly string[]) => sql.join(values.map(v => sql`${v}`), sql`, `);

async function chunks(db: PostgresJsDatabase, where: SQL): Promise<ChunkRow[]> {
  return [...await db.execute<ChunkRow>(sql`select ${columns} from document_chunks dc where ${where}`)];
}

/** Where a person reads each passage's document: the SEC or ESEF filing URL, or the report URL. */
async function withSources(db: PostgresJsDatabase, rows: readonly ChunkRow[]): Promise<Passage[]> {
  const ids = (kind: string) => [...new Set(rows.filter(r => r.doc_kind === kind).map(r => r.doc_id))];
  const sec = ids('sec_filing'), esef = ids('esef_filing'), web = [...ids('web_report'), ...ids('company_profile')];
  const urls = new Map<string, string>([
    ...(sec.length ? await db.select({ id: secFilings.id, url: secSourceDocuments.url }).from(secFilings).innerJoin(secSourceDocuments, eq(secSourceDocuments.id, secFilings.documentSourceId)).where(inArray(secFilings.id, sec)) : []).map(d => [d.id, d.url] as const),
    ...(esef.length ? await db.select({ id: esefFilings.id, url: esefFilings.reportUrl }).from(esefFilings).where(inArray(esefFilings.id, esef)) : []).map(d => [d.id, esefReportLink(d.url)] as const),
    ...(web.length ? await db.select({ id: webDocuments.id, url: webDocuments.finalUrl }).from(webDocuments).where(inArray(webDocuments.id, web)) : []).map(d => [d.id, d.url] as const),
  ]);
  return rows.map(r => ({ chunkId: r.id, docKind: r.doc_kind, docId: r.doc_id, issuerKey: r.issuer_key, availableOn: r.available_on, section: r.section, startOffset: r.start_offset, endOffset: r.end_offset, text: r.text, source: urls.get(r.doc_id) ?? `${r.doc_kind}:${r.doc_id}` }));
}

const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/**
 * Reads what labelling needs from one snapshot. Every theme run must use that snapshot and have an approved framework.
 * `scores`: the latest valid attempt per run, security and KPI on a KPI with a rubric and a known level, with the passages it cites and was shown,
 * and per issuer a few passages from before the longest lookback and a few in-window passages with no figure, as injection donors.
 * `names`: the run's included names, the reference funds that hold each, and up to four passages from its own filings or reports, best matches for the theme first.
 */
export async function loadExtract(db: PostgresJsDatabase, input: { snapshotIds: readonly string[]; runs: readonly ThemeRun[]; parts: ReadonlyArray<'scores' | 'names'>; holdings: readonly Holding[] }): Promise<ReleaseExtract> {
  const runIds = [...new Set(input.runs.map(r => r.runId))];
  const rows = await db.select({ id: runs.id, snapshotId: runs.snapshotId, frameworkVersion: runs.frameworkVersion, settings: runs.settings }).from(runs).where(inArray(runs.id, runIds));
  const versions = await db.select({ id: kpiFrameworkVersions.id, framework: kpiFrameworkVersions.framework }).from(kpiFrameworkVersions).where(inArray(kpiFrameworkVersions.id, rows.flatMap(r => (r.frameworkVersion ? [r.frameworkVersion] : []))));
  const themeRuns = input.runs.map(r => {
    const row = rows.find(x => x.id === r.runId);
    if (!row) throw new Error(`Run ${r.runId} does not exist`);
    if (!row.snapshotId || !input.snapshotIds.includes(row.snapshotId)) throw new Error(`Run ${r.runId} uses snapshot ${row.snapshotId ?? 'none'}, which is not among --snapshot ${input.snapshotIds.join(', ')}`);
    const framework = versions.find(v => v.id === row.frameworkVersion)?.framework as Framework | undefined;
    if (!framework) throw new Error(`Run ${r.runId} has no approved framework`);
    const asOf = (row.settings as { asOf?: unknown }).asOf;
    if (typeof asOf !== 'string') throw new Error(`Run ${r.runId} has no as-of date`);
    return { ...r, asOf, framework, snapshotId: row.snapshotId };
  });
  const extract: ReleaseExtract = { schemaVersion: 1, fixture: false, runs: themeRuns.map(r => ({ runId: r.runId, theme: r.theme, asOf: r.asOf, snapshotId: r.snapshotId })), scores: [], names: [], passages: [] };
  const passages = new Map<string, Passage>();
  const keep = async (found: readonly ChunkRow[]) => { for (const p of await withSources(db, found.filter(r => !passages.has(r.id)))) passages.set(p.chunkId, p); };

  if (input.parts.includes('scores')) {
    const scoreRows = await db.select({
      id: kpiScores.id, runId: kpiScores.runId, frameworkDraftId: kpiScores.frameworkDraftId, securityId: kpiScores.securityId, symbol: kpiScores.symbol, kpiId: kpiScores.kpiId,
      method: kpiScores.method, promptVersion: kpiScores.promptVersion, asOf: kpiScores.asOf, level: kpiScores.level, confidence: kpiScores.confidence, attempt: kpiScores.attempt,
      valid: kpiScores.valid, citations: kpiScores.citations, evidence: kpiScores.evidence, company: securities.name, snapshotId: kpiScores.snapshotId,
    }).from(kpiScores).innerJoin(securities, eq(securities.id, kpiScores.securityId)).where(inArray(kpiScores.runId, runIds));
    const latest = new Map<string, (typeof scoreRows)[number]>();
    for (const r of scoreRows) {
      const key = `${r.runId}|${r.securityId}|${r.kpiId}`;
      if (r.valid && (latest.get(key)?.attempt ?? 0) < r.attempt) latest.set(key, r);
    }
    const universe = await db.select({ runId: runUniverse.runId, symbol: runUniverse.symbol, issuerKeys: runUniverse.issuerKeys }).from(runUniverse).where(inArray(runUniverse.runId, runIds));
    for (const r of latest.values()) {
      const run = themeRuns.find(t => t.runId === r.runId)!;
      const kpi = run.framework.kpis.find(k => k.id === r.kpiId);
      if (!kpi || kpi.method === 'quant' || r.level === 'unknown' || r.snapshotId !== run.snapshotId) continue;
      extract.scores.push({
        id: r.id, runId: r.runId, frameworkDraftId: r.frameworkDraftId, securityId: r.securityId, symbol: r.symbol, company: r.company, kpiId: r.kpiId,
        method: kpi.method, promptVersion: r.promptVersion, asOf: r.asOf, level: r.level as ExtractScore['level'], confidence: Number(r.confidence),
        issuerKeys: (universe.find(u => u.runId === r.runId && u.symbol === r.symbol)?.issuerKeys as string[] | null) ?? [],
        kpi: { name: kpi.name, definition: kpi.definition, lookbackDays: kpi.lookbackDays, rubric: kpi.rubric },
        citations: r.citations as ResolvedCitation[], offered: (r.evidence as EvidenceRef[]).map(e => ({ id: e.id, chunkId: e.chunkId })),
      });
    }
    const referenced = [...new Set(extract.scores.flatMap(s => [...s.citations.map(c => c.chunkId), ...s.offered.map(o => o.chunkId)]))];
    for (let i = 0; i < referenced.length; i += 1000) await keep(await chunks(db, sql`dc.id in (${list(referenced.slice(i, i + 1000))})`));
    for (const run of themeRuns) {
      const issuers = [...new Set(extract.scores.filter(s => s.runId === run.runId).flatMap(s => s.issuerKeys))];
      if (issuers.length === 0) continue;
      const lookbacks = run.framework.kpis.filter(k => k.method !== 'quant').map(k => k.lookbackDays);
      const donors = (where: SQL) => db.execute<ChunkRow>(sql`select * from (select ${columns}, row_number() over (partition by dc.issuer_key order by dc.available_on desc, dc.id) as n
        from document_chunks dc where dc.issuer_key in (${list(issuers)}) and ${inSnapshot(run.snapshotId)} and ${where}) ranked where n <= ${donorsPerIssuer}`);
      await keep([...await donors(sql`dc.available_on < ${daysBefore(run.asOf, Math.max(...lookbacks))}::date and dc.text ~ '[0-9]'`)]);
      await keep([...await donors(sql`dc.available_on between ${daysBefore(run.asOf, Math.min(...lookbacks))}::date and ${run.asOf}::date and dc.text !~ '[0-9]'`)]);
    }
  }

  if (input.parts.includes('names')) {
    const names = await db.select({ runId: runUniverse.runId, symbol: runUniverse.symbol, name: runUniverse.name, issuerKeys: runUniverse.issuerKeys }).from(runUniverse)
      .where(and(inArray(runUniverse.runId, runIds), eq(runUniverse.included, true)));
    for (const n of names) {
      const run = themeRuns.find(t => t.runId === n.runId)!;
      const issuers = (n.issuerKeys as string[] | null) ?? [];
      const query = orTsQuery(releaseThemes.find(t => t.id === run.theme)!.description);
      const found = issuers.length === 0 ? [] : [...await db.execute<ChunkRow>(sql`select ${columns} from document_chunks dc
        where dc.issuer_key in (${list(issuers)}) and dc.doc_kind <> 'company_profile' and dc.available_on <= ${run.asOf}::date and ${inSnapshot(run.snapshotId)}
        order by ts_rank_cd(dc.tsv, to_tsquery('simple', ${query ?? ''})) desc, (dc.section ~* 'business|overview') desc, dc.available_on desc, dc.ordinal, dc.id limit ${namePassages}`)];
      await keep(found);
      extract.names.push({ runId: n.runId, symbol: n.symbol, name: n.name ?? n.symbol, issuerKeys: issuers, funds: fundsHolding({ symbol: n.symbol, name: n.name ?? n.symbol }, input.holdings), passageIds: found.map(f => f.id) });
    }
  }
  extract.passages = [...passages.values()];
  return releaseExtractSchema.parse(extract);
}

const reviewerBrief = 'Reviewer evaluation fixture made by apps/worker/scripts/phase2-labels.ts: copies of stored scores, some with an injected flaw. Cancelled at creation, so it is never scored or packaged.';

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
/** A cancelled run with a fixed id. It is inserted and cancelled in one transaction, so no worker ever sees it in a working status. */
async function ensureCancelledRun(tx: Tx, run: { id: string; snapshotId: string | null; frameworkVersion: string | null; modelProfile: string; settings: Record<string, unknown> }) {
  const [found] = await tx.select({ status: runs.status, modelProfile: runs.modelProfile }).from(runs).where(eq(runs.id, run.id));
  if (found) {
    if (found.status !== 'cancelled' || found.modelProfile !== run.modelProfile) throw new Error(`Run ${run.id} exists and is not a cancelled ${run.modelProfile} run`);
    return;
  }
  await tx.insert(runs).values({ id: run.id, settings: run.settings, snapshotId: run.snapshotId, frameworkVersion: run.frameworkVersion, modelProfile: run.modelProfile });
  await tx.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, run.id));
}

/**
 * Saves each planned copy as a `kpi_scores` row of a cancelled fixture run that points at its source run's approved framework, so
 * `loadReviewerInput` can load it and no basket can ever include it. The rows carry no model call, and the rationale says what they are.
 * All rows go in one transaction. A repeat of the same plan finds every row and writes nothing. Then every copy is loaded back through the
 * Reviewer's own loader and must cite exactly the planned passages, or the call throws.
 */
export async function saveFlawed(db: PostgresJsDatabase, file: FlawedFile): Promise<{ inserted: number; existing: number }> {
  const ids = file.items.map(i => i.id);
  const present = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) for (const r of await db.select({ id: kpiScores.id }).from(kpiScores).where(inArray(kpiScores.id, ids.slice(i, i + 1000)))) present.add(r.id);
  if (present.size > 0 && present.size < ids.length) throw new Error(`${present.size} of ${ids.length} planned scores already exist. This plan collides with an earlier one; build with another seed.`);
  if (present.size === 0) {
    const sources = await db.select({ id: runs.id, frameworkVersion: runs.frameworkVersion }).from(runs).where(inArray(runs.id, file.runs.map(r => r.sourceRunId)));
    await db.transaction(async tx => {
      for (const r of file.runs) {
        await ensureCancelledRun(tx, {
          id: r.fixtureRunId, snapshotId: r.snapshotId, frameworkVersion: sources.find(s => s.id === r.sourceRunId)?.frameworkVersion ?? null, modelProfile: fixtureProfiles.flawed,
          settings: { brief: reviewerBrief, fixture: fixtureProfiles.flawed, sourceRunId: r.sourceRunId, theme: r.theme, seed: file.seed },
        });
      }
      for (let i = 0; i < file.items.length; i += 200) {
        await tx.insert(kpiScores).values(file.items.slice(i, i + 200).map(item => ({
          id: item.id, runId: item.fixtureRunId, frameworkDraftId: item.frameworkDraftId, snapshotId: item.snapshotId, securityId: item.securityId, symbol: item.symbol,
          kpiId: item.kpiId, asOf: item.asOf, attempt: 1, method: item.method, promptVersion: null, llmCallId: null, level: item.level, citations: item.citations,
          rationale: `Reviewer evaluation fixture (${item.flaw === 'none' ? 'clean control' : `${item.flaw} injected`}) copied from score ${item.baseScoreId} by phase2-labels. Not a model output.`,
          conflicts: [], evidence: item.passages.map((p, n) => ({ id: item.citations.find(c => c.chunkId === p.chunkId)?.evidenceId ?? `e${n + 1}`, chunkId: p.chunkId, docKind: p.docKind, section: p.section, availableOn: p.availableOn })),
          confidence: String(item.confidence), valid: true, errors: [],
        })));
      }
    });
  }
  for (const item of file.items) {
    const { input } = await loadReviewerInput(db, item.id);
    const loaded = input.passages.map(p => `${p.chunkId}|${p.issuer}|${p.availableOn}`).sort().join(','), planned = item.passages.map(p => `${p.chunkId}|${p.issuerKey}|${p.availableOn}`).sort().join(',');
    if (loaded !== planned) throw new Error(`Score ${item.id} loads passages ${loaded}, but the plan has ${planned}`);
  }
  return { inserted: present.size === 0 ? ids.length : 0, existing: present.size };
}

/** The cancelled run that audits the labeller calls on these snapshots, so they never count toward a theme run's cost. */
export async function labelRun(db: PostgresJsDatabase, snapshotIds: readonly string[]): Promise<string> {
  const id = uuidFrom('release-labels-run', ...[...snapshotIds].sort());
  await db.transaction(tx => ensureCancelledRun(tx, {
    id, snapshotId: null, frameworkVersion: null, modelProfile: fixtureProfiles.labels,
    settings: { brief: 'Audit run for the release label generator of apps/worker/scripts/phase2-labels.ts. Cancelled at creation; it holds only labeller calls.', fixture: fixtureProfiles.labels, snapshotIds },
  }));
  return id;
}

/** Label source pages in `label_sources`. A page is never written to `web_documents`, so it is never indexed, snapshotted or read by an agent. */
export function labelPageStore(db: PostgresJsDatabase): LabelPageStore {
  const latest = (url: string) => db.select().from(labelSources).where(eq(labelSources.url, url)).orderBy(desc(labelSources.fetchedAt)).limit(1);
  return {
    previous: async url => (await latest(url))[0],
    async save(page) {
      const [row] = await db.insert(labelSources).values({
        url: page.url, finalUrl: page.finalUrl, contentType: page.contentType, byteSize: page.byteSize, rawSha256: page.rawSha256, etag: page.etag ?? null, lastModified: page.lastModified ?? null,
        text: page.text, headings: page.headings, extractor: page.extractor, issuerKey: page.issuerKey, entityName: page.entityName, fetchedAt: page.fetchedAt, attemptId: page.attemptId ?? null,
      }).onConflictDoNothing().returning({ id: labelSources.id });
      return row?.id ?? null;
    },
    async byUrl(url): Promise<StoredSource | undefined> {
      const [row] = await latest(url);
      return row && { id: row.id, url: row.url, finalUrl: row.finalUrl, fetchedAt: row.fetchedAt, rawSha256: row.rawSha256, text: row.text, headings: row.headings as StoredSource['headings'] };
    },
  };
}

/** Records one search for a label subject, whatever its outcome, with the model call it made. */
export async function recordSourceAttempt(db: PostgresJsDatabase, a: SourceAttempt): Promise<void> {
  const r = a.result;
  await db.insert(labelSourceAttempts).values({
    id: a.id, subjectKind: a.subjectKind, subjectId: a.subjectId, issuerKey: a.issuerKey, entityName: a.entityName, outcome: a.outcome, candidates: a.candidates, rejected: a.rejected,
    promptVersion: a.promptVersion, model: r?.model ?? null, provider: r?.provider ?? null, zdr: r?.zdr ?? null, params: r?.params ?? null,
    response: r ? { text: r.text, citedUrls: r.citedUrls } : null, error: a.error, tokens: r?.usage ?? null, cost: r?.cost == null ? null : String(r.cost), latencyMs: r?.latencyMs ?? null,
  });
}

/** The stored copies with these ids, with their hash and text, to check what a label cites. */
export async function storedSources(db: PostgresJsDatabase, ids: readonly string[]) {
  return ids.length ? db.select({ id: labelSources.id, rawSha256: labelSources.rawSha256, text: labelSources.text }).from(labelSources).where(inArray(labelSources.id, [...ids])) : [];
}
