import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { availableQuantIds, briefLimits, esefReportLink, frameworkToDraft, exposureStyles, limits, modelProfiles, quantCatalog, quoteInPassage, regionOptions, reviewLevels, sourceCatalog, validateBrief, validateFramework, weightings, type Brief, type Framework, type SourceId } from '@open-foresight/core';
import { basketMembers, baskets, documentChunks, esefFilings, humanDecisions, kpiScores, secFilings, secSourceDocuments, kpiFrameworkDrafts, kpiFrameworkVersions, runStatusHistory, runUniverse, runs, approveGate } from '@open-foresight/db';

export type AppDeps = {
  db: PostgresJsDatabase;
  /** The local approver token. Every change needs it in the `x-approval-token` header. */
  token: string;
  availableSources: readonly SourceId[];
  /** Today's date as YYYY-MM-DD. A function so tests can fix it. */
  today: () => string;
  /** Queues the run for the worker, which drives it to the next gate. The API never runs a stage itself. */
  enqueue: (runId: string) => Promise<void>;
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
 * The API for the brief form, the gate 1 approval and the run view. It reads and writes the local store only.
 * Creating a run and approving gate 1 each queue the run for the worker. A queue that is down does not fail the request, because the worker
 * sweeps for runs that need work. Approving validates the edited framework, freezes it as a version, and records the decision,
 * all in the transaction that advances the run, so a rejected approval leaves nothing behind.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const queue = async (runId: string) => { try { await deps.enqueue(runId); } catch (error) { console.error(`Could not queue run ${runId}`, error); } };

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
    await queue(run.id);
    return c.json({ runId: run.id, status: 'draft' }, 202);
  });

  app.get('/api/runs/:id', async c => {
    const id = c.req.param('id');
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid run id' }, 400);
    const [run] = await deps.db.select().from(runs).where(eq(runs.id, id));
    if (!run) return c.json({ error: 'Run not found' }, 404);
    const [drafts, history, decisions, versions, basketRows] = await Promise.all([
      deps.db.select().from(kpiFrameworkDrafts).where(eq(kpiFrameworkDrafts.runId, id)).orderBy(desc(kpiFrameworkDrafts.attempt)),
      deps.db.select({ status: runStatusHistory.status, at: runStatusHistory.createdAt }).from(runStatusHistory).where(eq(runStatusHistory.runId, id)).orderBy(runStatusHistory.sequence),
      deps.db.select().from(humanDecisions).where(eq(humanDecisions.runId, id)).orderBy(humanDecisions.createdAt),
      deps.db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, id)).orderBy(kpiFrameworkVersions.version),
      deps.db.select().from(baskets).where(eq(baskets.runId, id)),
    ]);
    const basket = basketRows[0];
    const [members, universe] = await Promise.all([
      basket ? deps.db.select().from(basketMembers).where(eq(basketMembers.basketId, basket.id)).orderBy(basketMembers.rank) : Promise.resolve([]),
      deps.db.select({ symbol: runUniverse.symbol, included: runUniverse.included, reasons: runUniverse.reasons, coverage: runUniverse.coverage }).from(runUniverse).where(eq(runUniverse.runId, id)),
    ]);
    const valid = drafts.find(d => d.valid);
    return c.json({
      id: run.id, status: run.status, createdAt: run.createdAt, settings: run.settings, frameworkVersion: run.frameworkVersion,
      draft: valid ? { id: valid.id, attempt: valid.attempt, promptVersion: valid.promptVersion, model: valid.model, framework: valid.framework } : null,
      attempts: drafts.map(d => ({ attempt: d.attempt, valid: d.valid, errors: d.errors, promptVersion: d.promptVersion, model: d.model })),
      history, decisions, versions,
      universe: { total: universe.length, included: universe.filter(u => u.included).length, withFilings: universe.filter(u => u.included && (u.coverage === 'sec' || u.coverage === 'esef')).length },
      basket: basket ? {
        status: basket.status, unknownMode: basket.unknownMode, rules: basket.rules, funnel: basket.funnel, cap: basket.cap, excluded: basket.excluded, createdAt: basket.createdAt,
        members: members.map(m => ({ rank: m.rank, symbol: m.symbol, name: m.name, score: Number(m.score), confidence: Number(m.confidence), weightPercent: Number(m.weightPercent), atCap: m.atCap, unknownWeight: Number(m.unknownWeight), capAdjustment: Number(m.capAdjustment), contributions: m.contributions })),
      } : null,
    });
  });

  /**
   * The evidence behind one basket member: per KPI, the latest valid score with its rationale and cited quotes.
   * Each quote carries a link to its source filing and a flag for whether it appears verbatim in the stored passage, so a reader can trace it.
   */
  app.get('/api/runs/:id/members/:symbol/evidence', async c => {
    const id = c.req.param('id'), symbol = c.req.param('symbol');
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid run id' }, 400);
    const [basket] = await deps.db.select({ id: baskets.id, frameworkVersionId: baskets.frameworkVersionId }).from(baskets).where(eq(baskets.runId, id));
    if (!basket) return c.json({ error: 'The run has no basket' }, 404);
    const [member] = await deps.db.select({ securityId: basketMembers.securityId, symbol: basketMembers.symbol, name: basketMembers.name }).from(basketMembers).where(and(eq(basketMembers.basketId, basket.id), eq(basketMembers.symbol, symbol)));
    if (!member) return c.json({ error: 'That name is not in the basket' }, 404);
    const [version] = await deps.db.select({ framework: kpiFrameworkVersions.framework }).from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.id, basket.frameworkVersionId));
    const rows = await deps.db.select().from(kpiScores).where(and(eq(kpiScores.runId, id), eq(kpiScores.securityId, member.securityId))).orderBy(desc(kpiScores.attempt));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) { const have = latest.get(r.kpiId); if (!have || (r.valid && !have.valid)) latest.set(r.kpiId, r); }
    type Cited = { evidenceId: string; quote: string; chunkId: string; docKind: string; docId: string; section: string; availableOn: string; startOffset: number; endOffset: number };
    const cited = [...latest.values()].flatMap(r => (r.citations as Cited[]));
    const chunks = cited.length ? await deps.db.select({ id: documentChunks.id, text: documentChunks.text }).from(documentChunks).where(inArray(documentChunks.id, [...new Set(cited.map(x => x.chunkId))])) : [];
    const chunkText = new Map(chunks.map(x => [x.id, x.text]));
    const secIds = [...new Set(cited.filter(x => x.docKind === 'sec_filing').map(x => x.docId))], esefIds = [...new Set(cited.filter(x => x.docKind === 'esef_filing').map(x => x.docId))];
    const [secDocs, esefDocs] = await Promise.all([
      secIds.length ? deps.db.select({ id: secFilings.id, form: secFilings.form, filedAt: secFilings.filedAt, url: secSourceDocuments.url }).from(secFilings).innerJoin(secSourceDocuments, eq(secSourceDocuments.id, secFilings.documentSourceId)).where(inArray(secFilings.id, secIds)) : [],
      esefIds.length ? deps.db.select({ id: esefFilings.id, entity: esefFilings.entityName, periodEnd: esefFilings.periodEnd, reportUrl: esefFilings.reportUrl }).from(esefFilings).where(inArray(esefFilings.id, esefIds)) : [],
    ]);
    const source = new Map<string, { label: string; url: string }>([
      ...secDocs.map(d => [d.id, { label: `SEC ${d.form} filed ${d.filedAt}`, url: d.url }] as const),
      ...esefDocs.map(d => [d.id, { label: `${d.entity} ESEF report for the period ending ${d.periodEnd}`, url: esefReportLink(d.reportUrl) }] as const),
    ]);
    const kpis = (version?.framework as Framework | undefined)?.kpis ?? [];
    return c.json({
      symbol: member.symbol, name: member.name,
      kpis: kpis.map(k => {
        const r = latest.get(k.id);
        if (!r) return { kpiId: k.id, name: k.name, method: k.method, scored: false };
        return {
          kpiId: k.id, name: k.name, method: r.method, scored: true, level: r.level, confidence: Number(r.confidence), valid: r.valid, rationale: r.rationale, conflicts: r.conflicts,
          extractedValue: r.extractedValue === null ? null : Number(r.extractedValue), unit: r.unit, quantValue: r.quantValue === null ? null : Number(r.quantValue), quantInputs: r.quantInputs,
          citations: (r.citations as Cited[]).map(x => {
            const text = chunkText.get(x.chunkId), src = source.get(x.docId);
            return { evidenceId: x.evidenceId, quote: x.quote, section: x.section, availableOn: x.availableOn, docKind: x.docKind, chunkId: x.chunkId, startOffset: x.startOffset, endOffset: x.endOffset, sourceLabel: src?.label ?? null, sourceUrl: src?.url ?? null, quoteVerified: text !== undefined && quoteInPassage(x.quote, text) };
          }),
        };
      }),
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
    await queue(id);
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

  return { app };
}
