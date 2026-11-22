import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { availableQuantIds, briefLimits, frameworkToDraft, exposureStyles, limits, modelProfiles, quantCatalog, regionOptions, reviewLevels, sourceCatalog, validateBrief, validateFramework, weightings, type Brief, type Framework, type SourceId } from '@open-foresight/core';
import { humanDecisions, kpiFrameworkDrafts, kpiFrameworkVersions, runStatusHistory, runs, approveGate } from '@open-foresight/db';
import type { DesignerInput, DesignerResult } from '@open-foresight/agents';

export type AppDeps = {
  db: PostgresJsDatabase;
  /** The local approver token. Every change needs it in the `x-approval-token` header. */
  token: string;
  availableSources: readonly SourceId[];
  /** Today's date as YYYY-MM-DD. A function so tests can fix it. */
  today: () => string;
  /** Runs the Designer for a run. */
  design: (args: { runId: string; input: DesignerInput }) => Promise<DesignerResult>;
  /** A built web app to serve, with index.html as the fallback for any path outside /api. */
  staticDir?: string;
};

const analystSchema = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/, 'No control characters');
const approveBody = z.object({ framework: z.unknown().refine(v => v !== undefined, 'A framework is required'), exclusions: z.array(z.string().trim().min(1).max(200)).max(briefLimits.exclusions).default([]), reason: z.string().trim().max(500).optional() }).strict();
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

const sameToken = (given: string | undefined, expected: string) => {
  const a = Buffer.from(given ?? ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Compares two JSON values ignoring key order, because Postgres jsonb does not keep the order keys were written in. */
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The API for the brief form and the gate 1 approval. It reads and writes the local store only.
 * Creating a run starts the Designer in the background. Approving validates the edited framework, freezes it as a version,
 * and records the decision, all in the transaction that advances the run, so a rejected approval leaves nothing behind.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => { pending.add(p); void p.finally(() => pending.delete(p)); };

  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'The request body is too large' }, 413) }));
  app.use('/api/*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    if (!sameToken(c.req.header('x-approval-token'), deps.token)) return c.json({ error: 'A valid approver token is required' }, 401);
    const analyst = analystSchema.safeParse(c.req.header('x-analyst'));
    if (!analyst.success) return c.json({ error: 'An analyst name is required in the x-analyst header' }, 401);
    c.set('analyst' as never, analyst.data as never);
    return next();
  });

  app.get('/api/config', c => c.json({
    today: deps.today(), regions: regionOptions, exposureStyles, weightings, reviewLevels, modelProfiles, briefLimits,
    frameworkLimits: limits, availableSources: deps.availableSources,
    sources: Object.fromEntries(deps.availableSources.map(id => [id, sourceCatalog[id].description])),
    quantFunctions: Object.fromEntries(availableQuantIds(deps.availableSources).map(id => [id, quantCatalog[id].description])),
  }));

  app.get('/api/runs', async c => {
    const rows = await deps.db.select({ id: runs.id, status: runs.status, createdAt: runs.createdAt, settings: runs.settings }).from(runs).orderBy(desc(runs.createdAt)).limit(20);
    return c.json(rows.map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt, theme: String((r.settings as { brief?: string }).brief ?? '').slice(0, 120) })));
  });

  app.post('/api/runs', async c => {
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json({ error: 'The body must be JSON' }, 400);
    const checked = validateBrief(body, { today: deps.today() });
    if (!checked.ok) return c.json({ errors: checked.errors }, 422);
    const brief: Brief = checked.brief;
    const analyst = c.get('analyst' as never) as string;
    const [run] = await deps.db.insert(runs).values({ settings: { ...brief, createdBy: analyst }, modelProfile: brief.modelProfile }).returning({ id: runs.id });
    if (!run) return c.json({ error: 'The run was not saved' }, 500);
    track(startDesign(deps, run.id, brief, analyst));
    return c.json({ runId: run.id, status: 'draft' }, 202);
  });

  app.get('/api/runs/:id', async c => {
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid run id' }, 400);
    const [run] = await deps.db.select().from(runs).where(eq(runs.id, id));
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const [drafts, history, decisions, versions] = await Promise.all([
      deps.db.select().from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, id)).orderBy(desc(kpiFrameworkDrafts.attempt)),
      deps.db.select({ status: runStatusHistory.status, at: runStatusHistory.createdAt }).from(runStatusHistory).where(eq(runStatusHistory.runId, id)).orderBy(runStatusHistory.sequence),
      deps.db.select().from(humanDecisions).where(eq(humanDecisions.runId, id)).orderBy(humanDecisions.createdAt),
      deps.db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, id)).orderBy(kpiFrameworkVersions.version),
    ]);
    const valid = drafts.find(d => d.valid);
    return c.json({
      id: run.id, status: run.status, createdAt: run.createdAt, settings: run.settings, frameworkVersion: run.frameworkVersion,
      draft: valid ? { id: valid.id, attempt: valid.attempt, promptVersion: valid.promptVersion, model: valid.model, framework: valid.framework } : null,
      attempts: drafts.map(d => ({ attempt: d.attempt, valid: d.valid, errors: d.errors, promptVersion: d.promptVersion, model: d.model })),
      history, decisions, versions,
    });
  });

  app.post('/api/runs/:id/approve', async c => {
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid run id' }, 400);
    const raw = await c.req.json().catch(() => undefined);
    const body = approveBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'The body must have a framework and optional exclusions and reason', details: body.error.issues.map(i => i.message) }, 400);
    const [run] = await deps.db.select({ status: runs.status }).from(runs).where(eq(runs.id, id));
    if (!run) return c.json({ error: 'Run not found' }, 404);
    if (run.status !== 'awaiting_kpi_approval') return c.json({ error: `The run is ${run.status}, not awaiting KPI approval` }, 409);
    const checked = validateFramework(frameworkToDraft(body.data.framework), { availableSources: deps.availableSources });
    if (!checked.ok) return c.json({ errors: checked.errors }, 422);
    const source = (await deps.db.select().from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, id)).orderBy(desc(kpiFrameworkDrafts.attempt))).find(d => d.valid);
    if (!source) return c.json({ error: 'The run has no valid framework draft' }, 409);
    const analyst = c.get('analyst' as never) as string;
    const framework: Framework = checked.framework;
    let created: { versionId: string; version: number } | undefined;
    try {
      await approveGate({
        db: deps.db, runId: id, gate: 'awaiting_kpi_approval', userId: analyst, reason: body.data.reason,
        prepare: async tx => {
          const existing = await tx.select({ version: kpiFrameworkVersions.version }).from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, id));
          const version = existing.reduce((m, r) => Math.max(m, r.version), 0) + 1;
          const [row] = await tx.insert(kpiFrameworkVersions).values({ runId: id, version, sourceDraftId: source.id, framework, exclusions: body.data.exclusions, edited: !sameJson(framework, source.framework), approvedBy: analyst }).returning({ id: kpiFrameworkVersions.id });
          if (!row) throw new Error('The framework version was not saved');
          created = { versionId: row.id, version };
          return { target: row.id, frameworkVersion: row.id };
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approval failed';
      return c.json({ error: message }, message.includes('not awaiting') || message.includes('changed') ? 409 : 500);
    }
    return c.json({ ...created, status: 'prescreening' }, 201);
  });

  app.all('/api/*', c => c.json({ error: 'Not found' }, 404));

  if (deps.staticDir) {
    const root = normalize(deps.staticDir);
    app.get('*', async c => {
      const path = normalize(join(root, decodeURIComponent(new URL(c.req.url).pathname)));
      const file = path.startsWith(root) && extname(path) ? path : join(root, 'index.html');
      const body = await readFile(file).catch(() => undefined);
      if (!body) return c.text('Not found', 404);
      return new Response(new Uint8Array(body), { headers: { 'content-type': mime[extname(file)] ?? 'application/octet-stream' } });
    });
  }

  return { app, idle: async () => { while (pending.size) await Promise.allSettled([...pending]); } };
}

/**
 * Moves a new run to gate 1. The universe stage belongs to the orchestration ticket, so the run passes through `universe_built`
 * with a recorded placeholder, and the Designer gets no universe sample. That placeholder is the only stand-in here.
 */
async function startDesign(deps: AppDeps, runId: string, brief: Brief, createdBy: string): Promise<void> {
  const setStatus = (status: typeof runs.$inferInsert.status) => deps.db.update(runs).set({ status }).where(eq(runs.id, runId));
  try {
    await deps.db.update(runs).set({ settings: { ...brief, createdBy, universe: { status: 'placeholder', note: 'The universe stage is built by the orchestration ticket. This run was not screened.' } } }).where(eq(runs.id, runId));
    await setStatus('universe_built');
    await setStatus('designing');
    const result = await deps.design({ runId, input: { brief: brief.brief, keywords: brief.keywords, seedNames: brief.seedNames, exclusions: brief.exclusions, regions: brief.regions, exposureStyle: brief.exposureStyle, asOf: brief.asOf, universeSample: [] } });
    if (result.ok) { await setStatus('awaiting_kpi_approval'); return; }
    await deps.db.update(runs).set({ settings: { ...brief, createdBy, designError: result.errors.map(e => `${e.code}: ${e.message}`).slice(0, 10) } }).where(eq(runs.id, runId));
    await setStatus('failed');
  } catch (error) {
    await deps.db.update(runs).set({ settings: { ...brief, createdBy, designError: [error instanceof Error ? error.message : 'The Designer failed'] } }).where(eq(runs.id, runId)).catch(() => undefined);
    await setStatus('failed').catch(() => undefined);
  }
}
