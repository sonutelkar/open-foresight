import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { validateFramework, enabledSources, type Brief, type Framework, type FrameworkDraft } from '@open-foresight/core';
import { approveGate, figiMappings, fxRates, kpiFrameworkDrafts, leiIsins, kpiFrameworkVersions, llmCalls, marketCapObservations, priceBars, runs, secListings, securities, exchangeListings } from '@open-foresight/db';
import type { EvidenceSearcher, StructuredGenerator } from '@open-foresight/agents';
import type { WorkerDeps } from './stages.js';

export const asOf = '2026-11-20';
export const migrationsFolder = fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url));

/** A migrated database of its own, so a test sees only the data it seeded. Needs TEST_DATABASE_URL to name any database on the server. */
export async function freshDatabase(): Promise<{ url: string; db: PostgresJsDatabase; close(): Promise<void> }> {
  const base = new URL(process.env.TEST_DATABASE_URL ?? '');
  const name = `foresight_w_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const adminUrl = new URL(base); adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(base); url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 6 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  return {
    url: url.toString(), db,
    async close() { await client.end(); await admin.unsafe(`drop database if exists ${name} with (force)`); await admin.end(); },
  };
}

const golden = JSON.parse(readFileSync(new URL('../../../packages/core/fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const checked = validateFramework(golden, { availableSources: enabledSources({ eodhd: true }) });
if (!checked.ok) throw new Error('The golden framework must be valid');
export const framework: Framework = checked.framework;

export const brief: Brief = {
  brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon, including grid equipment, storage and efficiency products.',
  keywords: [], seedNames: [], exclusions: ['EXCL'], regions: ['US', 'EU'], minMarketCapUsd: 1e9, minAdvUsd: 5e6, asOf, exposureStyle: 'broad',
  basketSize: 10, weightCapPercent: 100, weighting: 'score', reviewLevel: 'kpis_and_flags', modelProfile: 'quality',
};

type Listed = { symbol: string; name: string; marketCapUsd: number; kind: 'us' | 'eu' | 'unmapped'; cik?: string };
/** Seven listings. NOSE has prices and no security. TINY is below the size rule. EXCL is named in the brief's exclusions. */
export const listings: Listed[] = [
  { symbol: 'ALPH.US', name: 'Alpha Energy Inc', marketCapUsd: 50e9, kind: 'us', cik: '0000000101' },
  { symbol: 'BETA.US', name: 'Beta Grid Corp', marketCapUsd: 20e9, kind: 'us', cik: '0000000102' },
  { symbol: 'GAMM.US', name: 'Gamma Oil Co', marketCapUsd: 30e9, kind: 'us', cik: '0000000103' },
  { symbol: 'DELT.PA', name: 'Delta Electrique SA', marketCapUsd: 10e9, kind: 'eu' },
  { symbol: 'NOSE.US', name: 'No Security Ltd', marketCapUsd: 8e9, kind: 'unmapped' },
  { symbol: 'TINY.US', name: 'Tiny Micro Inc', marketCapUsd: 1e8, kind: 'us', cik: '0000000104' },
  { symbol: 'EXCL.US', name: 'Excluded Inc', marketCapUsd: 9e9, kind: 'us', cik: '0000000105' },
];

/** Prices, market caps, FX and security links for the listings, all ingested before the run's snapshot. */
export async function seedWorld(db: PostgresJsDatabase, list: readonly Listed[] = listings): Promise<Map<string, { id: string; issuerKey: string }>> {
  const ingestedAt = new Date(Date.now() - 3_600_000);
  const securityIds = new Map<string, { id: string; issuerKey: string }>();
  await db.insert(fxRates).values({ source: 'test', currency: 'USD', date: asOf, perEur: '1.1', ingestedAt });
  for (const l of list) {
    const bars = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.parse(`${asOf}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
      return { source: 'test', symbol: l.symbol, date: d, close: '100', volume: '2000000', contentHash: `h-${l.symbol}-${d}`, raw: {}, ingestedAt };
    });
    await db.insert(priceBars).values(bars);
    await db.insert(marketCapObservations).values({ source: 'test', symbol: l.symbol, sourceSymbol: l.symbol, marketCap: String(l.marketCapUsd / (l.kind === 'eu' ? 1.1 : 1)), currency: l.kind === 'eu' ? 'EUR' : 'USD', observedAt: new Date(`${asOf}T12:00:00Z`) });
    if (l.kind === 'unmapped') continue;
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-${l.symbol}-${randomUUID()}`, name: l.name }).returning({ id: securities.id });
    if (l.kind === 'us') {
      const [listing] = await db.insert(secListings).values({ cik: l.cik!, ticker: l.symbol.split('.')[0]!, exchange: 'Nasdaq', name: l.name, observedAt: ingestedAt }).returning({ id: secListings.id });
      await db.insert(figiMappings).values({ listingId: listing!.id, securityId: security!.id, candidates: [], observedAt: ingestedAt });
      securityIds.set(l.symbol, { id: security!.id, issuerKey: `cik:${l.cik}` });
    } else {
      const isin = `FR${String(securityIds.size).padStart(10, '0')}`, lei = `LEI${String(securityIds.size).padStart(17, '0')}`;
      await db.insert(exchangeListings).values({ source: 'eodhd', symbol: l.symbol, exchange: 'PA', name: l.name, type: 'Common Stock', isin, status: 'resolved', securityId: security!.id, shareClasses: [], observedAt: ingestedAt });
      await db.insert(leiIsins).values({ lei, isin, source: 'test', observedAt: ingestedAt });
      securityIds.set(l.symbol, { id: security!.id, issuerKey: `lei:${lei}` });
    }
  }
  return securityIds;
}

export async function createRun(db: PostgresJsDatabase, over: Partial<Brief> = {}): Promise<string> {
  const [run] = await db.insert(runs).values({ settings: { ...brief, ...over, createdBy: 'tester' }, modelProfile: 'quality' }).returning({ id: runs.id });
  return run!.id;
}

/** A Designer that saves the golden framework through a real audit row, like the real one, and counts its calls. */
export function fakeDesigner(db: PostgresJsDatabase) {
  const state = { calls: 0, fail: false };
  const design: WorkerDeps['design'] = async ({ runId }) => {
    state.calls++;
    if (state.fail) return { ok: false, errors: [{ code: 'weight_total', path: 'kpis', message: 'The weights do not sum to 100' }], draftId: randomUUID(), attempts: 1 };
    const [call] = await db.insert(llmCalls).values({ runId, role: 'designer', promptVersion: 'designer@test', model: 'stub/designer', params: {}, requestHash: randomUUID(), inputEvidenceIds: [] }).returning({ id: llmCalls.id });
    const [draft] = await db.insert(kpiFrameworkDrafts).values({ runId, attempt: 1, promptVersion: 'designer@test', model: 'stub/designer', llmCallId: call!.id, draft: {}, errors: [], valid: true, framework }).returning({ id: kpiFrameworkDrafts.id });
    return { ok: true, framework, draftId: draft!.id, attempts: 1, reused: false };
  };
  return { design, state };
}

/** What the stub model answers for one company: the extracted share, and the judged level. */
export const answers: Record<string, { extracted: number; level: '0' | '1' | '2' | '3' | '4' | 'unknown' }> = {
  'Alpha Energy Inc': { extracted: 0.4, level: '4' }, 'Beta Grid Corp': { extracted: 0.3, level: '2' },
  'Gamma Oil Co': { extracted: 0.005, level: '4' }, 'Delta Electrique SA': { extracted: 0.12, level: '3' },
};
const PASSAGE = 'Our grid products segment generated $3.1 billion of revenue, or 26% of total revenue, in fiscal 2025. We also sell storage systems, drives, controls and building automation.';
const quote = 'grid products segment generated $3.1 billion of revenue, or 26% of total revenue, in fiscal 2025. We also sell storage systems, drives, controls and building automation.';

/** A gateway that writes an llm_calls row like the real one. `failAfter` makes call number N+1 and later throw, to stand in for an outage. */
export function fakeGateway(db: PostgresJsDatabase) {
  const state = { calls: 0, failAfter: Infinity };
  const generator: StructuredGenerator = {
    async generate(request) {
      if (state.calls >= state.failAfter) throw new Error('The model provider is unavailable');
      state.calls++;
      const company = Object.keys(answers).find(c => request.user.includes(c));
      const a = company ? answers[company]! : { extracted: 0, level: 'unknown' as const };
      const raw = request.schemaName === 'kpi_score_extraction'
        ? { extractedValue: a.extracted, citations: [{ evidenceId: 'e1', quote }], rationale: 'The filing states the grid share of revenue.', conflicts: [] }
        : { level: a.level, citations: [{ evidenceId: 'e1', quote }], rationale: 'The filing describes the exposure.', conflicts: [] };
      const value = request.schema.parse(raw);
      const [row] = await db.insert(llmCalls).values({ runId: request.runId, role: request.role, promptVersion: request.promptVersion, model: 'stub/analyst', provider: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw as object }).returning({ id: llmCalls.id });
      request.onAudit?.(row?.id ?? '');
      return value;
    },
  };
  return { generator, state };
}

/** Returns one passage for every search, labelled with the issuer of the security searched. */
export function fakeRetriever(issuerOf: (securityId: string) => string): EvidenceSearcher {
  return { async search(input) { return [{ chunkId: randomUUID(), docKind: 'sec_filing', docId: randomUUID(), issuerKey: issuerOf(input.securityId), section: 'Item 1. Business', startOffset: 10, endOffset: 10 + PASSAGE.length, text: PASSAGE, availableOn: '2026-05-01' }]; } };
}

/** Approves gate 1 the way the API does: freeze the framework as a version and record the decision, in one transaction. */
export async function approve(db: PostgresJsDatabase, runId: string, userId = 'analyst', approved: Framework = framework): Promise<void> {
  const [draft] = await db.select({ id: kpiFrameworkDrafts.id }).from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, runId));
  await approveGate({
    db, runId, gate: 'awaiting_kpi_approval', userId,
    prepare: async tx => {
      const [row] = await tx.insert(kpiFrameworkVersions).values({ runId, version: 1, sourceDraftId: draft!.id, framework: approved, exclusions: [], edited: false, approvedBy: userId }).returning({ id: kpiFrameworkVersions.id });
      return { target: row!.id, frameworkVersion: row!.id };
    },
  });
}
