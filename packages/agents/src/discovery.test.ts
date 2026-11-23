import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { onAllowList, type ReportSource } from '@open-foresight/core';
import { reportDiscoveryAttempts, webDocuments } from '@open-foresight/db';
import type { DiscoveryResult } from '@open-foresight/llm';
import { discoverReport, discoveryPrompt, parseCandidates, type ReportDiscoverer, type ReportFetcher } from './discovery.js';

describe('parseCandidates', () => {
  it('reads plain JSON, fenced JSON and JSON inside a sentence, and drops duplicates', () => {
    const json = '{"candidates":[{"url":"https://a.com/1.pdf","kind":"pdf"},{"url":"https://a.com/1.pdf"}]}';
    for (const text of [json, '```json\n' + json + '\n```', 'Here it is: ' + json + ' Hope it helps.']) expect(parseCandidates(text)).toEqual({ urls: ['https://a.com/1.pdf'] });
  });
  it('reports text that is not usable', () => {
    for (const text of ['', 'no json here', '{"candidates": "nope"}', '{"candidates":[{"url":"not a url"}]}', '{bad json}']) expect(parseCandidates(text)).toHaveProperty('error');
  });
  it('states the allow-list and the JSON shape in the prompt', () => {
    const p = discoveryPrompt({ issuerKey: 'lei:X', entityName: 'Siemens AG', mustMention: ['Siemens'], domains: ['siemens.com'] });
    expect(p).toContain('Siemens AG'); expect(p).toContain('siemens.com'); expect(p).toContain('"candidates"');
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('discoverReport on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const source = (): ReportSource => ({ issuerKey: `lei:${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`, entityName: 'Siemens AG', mustMention: ['Siemens'], domains: ['siemens.com'] });
  const result = (text: string): DiscoveryResult => ({ text, citedUrls: [], model: 'anthropic/claude-haiku-5.5', provider: 'Google', zdr: true, cost: 0.0076, usage: { cost: 0.0076 }, latencyMs: 900, params: { model: 'x' } });
  const discoverer = (text: string | Error) => { const calls: string[] = []; const d: ReportDiscoverer = { model: 'anthropic/claude-haiku-5.5', async discover(p) { calls.push(p); if (text instanceof Error) throw text; return result(text); } }; return { d, calls }; };
  const fetcher = (report: { stored?: string[]; unchanged?: string[]; rejected?: Array<{ url: string; reason: string }> } | Error) => {
    const calls: Array<Parameters<ReportFetcher['sync']>[0]> = [];
    const f: ReportFetcher = { async sync(input) { calls.push(input); if (report instanceof Error) throw report; return { stored: (report.stored ?? []).map(u => ({ url: u })), unchanged: report.unchanged ?? [], rejected: report.rejected ?? [] }; } };
    return { f, calls };
  };
  const attempts = (s: ReportSource) => db.select().from(reportDiscoveryAttempts).where(eq(reportDiscoveryAttempts.issuerKey, s.issuerKey)).orderBy(desc(reportDiscoveryAttempts.createdAt));
  const good = '{"candidates":[{"url":"https://assets.new.siemens.com/ar.pdf","kind":"pdf"},{"url":"https://evil.example.org/siemens.pdf"}]}';

  it('stores a report from an allow-listed URL, filters the others before fetching, and records the model call', async () => {
    const s = source(), d = discoverer(good), f = fetcher({ stored: ['https://assets.new.siemens.com/ar.pdf'] });
    const r = await discoverReport({ db, discoverer: d.d, fetcher: f.f, source: s });
    expect(r).toMatchObject({ outcome: 'stored', stored: 1 });
    expect(f.calls[0]).toMatchObject({ issuerKey: s.issuerKey, entityName: 'Siemens AG', mustMention: ['Siemens'], urls: ['https://assets.new.siemens.com/ar.pdf'] });
    const [a] = await attempts(s);
    expect(a).toMatchObject({ outcome: 'stored', promptVersion: 'report-discovery@v1', model: 'anthropic/claude-haiku-5.5', provider: 'Google', zdr: true, latencyMs: 900 });
    expect(Number(a?.cost)).toBeCloseTo(0.0076, 6);
    expect(a?.rejected).toEqual([{ url: 'https://evil.example.org/siemens.pdf', reason: 'not_allowed_domain' }]);
    expect(f.calls[0]!.attemptId).toBe(a?.id);
    expect(d.calls[0]).toContain('siemens.com');
  });

  it('records no_candidates, all_rejected and errors from the model, the answer and the fetcher, and never throws', async () => {
    const none = source();
    expect(await discoverReport({ db, discoverer: discoverer('{"candidates":[]}').d, fetcher: fetcher({}).f, source: none })).toMatchObject({ outcome: 'no_candidates' });
    const rejected = source(), rf = fetcher({ rejected: [{ url: 'https://www.siemens.com/a.pdf', reason: 'robots_disallowed' }] });
    expect(await discoverReport({ db, discoverer: discoverer('{"candidates":[{"url":"https://www.siemens.com/a.pdf"}]}').d, fetcher: rf.f, source: rejected })).toMatchObject({ outcome: 'all_rejected' });
    expect((await attempts(rejected))[0]?.rejected).toEqual([{ url: 'https://www.siemens.com/a.pdf', reason: 'robots_disallowed' }]);
    const offList = source(), of = fetcher({});
    expect(await discoverReport({ db, discoverer: discoverer('{"candidates":[{"url":"https://other.org/a.pdf"}]}').d, fetcher: of.f, source: offList })).toMatchObject({ outcome: 'all_rejected' });
    expect(of.calls).toHaveLength(0);
    const bad = source();
    expect(await discoverReport({ db, discoverer: discoverer('sorry').d, fetcher: fetcher({}).f, source: bad })).toMatchObject({ outcome: 'error' });
    const down = source();
    expect(await discoverReport({ db, discoverer: discoverer(new Error('HTTP 500')).d, fetcher: fetcher({}).f, source: down })).toMatchObject({ outcome: 'error', detail: 'HTTP 500' });
    expect((await attempts(down))[0]).toMatchObject({ outcome: 'error', error: 'HTTP 500', response: null });
    const broken = source();
    expect(await discoverReport({ db, discoverer: discoverer(good).d, fetcher: fetcher(new Error('disk full')).f, source: broken })).toMatchObject({ outcome: 'error', detail: 'disk full' });
  });

  it('skips a company that already has a stored report and one tried within the cooldown, and retries after it', async () => {
    const s = source();
    const d = discoverer('{"candidates":[]}'), f = fetcher({});
    await discoverReport({ db, discoverer: d.d, fetcher: f.f, source: s, now: () => new Date('2026-11-01T00:00:00Z') });
    expect(await discoverReport({ db, discoverer: d.d, fetcher: f.f, source: s, cooldownDays: 7, now: () => new Date('2026-11-05T00:00:00Z') })).toMatchObject({ outcome: 'cooling_down' });
    expect(d.calls).toHaveLength(1);
    expect(await discoverReport({ db, discoverer: d.d, fetcher: f.f, source: s, cooldownDays: 7, now: () => new Date('2026-11-23T00:00:00Z') })).toMatchObject({ outcome: 'no_candidates' });
    expect(d.calls).toHaveLength(2);
    const held = source();
    await db.insert(webDocuments).values({ url: 'https://www.siemens.com/x.pdf', finalUrl: 'https://www.siemens.com/x.pdf', contentType: 'application/pdf', byteSize: 1, rawSha256: randomUUID(), text: 't', headings: [], extractor: 'test', issuerKey: held.issuerKey, entityName: 'Siemens AG', fetchedAt: new Date(), availableOn: '2026-11-20' });
    const d2 = discoverer(good);
    expect(await discoverReport({ db, discoverer: d2.d, fetcher: f.f, source: held })).toMatchObject({ outcome: 'already_stored' });
    expect(d2.calls).toHaveLength(0);
    expect(onAllowList('https://assets.new.siemens.com/ar.pdf', held.domains)).toBe(true);
  });
});
