import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StructuredGenerator } from '@open-foresight/agents';
import { flawedFileSchema, labelFileSchema, recordedResponsesSchema, runPhase2, sourcesFileSchema, syntheticLabelExtract, type ManifestKind, type ReleaseExtract } from '@open-foresight/evals';
import { memoryPageStore, runPhase2Labels, type LabelsDeps, type LiveSession, type SourceAttempt } from './release-labels.js';

const root = mkdtempSync(join(tmpdir(), 'phase2-labels-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const fresh = () => join(root, `case-${++dirs}`);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const routes = { labeller: { model: 'google/gemini-3.1-pro-preview' }, others: [{ model: 'anthropic/claude-opus-5.5' }, { model: 'openai/gpt-6-luna' }, { model: 'deepseek/deepseek-v4.1-flash-1017' }, { model: 'typesafe/jev-1.14' }] };
/** Deps whose live half counts every use. A BLOCKED or offline command must leave every counter at zero. */
function spyDeps(session?: Partial<LiveSession>, over: Partial<LabelsDeps> = {}) {
  const used = { opens: 0, calls: 0, searches: 0, fetches: 0 };
  const deps: LabelsDeps = {
    routes, referenceDir: new URL('../../../docs/reference/', import.meta.url).pathname,
    async open() {
      used.opens++;
      return {
        extract: async () => { throw new Error('no extract'); }, saveFlawed: async () => { throw new Error('no save'); }, labelRun: async () => 'audit-run',
        generator: { async generate() { used.calls++; throw new Error('no model'); } },
        discoverer: { model: 'spy/search', async discover() { used.searches++; throw new Error('no search'); } },
        pages: memoryPageStore(), recordAttempt: async () => {}, storedSources: async () => [],
        fetch: async () => { used.fetches++; throw new Error('no network'); }, close: async () => {}, ...session,
      };
    },
    ...over,
  };
  return { deps, used };
}
const liveEnv = { DATABASE_URL: 'postgres://localhost/none', OPENROUTER_API_KEY: 'sk-test' };
const runs = ['--run', 'smart-energy=r1', '--run', 'cybersecurity=r2', '--run', 'robotics-ai=r3', '--snapshot', 's1'];
const none = { opens: 0, calls: 0, searches: 0, fetches: 0 };

describe('live commands that lack a credential, the snapshot or the go-ahead', () => {
  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ['label with no OpenRouter key', ['label', '--manifest-kind', 'kpi', ...runs, '--yes-spend'], { DATABASE_URL: liveEnv.DATABASE_URL }, /OPENROUTER_API_KEY is not set/],
    ['label with no database', ['label', '--manifest-kind', 'relevance', ...runs, '--yes-spend'], { OPENROUTER_API_KEY: 'sk-test' }, /DATABASE_URL is not set/],
    ['label with no snapshot', ['label', '--manifest-kind', 'kpi', ...runs.slice(0, 6), '--yes-spend'], liveEnv, /no --snapshot was given/],
    ['label with a theme without a run', ['label', '--manifest-kind', 'kpi', ...runs.slice(2), '--yes-spend'], liveEnv, /no --run for smart-energy/],
    ['label with no --yes-spend', ['label', '--manifest-kind', 'kpi', ...runs], liveEnv, /--yes-spend was not given/],
    ['collect-sources with no OpenRouter key', ['collect-sources', '--manifest-kind', 'relevance', ...runs, '--yes-spend'], { DATABASE_URL: liveEnv.DATABASE_URL }, /OPENROUTER_API_KEY is not set/],
    ['collect-sources with no snapshot', ['collect-sources', '--manifest-kind', 'kpi', ...runs.slice(0, 6), '--yes-spend'], liveEnv, /no --snapshot was given/],
    ['collect-sources with no --yes-spend', ['collect-sources', '--manifest-kind', 'kpi', ...runs], liveEnv, /--yes-spend was not given/],
    ['build-flawed with no --yes-write', ['build-flawed', ...runs], liveEnv, /--yes-write was not given/],
    ['build-flawed with no database', ['build-flawed', ...runs, '--yes-write'], {}, /DATABASE_URL is not set/],
  ];
  for (const [name, args, env, reason] of cases) {
    it(`is BLOCKED: ${name}, and opens no database, gateway, search or fetch`, async () => {
      const { deps, used } = spyDeps();
      const result = await runPhase2Labels([...args, '--work', fresh()], env, deps);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^BLOCKED: /);
      expect(result.stderr).toMatch(reason);
      expect(used).toEqual(none);
    });
  }

  it('is BLOCKED when the labeller shares a vendor with a scorer or the Reviewer', async () => {
    const { deps, used } = spyDeps(undefined, { routes: { ...routes, labeller: { model: 'openai/gpt-6-luna' } } });
    const result = await runPhase2Labels(['label', '--manifest-kind', 'kpi', ...runs, '--yes-spend', '--work', fresh()], liveEnv, deps);
    expect(result.stderr).toMatch(/^BLOCKED: .*shares the vendor openai/);
    expect(used).toEqual(none);
  });

  it('says how many labeller, search and fetch calls a blocked run would make', async () => {
    const { deps } = spyDeps();
    const labelled = await runPhase2Labels(['label', '--manifest-kind', 'kpi', ...runs, '--count', '120', '--work', fresh()], liveEnv, deps);
    expect(labelled.stderr).toContain('about 120 google/gemini-3.1-pro-preview call(s) and no web search');
    const collected = await runPhase2Labels(['collect-sources', '--manifest-kind', 'kpi', ...runs, '--count', '120', '--work', fresh()], liveEnv, deps);
    expect(collected.stderr).toContain('about 120 web search call(s), at most 240 if no provider serves zero data retention, and fetch up to 360 page(s)');
  });
});

const kinds: ManifestKind[] = ['reviewer', 'kpi', 'relevance'];
/** Runs the offline path from recorded inputs into `work`, and fills each check sheet the way a colleague would. */
async function offlineRun(work: string, options: { contradictMore?: number } = {}) {
  const { deps, used } = spyDeps();
  const run = async (...args: string[]) => {
    const r = await runPhase2Labels([...args, '--work', work], {}, deps);
    if (r.code !== 0) throw new Error(`${args.join(' ')}: ${r.stderr}`);
    return r;
  };
  const inputs = join(work, 'inputs');
  await run('fixture', '--out', inputs);
  const from = ['--from', join(inputs, 'extract.json')];
  await run('build-flawed', ...from, '--flawed', '110');
  if (options.contradictMore) {
    const recorded = recordedResponsesSchema.parse(readJson(join(inputs, 'responses.json')));
    const items = flawedFileSchema.parse(readJson(join(work, 'flawed.json'))).items.filter(i => i.flaw !== 'none').slice(-options.contradictMore);
    for (const i of items) recorded.responses[`reviewer:${i.id}`] = JSON.stringify({ ...JSON.parse(recorded.responses[`reviewer:${i.id}`]!), flaw: 'none' });
    writeFileSync(join(inputs, 'responses.json'), JSON.stringify(recorded));
  }
  const out: Record<string, string> = {};
  for (const kind of kinds) {
    const data = kind === 'reviewer' ? [] : from;
    out[`collect-${kind}`] = (await run('collect-sources', '--manifest-kind', kind, ...data, '--searches', join(inputs, 'searches.json'), '--pages', join(inputs, 'pages.json'))).stdout;
    out[`label-${kind}`] = (await run('label', '--manifest-kind', kind, ...data, '--responses', join(inputs, 'responses.json'))).stdout;
  }
  await run('sample-human', '--seed', '7');
  for (const kind of kinds) {
    const sheet = readFileSync(join(work, `check-${kind}.csv`), 'utf8').replace(/,,\n/g, ',yes,\n');
    writeFileSync(join(work, `returned-${kind}.csv`), sheet);
    await run('record-human-check', '--kind', kind, '--sheet', join(work, `returned-${kind}.csv`), '--reviewer', 'A Colleague');
  }
  const labels = (kind: ManifestKind) => labelFileSchema.parse(readJson(join(work, `labels-${kind}.json`)));
  const sources = (kind: ManifestKind) => sourcesFileSchema.parse(readJson(join(work, `sources-${kind}.json`)));
  return { run, deps, used, inputs, out, labels, sources };
}

describe('the offline fixture path', () => {
  const work = fresh();
  const ready = offlineRun(work);

  it('builds, collects sources, labels, samples and assembles a set release validation accepts as a fixture, with no database, model, search or network', async () => {
    const { run, used } = await ready;
    const out = join(work, 'release');
    const assembled = await run('assemble', '--out', out, '--allow-fixture');
    expect(assembled.stdout).toContain('OK wrote 3 manifests');
    expect(runPhase2(['--mode', 'validate', '--data', out, '--allow-fixture'])).toMatchObject({ code: 0 });
    expect(runPhase2(['--mode', 'validate', '--data', out]).code).toBe(1);
    expect(used).toEqual(none);
  });

  it('stores every page it cites and records why each proposed page was rejected', async () => {
    const { sources, out } = await ready;
    const entries = Object.values(sources('kpi').entries);
    expect(entries.filter(e => e.outcome === 'stored').length).toBeGreaterThan(150);
    for (const e of entries.filter(x => x.outcome === 'stored')) {
      expect(e.sources.every(s => s.finalUrl.startsWith('https://') && /^[0-9a-f]{64}$/.test(s.sha256) && s.passages.length > 0)).toBe(true);
    }
    expect(new Set(entries.flatMap(e => e.rejected.map(r => r.reason)))).toEqual(new Set(['not_public_https', 'login_required']));
    expect(entries.filter(e => e.outcome === 'no_candidates').length).toBeGreaterThan(0);
    expect(out['collect-kpi']).toMatch(/Sources: stored \d+, no_candidates \d+, all_rejected \d+, no_issuer 0, error 0\. \d+ search\(es\) ran without zero data retention\./);
  });

  it('cites each stored page by URL, fetch time and content hash, and keeps a record with no stored page as an explicit count', async () => {
    const { labels, sources } = await ready;
    for (const kind of kinds) {
      const file = labels(kind), entries = sources(kind).entries;
      const withoutWeb = file.records.filter(r => !r.webCitations?.length).map(r => r.id).sort();
      expect(file.noWebSource.map(n => n.id).sort()).toEqual(withoutWeb);
      expect(withoutWeb.every(id => entries[id]!.sources.length === 0)).toBe(true);
      for (const r of file.records.filter(x => x.webCitations?.length)) {
        const stored = entries[r.id]!.sources;
        for (const c of r.webCitations!) expect(stored.some(s => s.sourceId === c.sourceId && s.finalUrl === c.url && s.fetchedAt === c.fetchedAt && s.sha256 === c.sha256 && s.passages.some(p => p.id === c.passageId))).toBe(true);
      }
    }
    const relevance = labels('relevance');
    expect(relevance.noWebSource.some(n => n.reason.startsWith('no issuer key'))).toBe(true);
    expect(relevance.noWebSource.some(n => n.reason.startsWith('every proposed page was rejected'))).toBe(true);
  });

  it('rejects and counts a label that cites a passage it was not shown or no stored page when it was shown one, and drops a contradicted flaw', async () => {
    const { inputs, labels, sources, out } = await ready;
    const answers = recordedResponsesSchema.parse(readJson(join(inputs, 'responses.json'))).responses;
    const items = flawedFileSchema.parse(readJson(join(work, 'flawed.json'))).items;
    const entries = sources('reviewer').entries;
    const verdict = (i: (typeof items)[number]) => {
      const answer = JSON.parse(answers[`reviewer:${i.id}`]!) as { flaw: string; evidence: string[] };
      const web = entries[i.id]!.sources.flatMap(s => s.passages).map((_, n) => `w${n + 1}`);
      const shown = new Set([...i.citations.map(c => c.evidenceId), ...web]);
      if (answer.evidence.some(l => !shown.has(l)) || (web.length > 0 && !answer.evidence.some(l => web.includes(l)))) return 'rejected';
      return answer.flaw === i.flaw ? 'kept' : 'dropped';
    };
    const file = labels('reviewer');
    const ids = (v: string) => items.filter(i => verdict(i) === v).map(i => i.id).sort();
    expect(ids('rejected').length).toBeGreaterThan(0);
    expect(ids('dropped').length).toBeGreaterThan(0);
    expect(file.rejected.map(r => r.id).sort()).toEqual(ids('rejected'));
    expect(file.dropped.map(r => r.id).sort()).toEqual(ids('dropped'));
    expect(file.records.map(r => r.id).sort()).toEqual(ids('kept'));
    expect(out['label-reviewer']).toContain(`Dropped ${ids('dropped').length} record(s) the labeller contradicted. Rejected ${ids('rejected').length} for their citations.`);
  });

  it('puts the stored copy behind each sampled label on the colleague check sheet', async () => {
    await ready;
    const csv = readFileSync(join(work, 'check-kpi.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('id,theme,symbol,company,subject,ai_label,ai_rationale,sources,web_citations,agree,note');
    expect(csv).toMatch(/https:\/\/ir\.[^ ]+\.example\/overview \(stored copy fetched 2026-11-24T09:00:00\.000Z, sha256 [0-9a-f]{64}\)/);
  });
});

describe('assembling short or unchecked sets', () => {
  it('refuses to assemble when drops leave fewer than 100 flawed scores, and writes nothing', async () => {
    const work = fresh();
    const { deps } = await offlineRun(work, { contradictMore: 10 });
    const out = join(work, 'release');
    const result = await runPhase2Labels(['assemble', '--work', work, '--out', out, '--allow-fixture'], {}, deps);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/reviewer\.json: 9\d flawed scores, 100 required/);
    expect(() => readdirSync(out)).toThrow();
  });

  it('refuses to assemble a kind whose returned sheet was never recorded', async () => {
    const work = fresh();
    const { deps } = await offlineRun(work);
    rmSync(join(work, 'human-relevance.json'));
    const result = await runPhase2Labels(['assemble', '--work', work, '--out', join(work, 'release'), '--allow-fixture'], {}, deps);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('relevance: no spot check is recorded, so the labels stay provisional-ai');
  });

  it('refuses to label before the sources are collected', async () => {
    const work = fresh();
    const { deps } = spyDeps();
    const inputs = join(work, 'inputs');
    await runPhase2Labels(['fixture', '--out', inputs], {}, deps);
    const result = await runPhase2Labels(['label', '--manifest-kind', 'kpi', '--from', join(inputs, 'extract.json'), '--responses', join(inputs, 'responses.json'), '--work', work], {}, deps);
    expect(result.stderr).toMatch(/sources-kpi\.json does not exist\. Run collect-sources/);
  });
});

describe('the live path, with the database, search and network faked', () => {
  const extract: ReleaseExtract = { ...syntheticLabelExtract(), fixture: false };

  it('saves the flawed plan through the store before it writes the work file', async () => {
    const saved: string[][] = [];
    const { deps, used } = spyDeps({ extract: async () => extract, saveFlawed: async file => { saved.push(file.items.map(i => i.id)); return { inserted: file.items.length, existing: 0 }; } });
    const work = fresh();
    const result = await runPhase2Labels(['build-flawed', ...runs, '--yes-write', '--work', work], liveEnv, deps);
    expect(result.code).toBe(0);
    expect(used.opens).toBe(1);
    const file = flawedFileSchema.parse(readJson(join(work, 'flawed.json')));
    expect(saved).toEqual([file.items.map(i => i.id)]);
    expect(file.fixture).toBe(false);
  });

  it('searches, filters, fetches and stores sources, records every attempt, then labels with the cache off citing only stored copies', async () => {
    const attempts: SourceAttempt[] = [];
    const fetched: string[] = [];
    const pages = memoryPageStore();
    const slug = (company: string) => company.toLowerCase().replace(/[^a-z]+/g, '-');
    const page = (company: string) => `<html><body><h1>${company}</h1>${Array.from({ length: 24 }, (_, k) => `<p>${company} sells grid equipment and security software, with revenue of ${100 + k} million in fiscal 2025.</p>`).join('')}</body></html>`;
    const requests: Array<Parameters<StructuredGenerator['generate']>[0]> = [];
    const session: Partial<LiveSession> = {
      extract: async () => extract, labelRun: async () => 'audit-run', pages, recordAttempt: async a => { attempts.push(a); },
      discoverer: {
        model: 'anthropic/claude-haiku-5.5',
        async discover(question) {
          const company = /about (.+?) \(/.exec(question)![1]!;
          const candidates = [`https://ir.${slug(company)}.example.com/overview`, 'https://localhost/admin', 'http://insecure.example.com/a'];
          return { text: JSON.stringify({ candidates: candidates.map(url => ({ url })) }), citedUrls: [], model: 'anthropic/claude-haiku-5.5', provider: 'Anthropic', zdr: false, cost: 0.007, usage: null, latencyMs: 5, params: {} };
        },
      },
      fetch: async input => {
        const url = new URL(String(input));
        fetched.push(url.href);
        if (url.pathname === '/robots.txt') return new Response(null, { status: 404 });
        const company = extract.scores.find(s => url.hostname === `ir.${slug(s.company)}.example.com`)!.company;
        return new Response(page(company), { status: 200, headers: { 'content-type': 'text/html' } });
      },
      storedSources: async ids => (await Promise.all(fetched.map(u => pages.byUrl(u)))).flatMap(r => (r && ids.includes(r.id) ? [{ id: r.id, rawSha256: r.rawSha256, text: r.text }] : [])),
      generator: { async generate(request) { requests.push(request); return { level: '2', evidence: ['e1', 'w1'], rationale: 'e1 and w1 give a figure.' }; } },
    };
    const { deps } = spyDeps(session);
    const work = fresh();
    const collected = await runPhase2Labels(['collect-sources', '--manifest-kind', 'kpi', ...runs, '--count', '6', '--concurrency', '6', '--yes-spend', '--work', work], liveEnv, deps);
    expect(collected.stdout).toContain('Sources: stored 6, no_candidates 0, all_rejected 0, no_issuer 0, error 0. 6 search(es) ran without zero data retention.');
    expect(attempts).toHaveLength(6);
    expect(attempts.every(a => a.outcome === 'stored' && a.result?.zdr === false && a.rejected.map(r => r.reason).join() === 'not_public_https,not_public_https')).toBe(true);
    expect(fetched.some(u => u.includes('localhost') || u.startsWith('http:'))).toBe(false);

    const labelled = await runPhase2Labels(['label', '--manifest-kind', 'kpi', ...runs, '--count', '6', '--yes-spend', '--work', work], liveEnv, deps);
    expect(labelled.code).toBe(0);
    expect(requests).toHaveLength(6);
    expect(requests.every(r => r.role === 'labeller' && r.cache === false && r.runId === 'audit-run' && /\[w1\] https:\/\/ir\..+\.example\.com\/overview \| stored copy fetched/.test(r.user))).toBe(true);
    const file = labelFileSchema.parse(readJson(join(work, 'labels-kpi.json')));
    expect(file.records).toHaveLength(6);
    expect(file.records.every(r => r.webCitations?.length === 1 && r.webCitations[0]!.url.endsWith('.example.com/overview'))).toBe(true);
  });
});
