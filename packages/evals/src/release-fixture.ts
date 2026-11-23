import { z } from 'zod';
import { defaultLabelSeed, pickKpiPairs, pickRelevanceNames, planFlawed, releaseThemes, uuidFrom, type ExtractScore, type Passage, type ReleaseExtract, type ThemeId } from './release-labels.js';

/** Labeller answers in the recorded format: the message content per `<kind>:<record id>`. A fixture labels only from these, never from a model. */
export const recordedResponsesSchema = z.object({
  schemaVersion: z.literal(1), provenance: z.string().min(1),
  labeller: z.object({ name: z.string().min(1), vendor: z.string().min(1), model: z.string().min(1) }).strict(),
  responses: z.record(z.string(), z.string()),
}).strict();
export type RecordedResponses = z.infer<typeof recordedResponsesSchema>;

/** The counts the checked-in fixture answers cover. The flawed count leaves room for the records the answers contradict. */
export const fixtureLabelCounts = { flawed: 110, clean: 100, kpi: 200, relevance: 500 } as const;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const first = ['Alder', 'Birch', 'Cedar', 'Delta', 'Ember', 'Fjord', 'Granite', 'Harbor', 'Iris', 'Juniper', 'Kestrel', 'Linden', 'Maple'];
const second = ['Works', 'Systems', 'Dynamics', 'Networks', 'Industries', 'Labs', 'Technologies', 'Partners', 'Controls', 'Solutions', 'Devices', 'Holdings', 'Group', 'Instruments'];
const topics: Record<ThemeId, string> = { 'smart-energy': 'grid equipment', cybersecurity: 'security software', 'robotics-ai': 'industrial robot' };
const words = (i: number) => `${first[i % first.length]} ${second[Math.floor(i / first.length) % second.length]}`;
const scoredPerTheme = 40, extraNamesPerTheme = 130, kpisPerTheme = 4;

/**
 * A recorded snapshot extract for the fixture path: three theme runs of 40 scored names on 4 judgement KPIs, and 170 names per theme for relevance.
 * Each scored issuer has in-window passages with figures, in-window passages without any, and passages from before the 730 day lookback.
 * Every 12th unscored name has no evidence. Company names hold no digits, so a passage without figures has none. Built by rule, not from a store.
 */
export function syntheticLabelExtract(seed = defaultLabelSeed): ReleaseExtract {
  const random = rng(seed);
  const asOf = '2026-11-20';
  const extract: ReleaseExtract = { schemaVersion: 1, fixture: true, runs: [], scores: [], names: [], passages: [] };
  releaseThemes.forEach((theme, t) => {
    const runId = uuidFrom('fixture-run', theme.id), topic = topics[theme.id], offset = t * 1000;
    extract.runs.push({ runId, theme: theme.id, asOf, snapshotId: uuidFrom('fixture-snapshot', theme.id, String(seed)) });
    const passage = (issuerKey: string, key: string, availableOn: string, section: string, text: string): Passage => {
      const p: Passage = { chunkId: uuidFrom('fixture-chunk', issuerKey, key), docKind: 'sec_filing', docId: uuidFrom('fixture-doc', issuerKey, availableOn), issuerKey, availableOn, section, startOffset: 0, endOffset: text.length, text, source: `https://www.sec.gov/fixture/${issuerKey.slice(4)}/${availableOn}` };
      extract.passages.push(p);
      return p;
    };
    const kpis = Array.from({ length: kpisPerTheme }, (_, k) => ({
      id: `${theme.id.replace('-', '_')}_kpi_${k}`,
      info: {
        name: `${theme.name} measure ${'ABCD'[k]}`, definition: `How central ${topic} offerings are to the company, measure ${'ABCD'[k]}.`, lookbackDays: 730,
        rubric: { levels: { 0: `No ${topic} offering is named.`, 1: `A ${topic} offering is named in passing, with no figure.`, 2: `A ${topic} offering is named with at least one figure, such as revenue or orders.`, 3: `A ${topic} segment reports its own revenue figure.`, 4: `${topic} offerings are the majority of reported revenue.` }, unknown: 'The passages do not describe the company\'s products.' },
      },
    }));
    for (let i = 0; i < scoredPerTheme; i++) {
      const name = `${words(i + t * 7)} ${['Inc', 'Corp', 'plc'][i % 3]}`, symbol = `${theme.id.slice(0, 2).toUpperCase()}${i}.US`, issuerKey = `cik:${String(offset + i + 1).padStart(10, '0')}`;
      const figures = Array.from({ length: 4 }, (_, k) => passage(issuerKey, `fig-${k}`, '2026-03-02', 'Item 7. Management discussion', `${name} reported that ${topic} revenue was ${10 + ((i * 7 + k * 11) % 60)}% of total revenue in fiscal 2025, with orders of ${100 + i + k} million.`));
      const talk = Array.from({ length: 2 }, (_, k) => passage(issuerKey, `talk-${k}`, '2026-03-02', 'Item 1. Business', `${name} plans to expand its ${topic} offering ${['across new markets', 'with new partners'][k]} and sees strong demand from customers.`));
      Array.from({ length: 2 }, (_, k) => passage(issuerKey, `old-${k}`, '2022-02-15', 'Item 7. Management discussion', `${name} reported that ${topic} revenue was ${5 + ((i + k) % 30)}% of total revenue in fiscal 2021.`));
      const offered = [...figures, ...talk].map((p, k) => ({ id: `e${k + 1}`, chunkId: p.chunkId }));
      const securityId = uuidFrom('fixture-security', symbol);
      for (const kpi of kpis) {
        const roll = random();
        const level = roll < 0.06 ? 'unknown' : String(Math.min(4, Math.floor(random() * 5))) as ExtractScore['level'];
        const cited = level === 'unknown' ? [] : figures.slice(0, 1 + Math.floor(random() * 2));
        extract.scores.push({
          id: uuidFrom('fixture-score', theme.id, symbol, kpi.id), runId, frameworkDraftId: uuidFrom('fixture-draft', theme.id), securityId, symbol, company: name, kpiId: kpi.id,
          method: 'judgement', promptVersion: 'analyst-judgement@v1:fixture', asOf, level, confidence: 0.8, issuerKeys: [issuerKey], kpi: kpi.info,
          citations: cited.map(p => ({ evidenceId: offered.find(o => o.chunkId === p.chunkId)!.id, quote: p.text, chunkId: p.chunkId, docKind: p.docKind, docId: p.docId, section: p.section, startOffset: p.startOffset, endOffset: p.endOffset, availableOn: p.availableOn })),
          offered,
        });
      }
      extract.names.push({ runId, symbol, name, issuerKeys: [issuerKey], funds: i % 3 === 0 ? [theme.funds[0]] : [], passageIds: [figures[0]!.chunkId, talk[0]!.chunkId] });
    }
    for (let i = 0; i < extraNamesPerTheme; i++) {
      const name = `${words(i + 50 + t * 11)} ${['SA', 'AG', 'Ltd', 'Inc'][i % 4]}`, symbol = `${theme.id.slice(0, 2).toUpperCase()}N${i}.US`, issuerKey = `cik:${String(offset + 500 + i).padStart(10, '0')}`;
      const evidence = i % 12 === 5 ? [] : [passage(issuerKey, 'profile', '2026-02-20', 'Item 1. Business', i % 4 === 0 ? `${name} designs and sells ${topic} products to utilities and manufacturers.` : `${name} operates retail stores and restaurants.`)];
      extract.names.push({ runId, symbol, name, issuerKeys: evidence.length ? [issuerKey] : [], funds: i % 4 === 0 ? [theme.funds[theme.funds.length - 1]] : [], passageIds: evidence.map(p => p.chunkId) });
    }
  });
  return extract;
}

const json = (value: unknown) => JSON.stringify(value);

/** What the discoverer answered per `<kind>:<record id>`, in the shape `createDiscoverer` returns. Written by rule, not by a search. */
export const recordedSearchesSchema = z.object({
  schemaVersion: z.literal(1), provenance: z.string().min(1),
  searches: z.record(z.string(), z.object({ text: z.string(), citedUrls: z.array(z.string()), model: z.string(), provider: z.string().nullable(), zdr: z.boolean() }).strict()),
}).strict();
/** The HTTP answer per URL. A URL that is not listed, robots.txt included, answers 404. */
export const recordedPagesSchema = z.object({
  schemaVersion: z.literal(1), provenance: z.string().min(1),
  pages: z.record(z.string(), z.object({ status: z.number().int(), contentType: z.string().optional(), body: z.string().optional() }).strict()),
}).strict();
export type RecordedSearches = z.infer<typeof recordedSearchesSchema>;
export type RecordedPages = z.infer<typeof recordedPagesSchema>;

type Subject = { key: string; company: string; issuerKey: string | undefined; topic: string };
/** The label subjects of the fixture at `fixtureLabelCounts`, in the order `label` takes them. */
function fixtureSubjects(extract: ReleaseExtract, seed: number): Record<'reviewer' | 'kpi' | 'relevance', Subject[]> {
  const topicOf = new Map(extract.runs.map(r => [r.runId, topics[r.theme]]));
  return {
    reviewer: planFlawed(extract, { seed, flawed: fixtureLabelCounts.flawed, clean: fixtureLabelCounts.clean }).file.items.map(i => ({ key: `reviewer:${i.id}`, company: i.company, issuerKey: i.issuerKeys[0], topic: topics[i.theme] })),
    kpi: pickKpiPairs(extract, { seed, count: fixtureLabelCounts.kpi }).picked.map(s => ({ key: `kpi:${s.id}`, company: s.company, issuerKey: s.issuerKeys[0], topic: topicOf.get(s.runId)! })),
    relevance: pickRelevanceNames(extract, { seed, count: fixtureLabelCounts.relevance }).picked.map(n => ({ key: `relevance:${n.theme}:${n.symbol}`, company: n.name, issuerKey: n.issuerKeys[0], topic: topics[n.theme] })),
  };
}
/** Subject index i: no candidates when i % 17 == 3, every candidate rejected when i % 19 == 4, otherwise one page stored. */
const webOutcome = (s: Subject, i: number) => (!s.issuerKey ? 'no_issuer' : i % 17 === 3 ? 'no_candidates' : i % 19 === 4 ? 'all_rejected' : 'stored');
const slug = (s: Subject) => s.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
const pageHtml = (s: Subject) => `<html><head><title>${s.company}</title></head><body><h1>${s.company} investor overview</h1>${
  Array.from({ length: 12 }, (_, k) => `<p>${s.company} sells ${s.topic} products and services to utilities, manufacturers and public agencies. In fiscal 2025 its ${s.topic} business reported revenue of ${120 + k} million and an order backlog of ${40 + k} million, part ${k + 1} of this overview.</p>`).join('')}</body></html>`;

/**
 * Recorded web search answers and page fetches for the fixture subjects. A stored subject gets one company page that passes the fetcher's checks,
 * and every fifth also proposes a private address that the URL policy rejects. A rejected subject proposes a plain http URL and a page that answers 403.
 */
export function syntheticLabelSources(extract: ReleaseExtract, seed = defaultLabelSeed): { searches: RecordedSearches; pages: RecordedPages } {
  const searches: RecordedSearches['searches'] = {};
  const pages: RecordedPages['pages'] = {};
  for (const subjects of Object.values(fixtureSubjects(extract, seed))) {
    subjects.forEach((s, i) => {
      const outcome = webOutcome(s, i);
      if (outcome === 'no_issuer') return;
      const page = `https://ir.${slug(s)}.example/overview`;
      const urls = outcome === 'no_candidates' ? [] : outcome === 'all_rejected' ? [`http://plain.${slug(s)}.example/a`, `https://ir.${slug(s)}.example/members`] : [page, ...(i % 5 === 0 ? ['https://10.0.0.8/internal'] : [])];
      if (outcome === 'stored') pages[page] = { status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml(s) };
      if (outcome === 'all_rejected') pages[urls[1]!] = { status: 403 };
      searches[s.key] = { text: `Here are the pages. ${json({ candidates: urls.map(url => ({ url })) })}`, citedUrls: urls, model: 'fixture/recorded-search', provider: 'fixture', zdr: i % 7 !== 2 };
    });
  }
  return {
    searches: { schemaVersion: 1, provenance: 'fixture: web search answers written by syntheticLabelSources, not a search', searches },
    pages: { schemaVersion: 1, provenance: 'fixture: HTTP answers written by syntheticLabelSources, not fetched', pages },
  };
}

/**
 * Labeller answers for the fixture extract at `fixtureLabelCounts`, written by rule in the recorded format. Each answer cites `w1` when the
 * subject has a stored web page. Flawed index i with i % 25 == 7 is contradicted (`none`) and clean index j with j % 30 == 11 is answered
 * `other`, so those records are dropped. Clean index j with j % 23 == 4 cites a passage it was not shown, and one with j % 29 == 6 cites no
 * web page although it was shown one, so those are rejected. KPI labels follow the scorer's level, one step off every 9th pair and unknown
 * every 23rd. A name is relevant when a fund holds it, flipped every 13th name.
 */
export function syntheticLabelResponses(extract: ReleaseExtract, seed = defaultLabelSeed): RecordedResponses {
  const responses: Record<string, string> = {};
  const subjects = fixtureSubjects(extract, seed);
  const web = (kind: keyof typeof subjects) => new Map(subjects[kind].map((s, i) => [s.key, webOutcome(s, i) === 'stored']));
  const reviewerWeb = web('reviewer'), kpiWeb = web('kpi'), relevanceWeb = web('relevance');
  const cite = (local: string[], hasWeb: boolean | undefined) => [...local, ...(hasWeb ? ['w1'] : [])];
  const flawed = planFlawed(extract, { seed, flawed: fixtureLabelCounts.flawed, clean: fixtureLabelCounts.clean }).file.items;
  flawed.filter(x => x.flaw !== 'none').forEach((item, i) => {
    const key = `reviewer:${item.id}`;
    responses[key] = json({ flaw: i % 25 === 7 ? 'none' : item.flaw, evidence: cite(['e1'], reviewerWeb.get(key)), rationale: `Passage e1 shows the ${item.flaw.replaceAll('_', ' ')} problem.` });
  });
  flawed.filter(x => x.flaw === 'none').forEach((item, j) => {
    const key = `reviewer:${item.id}`, hasWeb = reviewerWeb.get(key);
    const evidence = j % 23 === 4 ? ['e1', 'w9'] : j % 29 === 6 && hasWeb ? ['e1'] : cite(['e1'], hasWeb);
    responses[key] = json(j % 30 === 11 ? { flaw: 'other', evidence, rationale: 'Passage e1 does not support the level given.' } : { flaw: 'none', evidence, rationale: 'Passage e1 is the company\'s own, in the window, and gives a figure.' });
  });
  pickKpiPairs(extract, { seed, count: fixtureLabelCounts.kpi }).picked.forEach((s, i) => {
    const level = i % 23 === 5 ? 'unknown' : i % 9 === 4 ? String(Math.max(0, Number(s.level) - 1)) : s.level;
    responses[`kpi:${s.id}`] = json({ level, evidence: cite(['e1'], kpiWeb.get(`kpi:${s.id}`)), rationale: `Passage e1 meets the rubric for level ${level}.` });
  });
  pickRelevanceNames(extract, { seed, count: fixtureLabelCounts.relevance }).picked.forEach((n, i) => {
    const key = `relevance:${n.theme}:${n.symbol}`;
    const relevant = (n.funds.length > 0) !== (i % 13 === 6);
    responses[key] = json({ relevant, evidence: cite(n.passageIds.length ? ['p1'] : [], relevanceWeb.get(key)), rationale: n.passageIds.length ? `Passage p1 shows whether ${n.name} sells what the theme describes.` : 'No passages. Judged from the company name only.' });
  });
  return { schemaVersion: 1, provenance: 'fixture: labeller answers written by syntheticLabelResponses in the recorded format, not model output', labeller: { name: 'fixture/recorded-builder', vendor: 'fixture', model: 'fixture/recorded-builder' }, responses };
}
