import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { DocKind } from '@open-foresight/core';
import { documentChunks, kpiScores, labelSourceAttempts, labelSources, llmCalls, runs, webDocuments } from '@open-foresight/db';
import type { EvidenceSearcher, StructuredGenerator } from '@open-foresight/agents';
import { loadReviewerInput } from '@open-foresight/agents';
import { flawedFileSchema, labelFileSchema, planFlawed } from '@open-foresight/evals';
import { runPhase2Labels, type LabelsDeps } from './release-labels.js';
import { labelPageStore, labelRun, loadExtract, recordSourceAttempt, saveFlawed, storedSources } from './release-store.js';
import { drive } from './stages.js';
import { approve, createRun, fakeDesigner, freshDatabase, seedWorld } from './test-world.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const themes = ['smart-energy', 'cybersecurity', 'robotics-ai'] as const;

integration('release labels on Postgres', () => {
  let world: Awaited<ReturnType<typeof freshDatabase>>;
  let db: PostgresJsDatabase;
  const work = mkdtempSync(join(tmpdir(), 'release-store-'));
  const themeRuns: Array<{ theme: (typeof themes)[number]; runId: string; snapshotId: string }> = [];

  beforeAll(async () => {
    world = await freshDatabase();
    db = world.db;
    const securities = await seedWorld(db);
    const issuerOf = new Map([...securities.values()].map(s => [s.id, s.issuerKey]));
    const fetchedAt = new Date(Date.now() - 7_200_000);
    const add = async (issuerKey: string, availableOn: string, text: string) => {
      const [doc] = await db.insert(webDocuments).values({ url: `https://example.test/${randomUUID()}`, finalUrl: `https://example.test/${issuerKey}/${availableOn}.pdf`, contentType: 'application/pdf', byteSize: 100, rawSha256: randomUUID(), text, headings: [], extractor: 'test', issuerKey, entityName: issuerKey, fetchedAt, availableOn }).returning({ id: webDocuments.id });
      await db.insert(documentChunks).values({ docKind: 'web_report', docId: doc!.id, issuerKey, availableOn, section: 'Annual report', ordinal: 0, startOffset: 0, endOffset: text.length, text, embedding: new Array(1536).fill(0) as number[], indexVersion: 'v-test' });
    };
    for (const { issuerKey } of securities.values()) {
      await add(issuerKey, '2026-03-02', `We signed a 200 MWh battery storage contract and sold energy efficiency products worth $40 million in fiscal 2025 for ${issuerKey}.`);
      await add(issuerKey, '2026-10-01', 'We plan to grow our storage and efficiency business with new partners and see strong demand.');
      await add(issuerKey, '2022-01-10', 'Battery storage revenue was 12% of total revenue in fiscal 2021.');
    }
    const retriever: EvidenceSearcher = {
      async search(input) {
        const rows = await db.select().from(documentChunks).where(eq(documentChunks.issuerKey, issuerOf.get(input.securityId) ?? 'none'));
        return rows.filter(r => r.availableOn >= '2025-01-01').sort((a, b) => a.availableOn.localeCompare(b.availableOn))
          .map(r => ({ chunkId: r.id, docKind: r.docKind as DocKind, docId: r.docId, issuerKey: r.issuerKey, section: r.section, startOffset: r.startOffset, endOffset: r.endOffset, text: r.text, availableOn: r.availableOn }));
      },
    };
    const levels: Record<string, string> = { 'Alpha Energy Inc': '4', 'Beta Grid Corp': '2', 'Gamma Oil Co': '0', 'Delta Electrique SA': '3' };
    const gateway: StructuredGenerator = {
      async generate(request) {
        const level = Object.entries(levels).find(([name]) => request.user.includes(name))?.[1] ?? 'unknown';
        const common = { citations: [{ evidenceId: 'e1', quote: 'signed a 200 MWh battery storage contract and sold energy efficiency products' }], rationale: 'e1 names the offering.', conflicts: [] };
        const raw = request.schemaName === 'kpi_score_extraction' ? { extractedValue: 0.3, ...common } : { level, ...common };
        const [row] = await db.insert(llmCalls).values({ runId: request.runId, role: request.role, promptVersion: request.promptVersion, model: 'stub/analyst', provider: 'stub', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw }).returning({ id: llmCalls.id });
        request.onAudit?.(row!.id);
        return request.schema.parse(raw);
      },
    };
    const deps = { db, design: fakeDesigner(db).design, gateway, retriever, availableSources: ['sec_filings', 'esef_filings', 'sec_facts', 'prices', 'market_cap'] as Array<'sec_filings' | 'esef_filings' | 'sec_facts' | 'prices' | 'market_cap'>, scoreConcurrency: 2 };
    for (const theme of themes) {
      const runId = await createRun(db);
      expect(await drive(deps, runId)).toBe('awaiting_kpi_approval');
      await approve(db, runId);
      expect(await drive(deps, runId)).toBe('done');
      const [run] = await db.select({ snapshotId: runs.snapshotId }).from(runs).where(eq(runs.id, runId));
      themeRuns.push({ theme, runId, snapshotId: run!.snapshotId! });
    }
  }, 60_000);
  afterAll(async () => { rmSync(work, { recursive: true, force: true }); await world?.close(); });

  it('reads scores, donors and names per run snapshot, and refuses a run outside the given snapshots', async () => {
    const snapshotIds = themeRuns.map(r => r.snapshotId);
    const extract = await loadExtract(db, { snapshotIds, runs: themeRuns, parts: ['scores', 'names'], holdings: [{ fund: 'GRID', ticker: 'ALPH', name: 'Alpha Energy Inc' }] });
    expect(new Set(snapshotIds).size).toBe(3);
    expect(extract.runs.map(r => r.snapshotId)).toEqual(snapshotIds);
    expect(extract.scores.length).toBeGreaterThan(0);
    expect(extract.passages.some(p => p.availableOn === '2022-01-10')).toBe(true);
    expect(extract.passages.some(p => p.availableOn === '2026-10-01')).toBe(true);
    expect(extract.passages.every(p => p.source.startsWith('https://example.test/'))).toBe(true);
    expect(extract.names.find(n => n.symbol === 'ALPH.US')).toMatchObject({ funds: ['GRID'] });
    expect(extract.names.every(n => n.passageIds.length > 0 && n.passageIds.length <= 4)).toBe(true);
    await expect(loadExtract(db, { snapshotIds: snapshotIds.slice(1), runs: themeRuns, parts: ['scores'], holdings: [] })).rejects.toThrow('not among --snapshot');
  });

  it('saves flawed copies the Reviewer loads, in cancelled runs that can never be packaged, and a repeat writes nothing', async () => {
    const extract = await loadExtract(db, { snapshotIds: themeRuns.map(r => r.snapshotId), runs: themeRuns, parts: ['scores'], holdings: [] });
    const plan = planFlawed(extract, { seed: 5, flawed: 9, clean: 3 });
    expect(plan.shortages).toEqual([]);
    expect(await saveFlawed(db, plan.file)).toEqual({ inserted: 12, existing: 0 });
    expect(await saveFlawed(db, plan.file)).toEqual({ inserted: 0, existing: 12 });
    const fixtureRuns = await db.select({ id: runs.id, status: runs.status, frameworkVersion: runs.frameworkVersion }).from(runs).where(inArray(runs.id, plan.file.runs.map(r => r.fixtureRunId)));
    expect(fixtureRuns.map(r => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    await expect(db.update(runs).set({ status: 'packaging' }).where(eq(runs.id, fixtureRuns[0]!.id))).rejects.toThrow();
    const wrong = plan.file.items.find(i => i.flaw === 'wrong_issuer')!;
    const { input } = await loadReviewerInput(db, wrong.id);
    expect(input.passages.every(p => !wrong.issuerKeys.includes(p.issuer))).toBe(true);
    const stored = await db.select({ runId: kpiScores.runId, valid: kpiScores.valid }).from(kpiScores).where(inArray(kpiScores.id, plan.file.items.map(i => i.id)));
    expect(new Set(stored.map(s => s.runId))).toEqual(new Set(plan.file.runs.map(r => r.fixtureRunId)));
    expect(await labelRun(db, ['b', 'a'])).toBe(await labelRun(db, ['a', 'b']));
  });

  it('runs build-flawed, collect-sources and the reviewer labels through the CLI on the real store, citing stored copies and auditing every call', async () => {
    const calls: string[] = [];
    const company = (q: string) => /about (.+?) \(/.exec(q)![1]!;
    const host = (name: string) => `ir.${name.toLowerCase().replace(/[^a-z]+/g, '-')}.example.com`;
    const page = (name: string) => `<html><body><h1>${name}</h1>${Array.from({ length: 24 }, (_, k) => `<p>${name} sells battery storage and energy efficiency products, with revenue of ${100 + k} million in fiscal 2025.</p>`).join('')}</body></html>`;
    const names = ['Alpha Energy Inc', 'Beta Grid Corp', 'Gamma Oil Co', 'Delta Electrique SA'];
    const generator: StructuredGenerator = {
      async generate(request) {
        const raw = { flaw: 'none', evidence: ['e1', 'w1'], rationale: 'e1 is the company\'s own, in the window, with a figure, and w1 agrees.' };
        const [row] = await db.insert(llmCalls).values({ runId: request.runId, role: request.role, promptVersion: request.promptVersion, model: 'stub/labeller', provider: 'stub', params: { cache: request.cache }, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: raw }).returning({ id: llmCalls.id });
        calls.push(row!.id);
        return request.schema.parse(raw);
      },
    };
    const deps: LabelsDeps = {
      routes: { labeller: { model: 'google/gemini-3.1-pro-preview' }, others: [{ model: 'openai/gpt-6-luna' }, { model: 'deepseek/deepseek-v4.1-flash-1017' }] }, referenceDir: '',
      async open() {
        return {
          extract: input => loadExtract(db, input), saveFlawed: file => saveFlawed(db, file), labelRun: ids => labelRun(db, ids), generator,
          discoverer: { model: 'stub/search', discover: async q => ({ text: JSON.stringify({ candidates: [{ url: `https://${host(company(q))}/about` }, { url: 'https://192.168.1.4/x' }] }), citedUrls: [], model: 'stub/search', provider: 'stub', zdr: false, cost: 0.001, usage: null, latencyMs: 1, params: { plugins: [{ id: 'web' }] } }) },
          pages: labelPageStore(db), recordAttempt: a => recordSourceAttempt(db, a), storedSources: ids => storedSources(db, ids),
          fetch: async input => {
            const url = new URL(String(input));
            const name = names.find(n => host(n) === url.hostname);
            return url.pathname === '/robots.txt' || !name ? new Response(null, { status: 404 }) : new Response(page(name), { headers: { 'content-type': 'text/html' } });
          },
          close: async () => {},
        };
      },
    };
    const env = { DATABASE_URL: 'postgres://faked', OPENROUTER_API_KEY: 'sk-faked' };
    const args = [...themeRuns.flatMap(r => ['--snapshot', r.snapshotId, '--run', `${r.theme}=${r.runId}`]), '--work', work, '--seed', '6'];
    const built = await runPhase2Labels(['build-flawed', ...args, '--flawed', '9', '--clean', '3', '--yes-write'], env, deps);
    expect(built.stderr).toBe('');
    expect(built.stdout).toContain('Saved 12 kpi_scores rows (0 already present) in 3 cancelled fixture run(s)');
    const collected = await runPhase2Labels(['collect-sources', '--manifest-kind', 'reviewer', ...args, '--concurrency', '12', '--yes-spend'], env, deps);
    expect(collected.stdout).toContain('Sources: stored 12, no_candidates 0, all_rejected 0, no_issuer 0, error 0.');
    const attempts = await db.select().from(labelSourceAttempts);
    expect(attempts).toHaveLength(12);
    expect(attempts.every(a => a.subjectKind === 'reviewer' && a.outcome === 'stored' && a.zdr === false && (a.rejected as Array<{ reason: string }>)[0]?.reason === 'not_public_https')).toBe(true);
    const stored = await db.select({ id: labelSources.id, attemptId: labelSources.attemptId, url: labelSources.url }).from(labelSources);
    const companies = new Set(flawedFileSchema.parse(JSON.parse(readFileSync(join(work, 'flawed.json'), 'utf8'))).items.map(i => i.company));
    expect(stored.map(s => new URL(s.url).hostname).sort()).toEqual([...companies].map(host).sort());
    expect(await db.select({ id: webDocuments.id }).from(webDocuments).where(inArray(webDocuments.url, stored.map(s => s.url)))).toEqual([]);
    const labelled = await runPhase2Labels(['label', '--manifest-kind', 'reviewer', ...args, '--yes-spend'], env, deps);
    expect(labelled.code).toBe(0);
    const file = labelFileSchema.parse(JSON.parse(readFileSync(join(work, 'labels-reviewer.json'), 'utf8')));
    const items = flawedFileSchema.parse(JSON.parse(readFileSync(join(work, 'flawed.json'), 'utf8'))).items;
    expect(file.records.map(r => r.id).sort()).toEqual(items.filter(i => i.flaw === 'none').map(i => i.id).sort());
    expect(file.records.every(r => r.webCitations?.length === 1 && stored.some(s => s.id === r.webCitations?.[0]?.sourceId))).toBe(true);
    expect(file.dropped).toHaveLength(9);
    const audited = await db.select({ runId: llmCalls.runId, role: llmCalls.role }).from(llmCalls).where(inArray(llmCalls.id, calls));
    expect(audited).toHaveLength(12);
    expect(new Set(audited.map(a => a.runId))).toEqual(new Set([await labelRun(db, themeRuns.map(r => r.snapshotId))]));
    expect(audited.every(a => a.role === 'labeller')).toBe(true);
  }, 60_000);
});
