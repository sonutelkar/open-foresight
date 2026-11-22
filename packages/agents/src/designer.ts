import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z, type ZodTypeAny } from 'zod';
import { availableQuantIds, constrainedDraftSchema, quantCatalog, sourceCatalog, validateFramework, type Framework, type FrameworkError, type SourceId } from '@open-foresight/core';
import { kpiFrameworkDrafts, llmCalls } from '@open-foresight/db';
import { loadPrompt, render } from '@open-foresight/prompts';

/** The part of the gateway the Designer uses. The real gateway satisfies it, and tests can stand in a recorded one. */
export type StructuredGenerator = {
  generate<T extends ZodTypeAny>(input: {
    runId: string; role: string; promptVersion: string; system: string; user: string;
    schemaName: string; schema: T; inputEvidenceIds: string[]; maxOutputTokens?: number; onAudit?: (id: string) => void;
  }): Promise<z.infer<T>>;
};

const regionSchema = z.enum(['US', 'EU', 'UK', 'CH']);
export const designerInputSchema = z.object({
  brief: z.string().trim().refine(v => v.split(/\s+/).length >= 20, 'The brief needs at least 20 words').refine(v => v.length <= 4000, 'The brief is too long'),
  keywords: z.array(z.string().trim().min(1)).max(30).default([]),
  seedNames: z.array(z.string().trim().min(1)).max(100).default([]),
  exclusions: z.array(z.string().trim().min(1)).max(50).default([]),
  regions: z.array(regionSchema).min(1),
  exposureStyle: z.enum(['strict', 'broad']),
  asOf: z.string().date(),
  universeSample: z.array(z.object({ symbol: z.string().min(1), name: z.string().min(1), sector: z.string().optional() })).max(60).default([]),
}).strict();
export type DesignerInput = z.input<typeof designerInputSchema>;

export type DesignerResult =
  | { ok: true; framework: Framework; draftId: string; attempts: number; reused: boolean }
  | { ok: false; errors: FrameworkError[]; draftId: string; attempts: number };

const list = (items: string[]) => items.length ? items.join(', ') : 'none';
const repairNote = (errors: FrameworkError[]) => `\n\nYour previous framework failed validation. Fix every problem below and return the complete corrected framework.\n${errors.map(e => `- ${e.path}: ${e.message}`).join('\n')}`;

/**
 * Drafts a KPI framework for a run and saves each attempt.
 * A run that already has a valid draft returns it without a model call, unless `regenerate` is set.
 * An invalid draft is repaired once by showing the model every validation error. Every attempt is saved and linked to its llm_calls row.
 */
export async function runDesigner(options: {
  db: PostgresJsDatabase; gateway: StructuredGenerator; runId: string; input: DesignerInput;
  availableSources: readonly SourceId[]; maxAttempts?: number; regenerate?: boolean; maxOutputTokens?: number;
}): Promise<DesignerResult> {
  const input = designerInputSchema.parse(options.input);
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('maxAttempts must be 1 to 3');
  if (options.availableSources.length === 0) throw new Error('No sources are enabled');
  const { db, runId } = options;

  const existing = await db.select().from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, runId)).orderBy(desc(kpiFrameworkDrafts.attempt));
  if (!options.regenerate) {
    const reusable = existing.find(d => d.valid);
    if (reusable) return { ok: true, framework: reusable.framework as Framework, draftId: reusable.id, attempts: reusable.attempt, reused: true };
  }
  let attempt = existing[0]?.attempt ?? 0;

  const prompt = loadPrompt('designer', 'v1');
  const system = render(prompt.system, {
    sources: options.availableSources.map(id => `- ${id}: ${sourceCatalog[id].description}`).join('\n'),
    quant_functions: availableQuantIds(options.availableSources).map(id => `- ${id} (reads ${quantCatalog[id].sources.join(', ')}): ${quantCatalog[id].description}`).join('\n'),
  });
  const baseUser = render(prompt.user, {
    brief: input.brief, keywords: list(input.keywords), seed_names: list(input.seedNames), exclusions: list(input.exclusions),
    regions: input.regions.join(', '), exposure_style: input.exposureStyle, as_of: input.asOf,
    universe_sample: input.universeSample.length ? input.universeSample.map(u => `- ${u.symbol} | ${u.name}${u.sector ? ` | ${u.sector}` : ''}`).join('\n') : 'none provided',
  });
  const schema = constrainedDraftSchema(options.availableSources);
  const evidenceIds = input.universeSample.map(u => `universe:${u.symbol}`);

  let feedback = '';
  let last: { draftId: string; errors: FrameworkError[] } | undefined;
  for (let n = 0; n < maxAttempts; n++) {
    let auditId = '';
    const draft = await options.gateway.generate({
      runId, role: 'designer', promptVersion: prompt.promptVersion, system, user: baseUser + feedback,
      schemaName: 'kpi_framework', schema, inputEvidenceIds: evidenceIds, maxOutputTokens: options.maxOutputTokens ?? 6000, onAudit: id => { auditId = id; },
    });
    const [call] = await db.select({ model: llmCalls.model }).from(llmCalls).where(eq(llmCalls.id, auditId));
    if (!auditId || !call) throw new Error('The gateway did not report an audit record for the Designer call');
    const result = validateFramework(draft, { availableSources: options.availableSources });
    attempt++;
    const [saved] = await db.insert(kpiFrameworkDrafts).values({
      runId, attempt, promptVersion: prompt.promptVersion, model: call.model, llmCallId: auditId,
      draft, errors: result.ok ? [] : result.errors, valid: result.ok, framework: result.ok ? result.framework : null,
    }).returning({ id: kpiFrameworkDrafts.id });
    if (!saved) throw new Error('The framework draft was not saved');
    if (result.ok) return { ok: true, framework: result.framework, draftId: saved.id, attempts: attempt, reused: false };
    last = { draftId: saved.id, errors: result.errors };
    feedback = repairNote(result.errors);
  }
  if (!last) throw new Error('The Designer made no attempt');
  return { ok: false, errors: last.errors, draftId: last.draftId, attempts: attempt };
}

/** The saved attempts for a run, newest first. */
export async function listDrafts(db: PostgresJsDatabase, runId: string) {
  return db.select().from(kpiFrameworkDrafts).where(and(eq(kpiFrameworkDrafts.runId, runId))).orderBy(desc(kpiFrameworkDrafts.attempt));
}
