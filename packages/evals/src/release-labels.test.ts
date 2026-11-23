import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateScore, type Kpi } from '@open-foresight/core';
import { hashRecords, type KpiRecord, type ManifestKind, type RelevanceRecord, type ReviewerRecord } from './manifest.js';
import { syntheticLabelExtract } from './release-fixture.js';
import {
  assembleRelease, checkSheet, checkSheetCsv, drawHumanSample, fundsHolding, parseHoldings, pickKpiPairs, pickRelevanceNames, planFlawed, recordHumanCheck,
  releaseThemeIds, windowStart, type FlawItem, type HumanCheck, type LabelFile, type ReleaseExtract,
} from './release-labels.js';
import { validateReleaseSet } from './validate.js';

const extract = syntheticLabelExtract();
const options = { seed: 20261123, flawed: 110, clean: 100 };

/** Core's own score check on what the copy cites, as the Analyst's validator would run it. */
function coreCheck(item: FlawItem) {
  const kpi: Kpi = { id: item.kpiId, name: item.kpi.name, definition: item.kpi.definition, subThemeId: 'sub', sources: [], lookbackDays: item.kpi.lookbackDays, weightPercent: 10, isGate: false, method: 'judgement', rubric: item.kpi.rubric };
  const evidence = item.citations.map(c => { const p = item.passages.find(x => x.chunkId === c.chunkId)!; return { id: c.evidenceId, chunkId: p.chunkId, docKind: p.docKind, docId: p.docId, issuerKey: p.issuerKey, section: p.section, startOffset: p.startOffset, endOffset: p.endOffset, availableOn: p.availableOn, text: p.text }; });
  const result = validateScore({ kpi, output: { level: item.level, citations: item.citations.map(c => ({ evidenceId: c.evidenceId, quote: c.quote })), rationale: 'r', conflicts: [] }, evidence, asOf: item.asOf, allowedIssuerKeys: item.issuerKeys });
  return result.ok ? [] : [...new Set(result.errors.map(e => e.code))];
}

describe('planFlawed', () => {
  const plan = planFlawed(extract, options);
  const flawed = plan.file.items.filter(i => i.flaw !== 'none');

  it('makes the same copies from the same seed, and other copies from another seed', () => {
    expect(planFlawed(extract, options)).toEqual(plan);
    const other = planFlawed(extract, { ...options, seed: 7 });
    expect(other.file.items).toHaveLength(plan.file.items.length);
    expect(other.file.items.map(i => i.baseScoreId)).not.toEqual(plan.file.items.map(i => i.baseScoreId));
  });

  it('splits flawed and clean scores evenly over the themes and the flaws over each theme', () => {
    expect(plan.shortages).toEqual([]);
    const count = (theme: string, flaw: string) => plan.file.items.filter(i => i.theme === theme && i.flaw === flaw).length;
    expect(releaseThemeIds.map(t => flawed.filter(i => i.theme === t).length)).toEqual([37, 37, 36]);
    expect(releaseThemeIds.map(t => count(t, 'none'))).toEqual([34, 33, 33]);
    for (const t of releaseThemeIds) {
      const perFlaw = ['wrong_issuer', 'stale_evidence', 'talk_without_numbers'].map(f => count(t, f));
      expect(Math.max(...perFlaw) - Math.min(...perFlaw)).toBeLessThanOrEqual(1);
    }
    expect(new Set(plan.file.items.map(i => i.baseScoreId)).size).toBe(plan.file.items.length);
    expect(new Set(plan.file.items.map(i => i.id)).size).toBe(plan.file.items.length);
  });

  it('gives each flawed copy exactly the flaw it is labelled with, by core checks and by the passages it cites', () => {
    for (const item of plan.file.items) {
      const codes = coreCheck(item);
      const own = item.passages.every(p => item.issuerKeys.includes(p.issuerKey));
      const inWindow = item.passages.every(p => p.availableOn <= item.asOf && p.availableOn >= windowStart(item.asOf, item.kpi.lookbackDays));
      const figures = item.passages.some(p => /\d/.test(p.text));
      if (item.flaw === 'wrong_issuer') {
        expect(codes).toContain('wrong_security');
        expect(codes).not.toContain('outside_window');
        expect(item.passages.some(p => item.issuerKeys.includes(p.issuerKey))).toBe(false);
        expect(inWindow && figures).toBe(true);
      } else if (item.flaw === 'stale_evidence') {
        expect(codes).toEqual(['outside_window']);
        expect(item.passages.every(p => p.availableOn < windowStart(item.asOf, item.kpi.lookbackDays))).toBe(true);
        expect(own && figures).toBe(true);
      } else if (item.flaw === 'talk_without_numbers') {
        expect(codes).toEqual([]);
        expect(Number(item.level)).toBeGreaterThanOrEqual(2);
        expect(figures).toBe(false);
        expect(own && inWindow).toBe(true);
      } else {
        expect(codes).toEqual([]);
        expect(own && inWindow && figures).toBe(true);
      }
    }
  });

  it('keeps a clean control on the stored citations of its base score', () => {
    const scores = new Map(extract.scores.map(s => [s.id, s]));
    for (const item of plan.file.items.filter(i => i.flaw === 'none')) expect(item.citations).toEqual(scores.get(item.baseScoreId)!.citations);
  });

  it('reports a flaw it cannot inject as a shortage and never fills it with another flaw', () => {
    const noOld: ReleaseExtract = { ...extract, passages: extract.passages.filter(p => p.availableOn >= '2024-01-01') };
    const short = planFlawed(noOld, options);
    expect(short.shortages).toHaveLength(3);
    expect(short.shortages.every(s => s.includes('stale_evidence: 0 of 12'))).toBe(true);
    expect(short.file.items.filter(i => i.flaw === 'stale_evidence')).toHaveLength(0);
    expect(short.file.items.filter(i => i.flaw === 'wrong_issuer')).toHaveLength(38);
  });
});

describe('the KPI and relevance samples', () => {
  it('takes 200 pairs evenly over the themes with every level the pool has', () => {
    const { picked, shortages } = pickKpiPairs(extract, { seed: 1, count: 200 });
    expect(shortages).toEqual([]);
    expect(releaseThemeIds.map(t => picked.filter(p => p.theme === t).length)).toEqual([67, 67, 66]);
    for (const t of releaseThemeIds) expect(new Set(picked.filter(p => p.theme === t).map(p => p.level))).toEqual(new Set(['0', '1', '2', '3', '4']));
    expect(pickKpiPairs(extract, { seed: 1, count: 200 }).picked).toEqual(picked);
  });

  it('takes 500 names evenly over the themes, half from fund holdings, with the names that have no evidence', () => {
    const { picked, shortages } = pickRelevanceNames(extract, { seed: 1, count: 500 });
    expect(shortages).toEqual([]);
    expect(releaseThemeIds.map(t => picked.filter(p => p.theme === t).length)).toEqual([167, 167, 166]);
    for (const t of releaseThemeIds) {
      const theme = picked.filter(p => p.theme === t);
      const pool = extract.names.filter(n => extract.runs.find(r => r.runId === n.runId)!.theme === t);
      expect(theme.filter(n => n.funds.length > 0)).toHaveLength(Math.min(pool.filter(n => n.funds.length > 0).length, Math.ceil(theme.length / 2)));
    }
    expect(picked.some(n => n.passageIds.length === 0)).toBe(true);
  });
});

describe('drawHumanSample', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `r-${i}`);
  it('draws ceil(10%) distinct records, the same for the same seed', () => {
    for (const [n, want] of [[200, 20], [202, 21], [500, 50], [7, 1]] as const) {
      const sample = drawHumanSample(ids(n), 3);
      expect(sample).toHaveLength(want);
      expect(new Set(sample).size).toBe(want);
      expect(sample.every(id => ids(n).includes(id))).toBe(true);
      expect(drawHumanSample([...ids(n)].reverse(), 3)).toEqual(sample);
    }
    expect(drawHumanSample(ids(200), 4)).not.toEqual(drawHumanSample(ids(200), 3));
  });
});

const labeller = { name: 'google/gemini-3.1-pro-preview', vendor: 'google', model: 'google/gemini-3.1-pro-preview', promptVersion: 'labeller@v1:abc' };
const scorerVendors = ['anthropic', 'deepseek', 'openai', 'typesafe'];
type LabelFiles = { [K in ManifestKind]: Extract<LabelFile, { kind: K }> };
function labelFiles(over: { vendor?: string } = {}): LabelFiles {
  const by = { ...labeller, ...(over.vendor ? { vendor: over.vendor } : {}) };
  const base = { schemaVersion: 1 as const, fixture: true, snapshotIds: ['snap'], labeller: by, createdAt: '2026-11-23T00:00:00.000Z', dropped: [], rejected: [], noWebSource: [], failed: [] };
  const note = { company: 'Company', subject: 'Subject', rationale: 'Passage e1.', cited: ['c1'], passages: [{ label: 'e1', chunkId: 'c1', source: 'https://example.test/doc', issuerKey: 'cik:0000000001', availableOn: '2026-03-02', text: 'Text 12%.' }] };
  const theme = (i: number) => releaseThemeIds[i % 3]!;
  const kpi: KpiRecord[] = Array.from({ length: 200 }, (_, i) => ({ id: `k${i}`, theme: theme(i), symbol: `S${i}`, snapshotId: 'snap', kpiId: 'kpi', level: String(i % 5) as KpiRecord['level'], labelledBy: by.name, evidenceIds: ['c1'] }));
  const reviewer: ReviewerRecord[] = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, theme: theme(i), symbol: `S${i}`, snapshotId: 'snap', kpiId: 'kpi', flaw: i < 100 ? 'wrong_issuer' : 'none', labelledBy: by.name, evidenceIds: ['c1'] }));
  const relevance: RelevanceRecord[] = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, theme: theme(i), symbol: `S${i}`, snapshotId: 'snap', relevant: i % 2 === 0, labelledBy: by.name, evidenceIds: i % 10 === 0 ? [] : ['c1'] }));
  const notes = (rs: { id: string }[]) => Object.fromEntries(rs.map(r => [r.id, note]));
  return {
    kpi: { ...base, kind: 'kpi', sampling: { seed: 1, requested: 200, pool: 400 }, records: kpi, notes: notes(kpi) },
    reviewer: { ...base, kind: 'reviewer', sampling: { seed: 1, requested: 120, pool: 300 }, records: reviewer, notes: notes(reviewer) },
    relevance: { ...base, kind: 'relevance', sampling: { seed: 1, requested: 500, pool: 600 }, records: relevance, notes: notes(relevance) },
  };
}
function checked(files: Record<ManifestKind, LabelFile>): Record<ManifestKind, HumanCheck> {
  return Object.fromEntries(Object.entries(files).map(([kind, f]) => {
    const sheet = checkSheet(f, 9);
    const csv = checkSheetCsv(sheet).replace(/,,\n/g, ',yes,\n');
    const result = recordHumanCheck(sheet, csv, ['A Colleague']);
    if (!result.ok) throw new Error(result.errors.join('; '));
    return [kind, result.check];
  })) as Record<ManifestKind, HumanCheck>;
}

describe('the spot check sheet', () => {
  const file = labelFiles().kpi;
  const sheet = checkSheet(file, 9);
  const rows = (agree: (i: number) => string) => checkSheetCsv(sheet).split('\n').map((line, i) => (i === 0 || !line ? line : line.replace(/,,$/, `,${agree(i)},`))).join('\n');

  it('counts the sampled labels the colleague agrees with', () => {
    const result = recordHumanCheck(sheet, rows(i => (i === 2 ? 'no' : 'yes')), ['A Colleague']);
    expect(result).toMatchObject({ ok: true, check: { n: 20, agreed: 19, reviewers: ['A Colleague'], recordsHash: hashRecords(file.records) } });
  });

  it('rejects a sheet with a row left blank, a missing row, a record outside the sample or no reviewer', () => {
    expect(recordHumanCheck(sheet, rows(i => (i === 3 ? '' : 'yes')), ['A']).ok).toBe(false);
    const full = rows(() => 'yes').trim().split('\n');
    expect(recordHumanCheck(sheet, full.slice(0, -1).join('\n'), ['A']).ok).toBe(false);
    expect(recordHumanCheck(sheet, [...full, full[1]!.replace(sheet.rows[0]!.id, 'k199999')].join('\n'), ['A']).ok).toBe(false);
    expect(recordHumanCheck(sheet, full.join('\n'), []).ok).toBe(false);
  });
});

describe('assembleRelease', () => {
  const input = (files = labelFiles(), human: Partial<Record<ManifestKind, HumanCheck>> = checked(files)) => ({ labels: files, human, scorerVendors, createdAt: '2026-11-23T00:00:00.000Z', allowFixture: true });
  const files = (r: ReturnType<typeof assembleRelease>) => Object.entries(r.manifests).map(([k, m]) => ({ name: `${k}.json`, raw: JSON.parse(JSON.stringify(m)) as unknown }));

  it('builds three AI-generated, human-sampled manifests that pass release validation', () => {
    const result = assembleRelease(input());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(validateReleaseSet(files(result), { allowFixture: true })).toEqual({ ok: true, errors: [] });
    expect(result.manifests.kpi).toMatchObject({ provenance: 'ai-generated-human-sampled', labellers: [{ kind: 'ai', vendor: 'google' }], scorerVendors, humanSample: { n: 20, agreed: 20 } });
    expect(assembleRelease({ ...input(), allowFixture: false }).ok).toBe(false);
  });

  it('is rejected once a record is edited after assembly', () => {
    const tampered = files(assembleRelease(input()));
    (tampered[0]!.raw as { records: Array<{ level?: string }> }).records[0]!.level = '4';
    const v = validateReleaseSet(tampered, { allowFixture: true });
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('contentHash');
  });

  it('refuses a kind with no recorded spot check, so it stays provisional', () => {
    const all = labelFiles();
    const { relevance: _, ...human } = checked(all);
    const result = assembleRelease(input(all, human));
    expect(result.ok).toBe(false);
    expect(result.manifests.relevance.provenance).toBe('provisional-ai');
    expect(result.errors.join('\n')).toContain('relevance.json: provenance "provisional-ai" is provisional');
  });

  it('refuses a spot check drawn from other records', () => {
    const all = labelFiles();
    const human = checked(all);
    all.kpi = { ...all.kpi, records: all.kpi.records.map((r, i) => (i === 0 ? { ...r, level: '4' as const } : r)) };
    const result = assembleRelease(input(all, human));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('kpi: the spot check was drawn from other records');
  });

  it('refuses a labeller from the vendor of a scorer or the Reviewer', () => {
    const all = labelFiles({ vendor: 'deepseek' });
    const result = assembleRelease(input(all, checked(all)));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('is from deepseek, the vendor of a scorer or the Reviewer');
  });
});

describe('the frozen reference funds', () => {
  const read = (file: string) => readFileSync(new URL(`../../../docs/reference/${file}`, import.meta.url), 'utf8');
  const holdings = [
    ...parseHoldings('GRID', read('grid-holdings-2026-11-20.csv')), ...parseHoldings('CIBR', read('cibr-holdings-2026-11-20.csv')),
    ...parseHoldings('BOTZ', read('botz-holdings-2026-11-20.csv')), ...parseHoldings('ICLN', read('icln-holdings-2026-11-20.csv')),
  ];
  it('reads the equity rows of each issuer file and leaves out cash, currencies, futures and swaps', () => {
    const count = (fund: string) => holdings.filter(h => h.fund === fund).length;
    expect([count('GRID'), count('CIBR'), count('ICLN')]).toEqual([132, 47, 101]);
    expect(holdings.filter(h => h.fund === 'BOTZ').some(h => /CASH|WON|DOLLAR/.test(h.name))).toBe(false);
    expect(holdings.some(h => h.fund === 'ICLN' && /S&P500|USD CASH/.test(h.name))).toBe(false);
  });
  it('matches a store name to the funds that hold it, and nothing to a name no fund holds', () => {
    expect(fundsHolding({ symbol: 'PWR.US', name: 'Quanta Services Inc' }, holdings)).toEqual(['GRID']);
    expect(fundsHolding({ symbol: 'PANW.US', name: 'Palo Alto Networks Inc' }, holdings)).toEqual(['CIBR']);
    expect(fundsHolding({ symbol: 'FSLR.US', name: 'First Solar Inc' }, holdings)).toEqual(['ICLN']);
    expect(fundsHolding({ symbol: 'KO.US', name: 'Coca-Cola Co' }, holdings)).toEqual([]);
  });
});
