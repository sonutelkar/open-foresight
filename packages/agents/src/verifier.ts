import { inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { DecisionRequest, DecisionResult } from '@open-foresight/llm';
import { claimFor, decideSupport, levelsToCheck, spanWindow, supportThresholds, unsupportedLevelCap, type Kpi, type ResolvedCitation, type ScoreAdjustment, type ScoreLevel, type SupportDecision, type SupportProbe } from '@open-foresight/core';
import { documentChunks } from '@open-foresight/db';

/** The part of the gateway the span check uses. `createGateway` from `@open-foresight/llm` satisfies it. */
export type SpanJudge = { decide(input: DecisionRequest): Promise<Pick<DecisionResult, 'id' | 'answers'>> };

export const jevModel = 'typesafe/jev-1.14' as const;
export const verifierPromptVersion = 'span-support@v1';

export type VerifyContext = {
  db: PostgresJsDatabase; judge: SpanJudge; runId: string; asOf: string;
  security: { name: string; issuerKeys: readonly string[] };
};

type Span = { evidenceId: string; chunkId: string; window: string };
type Rejected = { evidenceId: string; reason: string };

/**
 * Reads each cited passage back from the store and keeps those the store confirms: the chunk exists, belongs to the cited document and to an issuer of this security,
 * was available by the as-of date, and holds the quote verbatim. Code selects the span. A model never supplies the text a judge reads.
 */
export async function loadStoredSpans(db: PostgresJsDatabase, citations: readonly ResolvedCitation[], input: { asOf: string; issuerKeys: readonly string[] }): Promise<{ spans: Span[]; rejected: Rejected[] }> {
  const ids = [...new Set(citations.map(c => c.chunkId))];
  const rows = ids.length ? await db.select({ id: documentChunks.id, docKind: documentChunks.docKind, docId: documentChunks.docId, issuerKey: documentChunks.issuerKey, availableOn: documentChunks.availableOn, text: documentChunks.text }).from(documentChunks).where(inArray(documentChunks.id, ids)) : [];
  const byId = new Map(rows.map(r => [r.id, r]));
  const spans: Span[] = [], rejected: Rejected[] = [];
  for (const c of citations) {
    const row = byId.get(c.chunkId);
    const reason = !row ? 'no_such_chunk' : row.docKind !== c.docKind || row.docId !== c.docId ? 'wrong_document' : !input.issuerKeys.includes(row.issuerKey) ? 'wrong_company' : row.availableOn > input.asOf ? 'future_evidence' : undefined;
    if (reason) { rejected.push({ evidenceId: c.evidenceId, reason }); continue; }
    const window = spanWindow(row!.text, c.quote);
    if (window === null) { rejected.push({ evidenceId: c.evidenceId, reason: 'altered_span' }); continue; }
    spans.push({ evidenceId: c.evidenceId, chunkId: c.chunkId, window });
  }
  return { spans, rejected };
}

const instructions = (id: string) => `Does span ${id}, read as the stored text of the company's filing, state or directly show the claim? Answer yes only for what the span itself says. Do not credit it for facts it does not contain, and do not infer a share of revenue it does not give.`;

/**
 * Asks Jev whether the stored spans behind a level 3 or 4 score support it, and lowers the level when they do not. It can only lower a level.
 * Each level from the claim down is one decision call with one question per span, so the claim sits in the request and code owns every threshold.
 * A call that fails leaves the level as it is and says so in the adjustment, because the span check is optional and must not block scoring.
 */
export async function verifyClaim(ctx: VerifyContext, kpi: Kpi, level: ScoreLevel, citations: readonly ResolvedCitation[]): Promise<SupportDecision> {
  const levels = levelsToCheck(level);
  if (levels.length === 0 || kpi.method !== 'judgement') return { level, adjustment: null };
  const { spans, rejected } = await loadStoredSpans(ctx.db, citations, { asOf: ctx.asOf, issuerKeys: ctx.security.issuerKeys });
  if (spans.length === 0) {
    const adjustment: ScoreAdjustment = { code: 'span_unverified', from: level, to: unsupportedLevelCap, message: `No cited quote could be confirmed in the stored filing text, so level ${level} was lowered to ${unsupportedLevelCap}.`, detail: { rejected } };
    return { level: unsupportedLevelCap, adjustment };
  }
  const probes: SupportProbe[] = [];
  try {
    for (const l of levels) {
      const claim = claimFor(kpi, l);
      if (!claim) continue;
      const state = JSON.stringify({ company: ctx.security.name, as_of: ctx.asOf, kpi: kpi.name, kpi_definition: kpi.definition, claim, spans: Object.fromEntries(spans.map(s => [s.evidenceId, s.window])) });
      const result = await ctx.judge.decide({
        runId: ctx.runId, role: 'verifier', promptVersion: verifierPromptVersion, model: jevModel, state,
        questions: Object.fromEntries(spans.map(s => [`support_${s.evidenceId}`, { type: 'noul' as const, instructions: instructions(s.evidenceId) }])),
        inputEvidenceIds: spans.map(s => s.chunkId),
      });
      const best = Math.max(0, ...spans.map(s => { const a = result.answers[`support_${s.evidenceId}`]; return a?.type === 'noul' ? a.noul : 0; }));
      probes.push({ level: l, best });
      if (best >= supportThresholds.borderline) break;
    }
  } catch (error) {
    return { level, adjustment: { code: 'jev_unavailable', from: level, to: level, message: 'The span check did not run, so this level is not independently checked.', detail: { error: error instanceof Error ? error.message : 'unknown' } } };
  }
  const decision = decideSupport(level, probes);
  if (rejected.length && decision.adjustment) decision.adjustment.detail = { ...(decision.adjustment.detail as object), rejected };
  return decision;
}
