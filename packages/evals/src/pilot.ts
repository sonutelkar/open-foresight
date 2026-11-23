import { z } from 'zod';
import { citationReportSchema, type CitationReport, type GateResult } from './citations.js';

const ratio = z.number().finite().min(0).max(1);
const count = z.number().int().nonnegative();
const usd = z.number().finite().nonnegative();
const ms = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });

/** A pilot run must finish in under 30 minutes of machine time: run start to done, less the wait at the approval gate. */
export const pilotElapsedLimitMs = 30 * 60_000;
/** Release gates on the labelled set. Only a human-labelled set can satisfy them. */
export const releaseGateThresholds = { weightedKappa: 0.6, stability: 0.95 } as const;
const releaseGateReason = 'The labelled set is AI-generated and provisional, and this release gate needs a human-labelled set.';

/** Agreement measured on an AI-labelled set. It is always provisional and never counts toward a release gate. */
export const pilotLabelledSetSchema = z.object({
  source: z.literal('ai'),
  pairs: count,
  weightedKappa: z.number().finite().min(-1).max(1).nullable(),
  exactAgreement: ratio.nullable(),
  stability: ratio.nullable(),
  provisional: z.literal(true),
}).strict();
export type PilotLabelledSet = z.infer<typeof pilotLabelledSetSchema>;

const releaseGate = <T extends number>(required: T) => z.object({ required: z.literal(required), satisfied: z.literal(false), reason: z.string().min(1) }).strict();
/** A rate gate with nothing measured has no actual value and cannot pass. */
const rateGate = z.union([
  z.object({ required: ratio, actual: z.null(), passed: z.literal(false) }).strict(),
  z.object({ required: ratio, actual: ratio, passed: z.boolean() }).strict(),
]);

export const pilotReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  /** The first 120 characters of the brief. */
  theme: z.string().max(120),
  asOf: z.string().date(),
  snapshotId: z.string().min(1),
  host: z.literal('local'),
  timestamps: z.object({ createdAt: instant, approvedAt: instant, doneAt: instant, elapsedMs: ms, gateWaitMs: ms, machineMs: ms }).strict(),
  approval: z.object({ analyst: z.string().min(1), decisionId: z.string().min(1) }).strict(),
  models: z.array(z.object({ role: z.string(), model: z.string(), provider: z.string().nullable(), calls: count, costUsd: usd, medianLatencyMs: z.number().finite().nonnegative().nullable() }).strict()),
  embeddingCostUsd: usd,
  totalCostUsd: usd,
  /** The stored basket funnel, or null when the run has no basket. */
  funnel: z.record(z.string(), count).nullable(),
  /** Latest valid score per security and KPI: counts by method then level, and how many scores carry each adjustment code. */
  scores: z.object({ total: count, byMethod: z.record(z.string(), z.record(z.string(), count)), adjustments: z.record(z.string(), count) }).strict(),
  citations: citationReportSchema,
  /** The same checks on the citations behind the basket's members only, which is the question the phase gate asks. Absent for a run with no members. */
  basketCitations: citationReportSchema.optional(),
  gates: z.object({
    /** `required` is an exclusive limit on machine time in milliseconds, and `actual` is the machine time. */
    elapsed: z.object({ required: z.literal(pilotElapsedLimitMs), actual: ms, elapsedMs: ms, passed: z.boolean() }).strict(),
    citationIds: rateGate,
    verbatim: rateGate,
    /** A pilot that selects no names has nothing to trace, so passing the citation gates on it means nothing. */
    basket: z.object({ required: z.literal(1), actual: count, passed: z.boolean() }).strict(),
    passed: z.boolean(),
  }).strict().superRefine((gates, ctx) => {
    if (gates.elapsed.passed !== gates.elapsed.actual < gates.elapsed.required) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['elapsed', 'passed'], message: 'The elapsed gate does not match its machine time.' });
    if (gates.basket.passed !== gates.basket.actual >= gates.basket.required) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['basket', 'passed'], message: 'The basket gate does not match the number of selected names.' });
    if (gates.passed !== (gates.elapsed.passed && gates.citationIds.passed && gates.verbatim.passed && gates.basket.passed)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passed'], message: 'The overall result must pass only when every gate passes.' });
  }),
  labelledSet: pilotLabelledSetSchema.optional(),
  releaseGates: z.object({ weightedKappa: releaseGate(releaseGateThresholds.weightedKappa), stability: releaseGate(releaseGateThresholds.stability) }).strict(),
}).strict();
export type PilotReport = z.infer<typeof pilotReportSchema>;

/** What the pilot script reads from the store for one finished run. */
export type PilotInput = {
  runId: string; brief: string; asOf: string; snapshotId: string; createdAt: Date;
  statusHistory: ReadonlyArray<{ status: string; at: Date }>;
  approval: { decisionId: string; analyst: string; at: Date };
  llmCalls: ReadonlyArray<{ role: string; model: string; provider: string | null; costUsd: number | null; latencyMs: number | null }>;
  embeddingCostsUsd: ReadonlyArray<number | null>;
  funnel: Readonly<Record<string, number>> | null;
  scores: ReadonlyArray<{ method: string; level: string; adjustmentCodes: readonly string[] }>;
  citations: CitationReport;
  basketCitations?: CitationReport;
  labelledSet?: PilotLabelledSet;
};

/** Sums dollar amounts and rounds away floating point noise below a picodollar. */
const sumUsd = (amounts: ReadonlyArray<number | null>) => Math.round(amounts.reduce<number>((total, a) => total + (a ?? 0), 0) * 1e12) / 1e12;
const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const rate = (gate: GateResult) => gate.rate === null ? { required: gate.required, actual: null, passed: false as const } : { required: gate.required, actual: gate.rate, passed: gate.passed };

function modelUsage(calls: PilotInput['llmCalls']): PilotReport['models'] {
  const groups = new Map<string, PilotInput['llmCalls'][number][]>();
  for (const call of calls) {
    const key = JSON.stringify([call.role, call.model, call.provider]);
    const group = groups.get(key);
    if (group) group.push(call); else groups.set(key, [call]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({
    role: group[0].role, model: group[0].model, provider: group[0].provider, calls: group.length,
    costUsd: sumUsd(group.map(c => c.costUsd)),
    medianLatencyMs: median(group.flatMap(c => c.latencyMs === null ? [] : [c.latencyMs])),
  }));
}

function scoreCounts(scores: PilotInput['scores']): PilotReport['scores'] {
  const byMethod: Record<string, Record<string, number>> = {}, adjustments: Record<string, number> = {};
  for (const s of scores) {
    const levels = (byMethod[s.method] ??= {});
    levels[s.level] = (levels[s.level] ?? 0) + 1;
    for (const code of new Set(s.adjustmentCodes)) adjustments[code] = (adjustments[code] ?? 0) + 1;
  }
  return { total: scores.length, byMethod, adjustments };
}

/**
 * Assembles the pilot report for one finished run and checks it against the schema.
 * Machine time is the run's elapsed time less the wait between reaching the approval gate and the approval.
 * Throws when the run never reached done or was approved without reaching the gate, because then no time can be measured.
 */
export function buildPilotReport(input: PilotInput): PilotReport {
  const doneAt = input.statusHistory.filter(s => s.status === 'done').at(-1)?.at;
  if (!doneAt) throw new Error(`Run ${input.runId} has no done status`);
  const gateAt = input.statusHistory.filter(s => s.status === 'awaiting_kpi_approval' && s.at <= input.approval.at).at(-1)?.at;
  if (!gateAt) throw new Error(`Run ${input.runId} was approved without reaching the approval gate`);
  const elapsedMs = doneAt.getTime() - input.createdAt.getTime();
  const gateWaitMs = input.approval.at.getTime() - gateAt.getTime();
  const machineMs = elapsedMs - gateWaitMs;
  const models = modelUsage(input.llmCalls);
  const embeddingCostUsd = sumUsd(input.embeddingCostsUsd);
  const elapsed = { required: pilotElapsedLimitMs, actual: machineMs, elapsedMs, passed: machineMs < pilotElapsedLimitMs };
  const citationIds = rate(input.citations.gates.citationIds), verbatim = rate(input.citations.gates.verbatim);
  const selected = input.funnel?.selected ?? 0;
  const basket = { required: 1 as const, actual: selected, passed: selected >= 1 };
  return pilotReportSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    theme: input.brief.slice(0, 120),
    asOf: input.asOf,
    snapshotId: input.snapshotId,
    host: 'local',
    timestamps: { createdAt: input.createdAt.toISOString(), approvedAt: input.approval.at.toISOString(), doneAt: doneAt.toISOString(), elapsedMs, gateWaitMs, machineMs },
    approval: { analyst: input.approval.analyst, decisionId: input.approval.decisionId },
    models,
    embeddingCostUsd,
    totalCostUsd: sumUsd([...models.map(m => m.costUsd), embeddingCostUsd]),
    funnel: input.funnel,
    scores: scoreCounts(input.scores),
    citations: input.citations,
    ...(input.basketCitations ? { basketCitations: input.basketCitations } : {}),
    gates: { elapsed, citationIds, verbatim, basket, passed: elapsed.passed && citationIds.passed && verbatim.passed && basket.passed },
    labelledSet: input.labelledSet,
    releaseGates: {
      weightedKappa: { required: releaseGateThresholds.weightedKappa, satisfied: false, reason: releaseGateReason },
      stability: { required: releaseGateThresholds.stability, satisfied: false, reason: releaseGateReason },
    },
  });
}
