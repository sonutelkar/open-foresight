import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { availableQuantIds, bucketLevel, constrainedDraftSchema, frameworkToDraft, frameworkDraftSchema, validateFramework, type FrameworkDraft } from './framework.js';
import { enabledSources, quantCatalog, sourceCatalog, sourceIds } from './sources.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/framework/valid-draft.json', import.meta.url), 'utf8')) as FrameworkDraft;
const all = enabledSources({ eodhd: true });
const clone = (): FrameworkDraft => structuredClone(golden);
const codes = (draft: unknown, sources = all) => {
  const r = validateFramework(draft, { availableSources: sources });
  return r.ok ? [] : [...new Set(r.errors.map(e => e.code))].sort();
};

describe('validateFramework', () => {
  it('accepts the golden framework and returns a typed result', () => {
    const r = validateFramework(golden, { availableSources: all });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.framework.kpis).toHaveLength(5);
    expect(r.framework.kpis.reduce((s, k) => s + k.weightPercent, 0)).toBe(100);
    const quant = r.framework.kpis.find(k => k.method === 'quant');
    expect(quant && 'quantQuery' in quant ? quant.quantQuery : undefined).toBe('rd_intensity');
    expect(frameworkDraftSchema.safeParse(golden).success).toBe(true);
  });

  it('rejects weights that do not sum to 100 and weights out of range', () => {
    const d = clone(); d.kpis[0]!.weightPercent = 35;
    expect(codes(d)).toEqual(['weight_total']);
    const e = clone(); e.kpis[0]!.weightPercent = 130; e.kpis[1]!.weightPercent = -85;
    expect(codes(e)).toEqual(['weight']);
  });

  it('rejects incomplete rubrics for judgement and extract_then_quant KPIs', () => {
    const d = clone(); d.kpis[2]!.rubric!.level3 = '';
    expect(codes(d)).toEqual(['incomplete_rubric']);
    const e = clone(); e.kpis[0]!.rubric = null;
    expect(codes(e)).toEqual(['incomplete_rubric']);
    const f = clone(); f.kpis[3]!.rubric!.unknownRule = 'n/a';
    expect(codes(f)).toEqual(['incomplete_rubric']);
  });

  it('rejects unavailable and unknown sources', () => {
    expect(codes(golden, enabledSources({ eodhd: false }))).toEqual([]);
    const d = clone(); d.kpis[4]!.sources = ['market_cap', 'prices'];
    expect(codes(d, enabledSources({ eodhd: false }))).toEqual(['unavailable_source']);
    expect(codes(d, all)).toEqual([]);
    const e = clone(); e.kpis[0]!.sources = ['sec_filings', 'bloomberg_terminal'];
    expect(codes(e)).toEqual(['unknown_source']);
    const f = clone(); f.kpis[0]!.sources = [];
    expect(codes(f)).toEqual(['no_sources']);
  });

  it('caps the weight on market factor KPIs and counts only quant KPIs that use a market function', () => {
    const d = clone(); d.kpis[0]!.weightPercent = 15; d.kpis[4]!.weightPercent = 25;
    expect(codes(d)).toEqual(['factor_weight']);
    const edge = clone(); edge.kpis[0]!.weightPercent = 20; edge.kpis[4]!.weightPercent = 20;
    expect(codes(edge)).toEqual([]);
    const financial = clone(); financial.kpis[0]!.weightPercent = 5; financial.kpis[1]!.weightPercent = 40;
    expect(codes(financial)).toEqual([]);
  });

  it('rejects more than one gate, and accepts none or one', () => {
    const d = clone(); d.kpis[1]!.isGate = true;
    expect(codes(d)).toEqual(['gate_count']);
    const none = clone(); none.kpis[0]!.isGate = false;
    expect(codes(none)).toEqual([]);
  });

  it('checks thresholds and quant functions by method', () => {
    const a = clone(); a.kpis[1]!.thresholds = [0.01, 0.03, 0.03, 0.1];
    expect(codes(a)).toEqual(['bad_thresholds']);
    const b = clone(); b.kpis[1]!.thresholds = [0.01, 0.03, 0.06];
    expect(codes(b)).toEqual(['bad_thresholds']);
    const c = clone(); c.kpis[1]!.quantQuery = 'ebitda_margin';
    expect(codes(c)).toEqual(['unknown_quant_query']);
    const d = clone(); d.kpis[1]!.sources = ['market_cap'];
    expect(codes(d)).toEqual(['missing_quant_source']);
    const e = clone(); e.kpis[1]!.rubric = golden.kpis[2]!.rubric;
    expect(codes(e)).toEqual(['unexpected_rubric']);
    const f = clone(); f.kpis[2]!.quantQuery = 'rd_intensity';
    expect(codes(f)).toEqual(['unexpected_quant_query']);
    const g = clone(); g.kpis[2]!.thresholds = [1, 2, 3, 4];
    expect(codes(g)).toEqual(['unexpected_thresholds']);
    const h = clone(); h.kpis[0]!.thresholds = null;
    expect(codes(h)).toEqual(['bad_thresholds']);
  });

  it('requires an extraction with a unit for extract_then_quant KPIs and keeps thresholds in that unit', () => {
    const missing = clone(); missing.kpis[0]!.extraction = null;
    expect(codes(missing)).toEqual(['missing_extraction']);
    const brief = clone(); brief.kpis[0]!.extraction = { target: 'Too short', unit: 'fraction' };
    expect(codes(brief)).toEqual(['missing_extraction']);
    const onQuant = clone(); onQuant.kpis[1]!.extraction = golden.kpis[0]!.extraction;
    expect(codes(onQuant)).toEqual(['unexpected_extraction']);
    const onJudgement = clone(); onJudgement.kpis[2]!.extraction = golden.kpis[0]!.extraction;
    expect(codes(onJudgement)).toEqual(['unexpected_extraction']);
    const percent = clone(); percent.kpis[0]!.thresholds = [5, 15, 30, 50];
    expect(codes(percent)).toEqual(['threshold_unit']);
    const usd = clone(); usd.kpis[0]!.extraction = { target: golden.kpis[0]!.extraction!.target, unit: 'usd' }; usd.kpis[0]!.thresholds = [1e8, 5e8, 1e9, 5e9];
    expect(codes(usd)).toEqual([]);
    const negative = clone(); negative.kpis[0]!.extraction = { target: golden.kpis[0]!.extraction!.target, unit: 'count' }; negative.kpis[0]!.thresholds = [-1, 1, 2, 3];
    expect(codes(negative)).toEqual(['threshold_unit']);
  });

  it('checks counts, ids, sub-themes, lookback and text length', () => {
    const few = clone(); few.kpis = few.kpis.slice(0, 2); few.kpis[0]!.weightPercent = 60; few.kpis[1]!.weightPercent = 40;
    expect(codes(few)).toContain('kpi_count');
    const many = clone(); for (let i = 0; i < 4; i++) many.kpis.push({ ...structuredClone(golden.kpis[3]!), id: `extra_kpi_${i}`, weightPercent: 0 });
    expect(codes(many)).toEqual(['kpi_count']);
    const oneSub = clone(); oneSub.subThemes = oneSub.subThemes.slice(0, 1); oneSub.kpis.forEach(k => { k.subThemeId = 'grid_hardware'; });
    expect(codes(oneSub)).toEqual(['sub_theme_count']);
    const dup = clone(); dup.kpis[1]!.id = dup.kpis[0]!.id;
    expect(codes(dup)).toEqual(['duplicate_id']);
    const bad = clone(); bad.kpis[0]!.id = 'Grid Revenue!';
    expect(codes(bad)).toEqual(['bad_id']);
    const nosub = clone(); nosub.kpis[0]!.subThemeId = 'nonexistent';
    expect(codes(nosub)).toEqual(['unknown_sub_theme']);
    const empty = clone(); empty.kpis[2]!.subThemeId = 'efficiency';
    expect(codes(empty)).toEqual(['empty_sub_theme']);
    const look = clone(); look.kpis[0]!.lookbackDays = 5;
    expect(codes(look)).toEqual(['lookback']);
    const text = clone(); text.kpis[0]!.definition = 'Too short';
    expect(codes(text)).toEqual(['text_too_short']);
  });

  it('reports every violation at once, with a path and a message', () => {
    const d = clone(); d.kpis[0]!.weightPercent = 40; d.kpis[1]!.isGate = true; d.kpis[2]!.rubric!.level1 = '';
    const r = validateFramework(d, { availableSources: all });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map(e => e.code).sort()).toEqual(['gate_count', 'incomplete_rubric', 'weight_total']);
    expect(r.errors.every(e => e.path && e.message.length > 10)).toBe(true);
  });

  it('reports a shape error for output that is not a framework draft', () => {
    expect(codes({ kpis: 'many' })).toEqual(['shape']);
    expect(codes(null)).toEqual(['shape']);
    const d = clone() as Record<string, unknown>; d.extra = 1;
    expect(codes(d)).toEqual(['shape']);
    const nonInt = clone(); nonInt.kpis[0]!.weightPercent = 30.5;
    expect(codes(nonInt)).toEqual(['shape']);
  });
});

describe('constrainedDraftSchema', () => {
  it('limits sources to the enabled ones and quant functions to the catalog', () => {
    const schema = constrainedDraftSchema(enabledSources({ eodhd: false }));
    expect(schema.safeParse(golden).success).toBe(true);
    const d = clone(); d.kpis[4]!.sources = ['prices'];
    expect(schema.safeParse(d).success).toBe(false);
    const e = clone(); e.kpis[1]!.quantQuery = 'made_up';
    expect(schema.safeParse(e).success).toBe(false);
    const f = clone(); f.kpis[1]!.quantQuery = 'adv_usd_20d';
    expect(schema.safeParse(f).success).toBe(false);
    expect(constrainedDraftSchema(all).safeParse(f).success).toBe(true);
    expect(availableQuantIds(enabledSources({ eodhd: false }))).not.toContain('adv_usd_20d');
  });
});

describe('catalogs and bucketing', () => {
  it('only enables prices with the EODHD adapter', () => {
    expect(enabledSources({ eodhd: false })).not.toContain('prices');
    expect(enabledSources({ eodhd: true })).toContain('prices');
    expect(sourceIds.length).toBe(Object.keys(sourceCatalog).length);
  });
  it('lists only known sources for each quant function', () => {
    for (const q of Object.values(quantCatalog)) for (const s of q.sources) expect(sourceIds).toContain(s);
  });
  it('maps a value to the number of thresholds it has reached', () => {
    const t = [1, 2, 3, 4] as const;
    expect([0.5, 1, 1.5, 2, 3.9, 4, 99].map(v => bucketLevel(v, t))).toEqual([0, 1, 1, 2, 3, 4, 4]);
    expect(() => bucketLevel(Number.NaN, t)).toThrow();
  });
});


describe('frameworkToDraft', () => {
  it('round trips a validated framework through the validator unchanged', () => {
    const first = validateFramework(golden, { availableSources: all });
    if (!first.ok) throw new Error('golden must be valid');
    const again = validateFramework(frameworkToDraft(first.framework), { availableSources: all });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.framework).toEqual(first.framework);
  });
  it('lets the validator check a PM edit with the same rules', () => {
    const first = validateFramework(golden, { availableSources: all });
    if (!first.ok) throw new Error('golden must be valid');
    const edited = structuredClone(first.framework);
    edited.kpis[0]!.weightPercent = 35;
    const r = validateFramework(frameworkToDraft(edited), { availableSources: all });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map(e => e.code)).toEqual(['weight_total']);
    const rubric = structuredClone(first.framework);
    const judgement = rubric.kpis.find(k => k.method === 'judgement');
    if (judgement && judgement.method === 'judgement') judgement.rubric.levels['2'] = '';
    const r2 = validateFramework(frameworkToDraft(rubric), { availableSources: all });
    expect(!r2.ok && r2.errors.map(e => e.code)).toEqual(['incomplete_rubric']);
  });
  it('passes non objects through and leaves missing parts to the validator', () => {
    expect(frameworkToDraft(null)).toBeNull();
    expect(frameworkToDraft('x')).toBe('x');
    expect(validateFramework(frameworkToDraft({ kpis: 'many' }), { availableSources: all }).ok).toBe(false);
    expect(validateFramework(frameworkToDraft({ subThemes: [], kpis: [null], rationale: 'x' }), { availableSources: all }).ok).toBe(false);
  });
});
