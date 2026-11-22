import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  briefSchema, exchangeOf, exchanges, packageBasket, unknownModeFor, type Brief, type Framework, type Region, type ScoreLevel,
  type BasketCandidate, type BasketKpi, type SourceId,
} from '@open-foresight/core';
import { buildUniverse, fxToUsdAsOf } from '@open-foresight/data';
import {
  basketMembers, baskets, createSnapshot, esefFilingsAsOf, exchangeListings, figiMappings, filingsAsOf, kpiFrameworkVersions, kpiScores, priceBars,
  runUniverse, runs, secListings, securities,
} from '@open-foresight/db';
import { scoreFramework, type DesignerInput, type DesignerResult, type EvidenceSearcher, type StructuredGenerator } from '@open-foresight/agents';
import { issuerKeysForSecurity } from '@open-foresight/retrieval';

export type RunStatus = typeof runs.$inferSelect['status'];

export type WorkerDeps = {
  db: PostgresJsDatabase;
  design: (args: { runId: string; input: DesignerInput }) => Promise<DesignerResult>;
  gateway: StructuredGenerator;
  retriever: EvidenceSearcher;
  availableSources: readonly SourceId[];
  /** Securities scored at once. Each runs a few KPIs at once, so this multiplies the model calls in flight. Default 3. */
  scoreConcurrency?: number;
  log?: (message: string) => void;
};

/** Where a run waits for a person, and where it stops for good. */
const waiting = new Set<RunStatus>(['awaiting_kpi_approval', 'awaiting_flag_review']);
const terminal = new Set<RunStatus>(['done', 'failed', 'cancelled']);
export const needsWork = (status: RunStatus) => !waiting.has(status) && !terminal.has(status);

/** An error a retry cannot fix, such as a run with no prices in the store. The run is marked failed at once. */
export class StageFailure extends Error {}

export type AdvanceResult = { from: RunStatus; to: RunStatus; /** True when another stage can run now. False at a gate, at a terminal status, or when another worker already moved the run. */ more: boolean };

const briefOf = (settings: unknown): Brief => {
  const s = settings as Record<string, unknown>;
  return briefSchema.parse(Object.fromEntries(Object.keys(briefSchema.shape).map(k => [k, s[k]])));
};
const patchSettings = (db: PostgresJsDatabase, runId: string, patch: Record<string, unknown>) =>
  db.update(runs).set({ settings: sql`${runs.settings} || ${JSON.stringify(patch)}::jsonb` }).where(eq(runs.id, runId));

/** Moves a run only if it is still in `from`, so a duplicate or stale job changes nothing. */
async function move(db: PostgresJsDatabase, runId: string, from: RunStatus, to: RunStatus): Promise<boolean> {
  const rows = await db.update(runs).set({ status: to }).where(and(eq(runs.id, runId), eq(runs.status, from))).returning({ id: runs.id });
  return rows.length === 1;
}

export async function failRun(db: PostgresJsDatabase, runId: string, stage: string, message: string): Promise<void> {
  const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  if (!run || terminal.has(run.status)) return;
  await patchSettings(db, runId, { failure: { stage, message: message.slice(0, 500) } });
  await db.update(runs).set({ status: 'failed' }).where(and(eq(runs.id, runId), eq(runs.status, run.status)));
}

/** Runs `work` over the items a few at a time. After a failure nothing new starts, and the call waits for work in flight before it throws. */
async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length && !failure) {
      try { await work(items[next++]!); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}

/** One stage of work for the run's current status, then the move to the next status. Every stage can run twice with the same result. */
export async function advance(deps: WorkerDeps, runId: string): Promise<AdvanceResult> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new StageFailure(`Run ${runId} does not exist`);
  const from = run.status;
  const to = await stageFor(from)?.(deps, run);
  if (!to) return { from, to: from, more: false };
  const moved = await move(deps.db, runId, from, to);
  deps.log?.(`run ${runId.slice(0, 8)} ${from} -> ${moved ? to : `${from} (already moved)`}`);
  return { from, to: moved ? to : from, more: moved && needsWork(to) };
}

/** Runs stages until the run reaches a gate or a terminal status. */
export async function drive(deps: WorkerDeps, runId: string): Promise<RunStatus> {
  for (;;) {
    const step = await advance(deps, runId);
    if (!step.more) return step.to;
  }
}

type Run = typeof runs.$inferSelect;
type Stage = (deps: WorkerDeps, run: Run) => Promise<RunStatus | undefined>;

const stageFor = (status: RunStatus): Stage | undefined => (({
  draft: buildUniverseStage, universe_built: async () => 'designing' as const, designing: designStage,
  prescreening: prescreenStage, analysing: analyseStage, packaging: packageStage,
}) as Partial<Record<RunStatus, Stage>>)[status];

const tickerOf = (symbol: string) => symbol.slice(0, symbol.lastIndexOf('.'));

/** Resolves EODHD style symbols to a security, a name and, for US names, the SEC CIK. Only the local store is read. */
async function resolveListings(db: PostgresJsDatabase, symbols: string[]) {
  const out = new Map<string, { securityId: string | null; name: string | null; cik?: string }>();
  const us = symbols.filter(s => exchangeOf(s)?.region === 'US');
  if (us.length) {
    const rows = await db.select({ ticker: secListings.ticker, cik: secListings.cik, securityId: figiMappings.securityId, name: securities.name }).from(secListings)
      .leftJoin(figiMappings, eq(figiMappings.listingId, secListings.id)).leftJoin(securities, eq(securities.id, figiMappings.securityId))
      .where(inArray(secListings.ticker, us.map(tickerOf)));
    for (const symbol of us) {
      const matches = rows.filter(r => r.ticker.toUpperCase() === tickerOf(symbol).toUpperCase());
      const best = matches.find(m => m.securityId) ?? matches[0];
      if (best) out.set(symbol, { securityId: best.securityId, name: best.name, cik: best.cik });
    }
  }
  const rest = symbols.filter(s => !out.has(s));
  if (rest.length) for (const r of await db.select({ symbol: exchangeListings.symbol, securityId: exchangeListings.securityId, name: exchangeListings.name }).from(exchangeListings).where(inArray(exchangeListings.symbol, rest))) out.set(r.symbol, { securityId: r.securityId, name: r.name });
  return out;
}

/**
 * Screens every listing that has prices in the local store against the brief's regions, size and liquidity rules, and records the decision for each.
 * Exclusions that name a ticker or symbol are applied. Free text exclusions go to the Designer, not the screen.
 */
const buildUniverseStage: Stage = async ({ db }, run) => {
  const brief = briefOf(run.settings);
  const snapshotId = run.snapshotId ?? (await createSnapshot({ db })).id;
  if (!run.snapshotId) await db.update(runs).set({ snapshotId }).where(eq(runs.id, run.id));
  const symbols = (await db.selectDistinct({ symbol: priceBars.symbol }).from(priceBars)).map(r => r.symbol).sort();
  if (symbols.length === 0) throw new StageFailure('The local store has no prices. Ingest prices before starting a run.');
  const resolved = await resolveListings(db, symbols);
  const currencies = [...new Set(Object.values(exchanges).map(e => e.currency)), 'USD', 'EUR'];
  const fx = await fxToUsdAsOf({ db, snapshotId, asOf: brief.asOf, currencies });
  const excludedTokens = new Set(brief.exclusions.map(e => e.toUpperCase()));
  const excluded = Object.fromEntries(symbols.filter(s => excludedTokens.has(s.toUpperCase()) || excludedTokens.has(tickerOf(s).toUpperCase())).map(s => [s, 'Excluded by the brief']));
  const decisions = await buildUniverse({
    db, snapshotId, asOf: brief.asOf, listings: symbols.map(symbol => ({ symbol, cik: resolved.get(symbol)?.cik })),
    rules: { regions: brief.regions as Region[], minMarketCapUsd: brief.minMarketCapUsd, minAdvUsd: brief.minAdvUsd, maxStaleDays: 5, advWindow: 20, minAdvBars: 10, fxToUsd: fx, excluded },
  });
  for (const d of decisions) {
    const r = resolved.get(d.symbol);
    const row = { runId: run.id, symbol: d.symbol, name: r?.name ?? null, included: d.included, reasons: d.reasons, region: d.region, marketCapUsd: d.marketCapUsd === null ? null : String(d.marketCapUsd), advUsd: d.advUsd === null ? null : String(d.advUsd), securityId: r?.securityId ?? null };
    await db.insert(runUniverse).values(row).onConflictDoUpdate({ target: [runUniverse.runId, runUniverse.symbol], set: { name: row.name, included: row.included, reasons: row.reasons, region: row.region, marketCapUsd: row.marketCapUsd, advUsd: row.advUsd, securityId: row.securityId, coverage: null, ciks: null, issuerKeys: null } });
  }
  await patchSettings(db, run.id, { universe: { status: 'built', snapshotId, candidates: decisions.length, included: decisions.filter(d => d.included).length } });
  return 'universe_built';
};

/** Drafts the KPI framework. A run that already has a valid draft reuses it, so a retry makes no second model call. */
const designStage: Stage = async ({ db, design }, run) => {
  const brief = briefOf(run.settings);
  const members = await db.select({ symbol: runUniverse.symbol, name: runUniverse.name, cap: runUniverse.marketCapUsd }).from(runUniverse).where(and(eq(runUniverse.runId, run.id), eq(runUniverse.included, true)));
  const sample = members.sort((a, b) => Number(b.cap ?? 0) - Number(a.cap ?? 0)).slice(0, 25).map(m => ({ symbol: m.symbol, name: m.name ?? m.symbol }));
  const result = await design({ runId: run.id, input: { brief: brief.brief, keywords: brief.keywords, seedNames: brief.seedNames, exclusions: brief.exclusions, regions: brief.regions, exposureStyle: brief.exposureStyle, asOf: brief.asOf, universeSample: sample } });
  if (!result.ok) throw new StageFailure(`The Designer produced no valid framework: ${result.errors.map(e => `${e.code}: ${e.message}`).slice(0, 5).join('; ')}`);
  return 'awaiting_kpi_approval';
};

/** Resolves evidence for each included name and records what it has. Names with no security cannot be scored and are dropped with a reason. */
const prescreenStage: Stage = async ({ db }, run) => {
  const brief = briefOf(run.settings);
  if (!run.snapshotId) throw new StageFailure('The run has no data snapshot');
  const rows = await db.select().from(runUniverse).where(and(eq(runUniverse.runId, run.id), eq(runUniverse.included, true)));
  for (const row of rows) {
    if (!row.securityId) {
      await db.update(runUniverse).set({ included: false, reasons: [...(row.reasons as string[]), 'no_security'], coverage: 'none' }).where(eq(runUniverse.id, row.id));
      continue;
    }
    const keys = await issuerKeysForSecurity(db, row.securityId);
    const ciks = keys.flatMap(k => k.startsWith('cik:') ? [k.slice(4)] : []);
    const leis = keys.flatMap(k => k.startsWith('lei:') ? [k.slice(4)] : []);
    let secVisible = false;
    for (const cik of ciks) if ((await filingsAsOf({ db, snapshotId: run.snapshotId, asOf: brief.asOf, cik })).length > 0) { secVisible = true; break; }
    const esefVisible = leis.length > 0 && (await esefFilingsAsOf({ db, snapshotId: run.snapshotId, asOf: brief.asOf, leis })).length > 0;
    await db.update(runUniverse).set({ coverage: secVisible ? 'sec' : esefVisible ? 'esef' : 'none', ciks, issuerKeys: keys }).where(eq(runUniverse.id, row.id));
  }
  return 'analysing';
};

const frameworkVersionOf = async (db: PostgresJsDatabase, run: Run) => {
  const [version] = await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.id, run.frameworkVersion ?? '00000000-0000-0000-0000-000000000000'));
  if (!version) throw new StageFailure('The run has no approved framework version');
  return version;
};

/** Scores every KPI for every included name. Scores already saved for this run are reused, so a retry only does the work that is left. */
const analyseStage: Stage = async ({ db, gateway, retriever, scoreConcurrency, log }, run) => {
  const brief = briefOf(run.settings);
  if (!run.snapshotId) throw new StageFailure('The run has no data snapshot');
  const version = await frameworkVersionOf(db, run);
  const framework = version.framework as Framework;
  const rows = await db.select().from(runUniverse).where(and(eq(runUniverse.runId, run.id), eq(runUniverse.included, true)));
  let done = 0;
  await pool(rows, scoreConcurrency ?? 3, async row => {
    await scoreFramework({
      db, gateway, retriever, runId: run.id, frameworkDraftId: version.sourceDraftId, snapshotId: run.snapshotId!, asOf: brief.asOf,
      security: { id: row.securityId!, name: row.name ?? row.symbol, symbol: row.symbol, ciks: (row.ciks as string[] | null) ?? [], issuerKeys: (row.issuerKeys as string[] | null) ?? [] },
    }, framework, { concurrency: 3 });
    log?.(`scored ${row.symbol} (${++done}/${rows.length})`);
  });
  return 'packaging';
};

/**
 * Turns the saved scores into the provisional basket and writes it with its members in one transaction. A basket is never rewritten.
 * A run that already has a basket, such as after a crash before the status moved, only finishes.
 */
const packageStage: Stage = async ({ db }, run) => {
  const [existing] = await db.select({ id: baskets.id }).from(baskets).where(eq(baskets.runId, run.id));
  if (existing) return 'done';
  const brief = briefOf(run.settings);
  const version = await frameworkVersionOf(db, run);
  const framework = version.framework as Framework;
  const kpis: BasketKpi[] = framework.kpis.map(k => ({ id: k.id, weight: k.weightPercent / 100, isGate: k.isGate }));
  const universe = await db.select().from(runUniverse).where(and(eq(runUniverse.runId, run.id), eq(runUniverse.included, true)));
  const scoreRows = await db.select().from(kpiScores).where(eq(kpiScores.runId, run.id)).orderBy(desc(kpiScores.attempt));
  const best = new Map<string, { level: ScoreLevel; confidence: number }>();
  for (const s of scoreRows) {
    const key = `${s.securityId}|${s.kpiId}`;
    if (s.valid && !best.has(key)) best.set(key, { level: s.level as ScoreLevel, confidence: Number(s.confidence) });
  }
  const candidates: BasketCandidate[] = universe.map(u => ({
    securityId: u.securityId!, symbol: u.symbol, name: u.name ?? u.symbol, marketCapUsd: Number(u.marketCapUsd ?? 0), advUsd: Number(u.advUsd ?? 0),
    scores: Object.fromEntries(kpis.flatMap(k => { const v = best.get(`${u.securityId}|${k.id}`); return v ? [[k.id, v]] : []; })),
  }));
  const rules = { size: brief.basketSize, weightCapPercent: brief.weightCapPercent, weighting: brief.weighting, unknownMode: unknownModeFor(brief.exposureStyle) };
  const basket = packageBasket({ candidates, kpis, rules });
  const allRows = await db.select({ included: runUniverse.included }).from(runUniverse).where(eq(runUniverse.runId, run.id));
  const funnel = { universe: allRows.length, screened: allRows.filter(r => r.included).length, ...basket.funnel };
  await db.transaction(async tx => {
    const [row] = await tx.insert(baskets).values({ runId: run.id, frameworkVersionId: version.id, status: basket.status, unknownMode: basket.unknownMode, rules, funnel, cap: basket.cap, excluded: basket.excluded }).onConflictDoNothing().returning({ id: baskets.id });
    if (!row) return;
    if (basket.members.length) await tx.insert(basketMembers).values(basket.members.map(m => ({
      basketId: row.id, securityId: m.securityId, symbol: m.symbol, name: m.name, rank: m.rank, score: String(m.score), confidence: String(m.confidence), weightPercent: String(m.weightPercent),
      atCap: m.atCap, unknownWeight: String(m.unknownWeight), capAdjustment: String(m.capAdjustment), contributions: m.contributions,
    })));
  });
  return 'done';
};
