import type { Framework, Kpi } from './framework.js';

/** What changed between the framework the Designer drafted and the one an analyst is about to approve. Each count is a number of KPIs. */
export type FrameworkEdits = { total: number; weights: number; gate: number; rubrics: number; sources: number; wording: number };

const rubricOf = (k: Kpi) => JSON.stringify([('rubric' in k ? k.rubric : null), ('thresholds' in k ? k.thresholds : null), ('extraction' in k ? k.extraction : null)]);

/**
 * Compares two frameworks KPI by KPI, matched by id. A KPI that appears in only one counts as a wording change, because the editor cannot add or remove KPIs
 * and an unmatched one means the inputs are not from one draft. A NaN weight from an empty field counts as a changed weight.
 */
export function diffFramework(drafted: Framework, current: Framework): FrameworkEdits {
  const before = new Map(drafted.kpis.map(k => [k.id, k]));
  const out: FrameworkEdits = { total: 0, weights: 0, gate: 0, rubrics: 0, sources: 0, wording: 0 };
  for (const k of current.kpis) {
    const b = before.get(k.id);
    if (!b) { out.wording++; continue; }
    if (!Object.is(b.weightPercent, k.weightPercent)) out.weights++;
    if (b.isGate !== k.isGate) out.gate++;
    if (rubricOf(b) !== rubricOf(k)) out.rubrics++;
    if (JSON.stringify([...b.sources].sort()) !== JSON.stringify([...k.sources].sort())) out.sources++;
    if (b.name !== k.name || b.definition !== k.definition || !Object.is(b.lookbackDays, k.lookbackDays)) out.wording++;
  }
  out.wording += drafted.kpis.filter(k => !current.kpis.some(c => c.id === k.id)).length;
  out.total = out.weights + out.gate + out.rubrics + out.sources + out.wording;
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A short sentence for the approval bar, such as "2 weights and 1 rubric changed from the draft". Empty when nothing changed. */
export function describeEdits(e: FrameworkEdits): string {
  const parts = [
    e.weights && plural(e.weights, 'weight'), e.gate && (e.gate === 1 ? 'the gate' : plural(e.gate, 'gate change')), e.rubrics && plural(e.rubrics, 'rubric'),
    e.sources && plural(e.sources, 'source list'), e.wording && plural(e.wording, 'name or definition', 'names or definitions'),
  ].filter(Boolean) as string[];
  if (parts.length === 0) return '';
  const last = parts.pop()!;
  return `${parts.length ? `${parts.join(', ')} and ${last}` : last} changed from the draft`;
}
