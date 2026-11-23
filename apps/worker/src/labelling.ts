import { inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { levelKeys, type DocKind, type Framework, type Kpi, type Level, type ScoreLevel } from '@open-foresight/core';
import { documentChunks, kpiFrameworkVersions, kpiScores, llmCalls, runUniverse, runs } from '@open-foresight/db';
import type { StructuredGenerator } from '@open-foresight/agents';
import { labelOutputSchema, type LabelledPair } from '@open-foresight/evals';
import { render, type Prompt } from '@open-foresight/prompts';

/** A passage label as the Analyst stored it with its score. The text is not stored there, so it is reloaded from document_chunks. */
export type EvidenceRef = { id: string; chunkId: string; docKind: DocKind; section: string; availableOn: string };
/** A stored score as the pool reads it. It never carries the Analyst's rationale, citations or raw answer, so none of them can reach the labeller. */
export type StoredScore = {
  id: string; runId: string; securityId: string; symbol: string; kpiId: string; method: string; level: ScoreLevel;
  valid: boolean; attempt: number; promptVersion: string | null; llmCallId: string | null; asOf: string; evidence: EvidenceRef[];
};
export type PoolScore = Omit<StoredScore, 'level'> & { level: Level };
export type Passage = EvidenceRef & { text: string };
export type LabelTask = {
  score: PoolScore; company: string; kpi: Extract<Kpi, { method: 'judgement' }>; passages: Passage[];
  /** The user message of the Analyst call that produced the score, when its audit row recorded one, and that call's model. */
  analystUser: string | null; analystModel: string | null;
};

/**
 * The pairs that can be labelled: the latest valid score per run, security and KPI, scored by the Analyst's judgement prompt with a known level and at least one passage.
 * A level the Jev exposure check settled is not the Analyst's, so it is left out.
 */
export function selectPool(rows: readonly StoredScore[]): PoolScore[] {
  const latest = new Map<string, StoredScore>();
  for (const r of rows) {
    if (!r.valid) continue;
    const key = `${r.runId}|${r.securityId}|${r.kpiId}`;
    if ((latest.get(key)?.attempt ?? 0) < r.attempt) latest.set(key, r);
  }
  return [...latest.values()].filter((r): r is PoolScore =>
    r.method === 'judgement' && r.level !== 'unknown' && r.evidence.length > 0 && (r.promptVersion?.startsWith('analyst-judgement@') ?? false));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byPair = (a: PoolScore, b: PoolScore) => cmp(a.runId, b.runId) || cmp(a.symbol, b.symbol) || cmp(a.kpiId, b.kpiId);

/** mulberry32, so a seed gives the same sample on every machine. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Chooses `count` pairs, or all of them when the pool is not larger. The sample is stratified by the Analyst's level: every level present gets one pair first,
 * then the rest go in proportion to what each level has left. Within a level the choice is a seeded shuffle. No label is looked at.
 */
export function samplePool(pool: readonly PoolScore[], count: number, seed: number): PoolScore[] {
  if (pool.length <= count) return [...pool].sort(byPair);
  const random = seeded(seed);
  const groups = levelKeys.map(level => {
    const g = pool.filter(p => p.level === level).sort((a, b) => cmp(a.id, b.id));
    for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [g[i], g[j]] = [g[j]!, g[i]!]; }
    return g;
  }).filter(g => g.length > 0);
  const take = groups.map(() => 0);
  let left = count;
  for (const i of groups.map((_, i) => i).sort((a, b) => groups[b]!.length - groups[a]!.length || a - b)) if (left > 0) { take[i] = 1; left--; }
  const spare = groups.map((g, i) => g.length - take[i]!);
  const total = spare.reduce((s, x) => s + x, 0);
  const shares = spare.map(s => (left * s) / total);
  shares.forEach((s, i) => { take[i]! += Math.floor(s); });
  let rest = left - shares.reduce((s, x) => s + Math.floor(x), 0);
  for (const [, i] of shares.map((s, i) => [s - Math.floor(s), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])) if (rest-- > 0) take[i]!++;
  return groups.flatMap((g, i) => g.slice(0, take[i])).sort(byPair);
}

const kindLabel: Record<DocKind, string> = { sec_filing: 'SEC filing', esef_filing: 'ESEF report', web_report: 'Company report', company_profile: 'Company profile' };

/** The labeller's user message. Passages use the Analyst's layout from `packages/agents/src/analyst.ts`, and `analystCheck` proves it still matches on real runs. */
export function labellerUser(prompt: Prompt, task: Pick<LabelTask, 'score' | 'company' | 'kpi' | 'passages'>): string {
  const { score, kpi } = task;
  return render(prompt.user, {
    company: task.company, symbol: score.symbol, as_of: score.asOf, kpi_name: kpi.name, definition: kpi.definition,
    rubric: levelKeys.map(l => `${l}: ${kpi.rubric.levels[l]}`).join('\n'), unknown_rule: kpi.rubric.unknown,
    passages: task.passages.map(p => `[${p.id}] ${kindLabel[p.docKind]} available ${p.availableOn} | ${p.section}\n${p.text}`).join('\n\n---\n\n'),
  });
}

/** Whether the labeller is shown what the Analyst was shown: its message without the closing instruction must open the Analyst's recorded message. */
export function analystCheck(user: string, analystUser: string | null): 'same' | 'different' | 'not_recorded' {
  if (analystUser === null) return 'not_recorded';
  return analystUser.startsWith(`${user.slice(0, user.lastIndexOf('\n\n'))}\n\n`) ? 'same' : 'different';
}

/** Labels one pair through the gateway, audited under `auditRunId` with role `labeller`. The model never sees the Analyst's level or rationale. */
export async function labelTask(gateway: StructuredGenerator, prompt: Prompt, task: LabelTask, auditRunId: string, onAudit?: (id: string) => void): Promise<LabelledPair> {
  const chunkIds = task.passages.map(p => p.chunkId);
  const out = await gateway.generate({
    runId: auditRunId, role: 'labeller', promptVersion: prompt.promptVersion, system: prompt.system, user: labellerUser(prompt, task),
    schemaName: 'kpi_label', schema: labelOutputSchema, inputEvidenceIds: chunkIds, maxOutputTokens: 8000, onAudit,
  });
  const s = task.score;
  return { id: s.id, runId: s.runId, symbol: s.symbol, kpiId: s.kpiId, method: 'judgement', analystLevel: s.level, labelLevel: out.level, labelRationale: out.rationale, chunkIds };
}

/** The labelling pool of the given runs. */
export async function loadPool(db: PostgresJsDatabase, runIds: readonly string[]): Promise<PoolScore[]> {
  const rows = await db.select({
    id: kpiScores.id, runId: kpiScores.runId, securityId: kpiScores.securityId, symbol: kpiScores.symbol, kpiId: kpiScores.kpiId, method: kpiScores.method,
    level: kpiScores.level, valid: kpiScores.valid, attempt: kpiScores.attempt, promptVersion: kpiScores.promptVersion, llmCallId: kpiScores.llmCallId,
    asOf: kpiScores.asOf, evidence: kpiScores.evidence,
  }).from(kpiScores).where(inArray(kpiScores.runId, [...runIds]));
  return selectPool(rows.map(r => ({ ...r, level: r.level as ScoreLevel, evidence: r.evidence as EvidenceRef[] })));
}

const userMessage = (params: unknown): string | null => {
  const messages = (params as { messages?: unknown } | null)?.messages;
  const user = Array.isArray(messages) ? (messages as Array<{ role?: unknown; content?: unknown }>).find(m => m?.role === 'user')?.content : undefined;
  return typeof user === 'string' ? user : null;
};

/** Everything the labeller is shown for each pair: the approved KPI, the company name the Analyst used, and the passage texts, plus the Analyst's recorded message to check against. */
export async function loadTasks(db: PostgresJsDatabase, scores: readonly PoolScore[]): Promise<LabelTask[]> {
  if (scores.length === 0) return [];
  const runIds = [...new Set(scores.map(s => s.runId))];
  const runRows = await db.select({ id: runs.id, frameworkVersion: runs.frameworkVersion }).from(runs).where(inArray(runs.id, runIds));
  const versionIds = runRows.flatMap(r => (r.frameworkVersion ? [r.frameworkVersion] : []));
  const versions = versionIds.length ? await db.select({ id: kpiFrameworkVersions.id, framework: kpiFrameworkVersions.framework }).from(kpiFrameworkVersions).where(inArray(kpiFrameworkVersions.id, versionIds)) : [];
  const frameworks = new Map(runRows.map(r => [r.id, versions.find(v => v.id === r.frameworkVersion)?.framework as Framework | undefined]));
  const names = await db.select({ runId: runUniverse.runId, symbol: runUniverse.symbol, name: runUniverse.name }).from(runUniverse).where(inArray(runUniverse.runId, runIds));
  const chunkIds = [...new Set(scores.flatMap(s => s.evidence.map(e => e.chunkId)))];
  const texts = new Map((await db.select({ id: documentChunks.id, text: documentChunks.text }).from(documentChunks).where(inArray(documentChunks.id, chunkIds))).map(c => [c.id, c.text]));
  const callIds = scores.flatMap(s => (s.llmCallId ? [s.llmCallId] : []));
  const calls = new Map((callIds.length ? await db.select({ id: llmCalls.id, params: llmCalls.params, model: llmCalls.model }).from(llmCalls).where(inArray(llmCalls.id, callIds)) : []).map(c => [c.id, c]));
  return scores.map(score => {
    const kpi = frameworks.get(score.runId)?.kpis.find(k => k.id === score.kpiId);
    if (kpi?.method !== 'judgement') throw new Error(`Run ${score.runId} has no approved judgement KPI ${score.kpiId}`);
    const passages = score.evidence.map(e => {
      const text = texts.get(e.chunkId);
      if (text === undefined) throw new Error(`Passage ${e.chunkId} of score ${score.id} is not in document_chunks`);
      return { id: e.id, chunkId: e.chunkId, docKind: e.docKind, section: e.section, availableOn: e.availableOn, text };
    });
    const call = score.llmCallId ? calls.get(score.llmCallId) : undefined;
    const company = names.find(n => n.runId === score.runId && n.symbol === score.symbol)?.name ?? score.symbol;
    return { score, company, kpi, passages, analystUser: userMessage(call?.params), analystModel: call?.model ?? null };
  });
}
