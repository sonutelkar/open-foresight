import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { approveGate } from './runs.js';
import { humanDecisions, kpiFrameworkDrafts, kpiFrameworkVersions, llmCalls, runs, runStatusHistory } from './schema.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('run and audit persistence', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 1 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('enforces transitions and records both gate approvals atomically', async () => {
    const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning();
    if (!run) throw new Error('No run inserted');
    await expect(db.update(runs).set({ status: 'done' }).where(eq(runs.id, run.id))).rejects.toThrow();
    for (const status of ['universe_built', 'designing', 'awaiting_kpi_approval'] as const) {
      await db.update(runs).set({ status }).where(eq(runs.id, run.id));
    }
    await expect(db.update(runs).set({ status: 'prescreening' }).where(eq(runs.id, run.id))).rejects.toThrow();
    await expect(approveGate({ db, runId: run.id, gate: 'awaiting_kpi_approval', userId: ' ' })).rejects.toThrow();
    expect(await db.select().from(humanDecisions).where(eq(humanDecisions.runId, run.id))).toHaveLength(0);
    await db.insert(humanDecisions).values({ runId: run.id, userId: 'prior', stage: 'awaiting_kpi_approval', target: run.id, action: 'approve' });
    await expect(db.update(runs).set({ status: 'prescreening' }).where(eq(runs.id, run.id))).rejects.toThrow();
    await approveGate({ db, runId: run.id, gate: 'awaiting_kpi_approval', userId: 'analyst' });
    for (const status of ['analysing', 'reviewing', 'awaiting_flag_review'] as const) {
      await db.update(runs).set({ status }).where(eq(runs.id, run.id));
    }
    await expect(db.update(runs).set({ status: 'packaging' }).where(eq(runs.id, run.id))).rejects.toThrow();
    await approveGate({ db, runId: run.id, gate: 'awaiting_flag_review', userId: 'analyst' });
    await db.update(runs).set({ status: 'done' }).where(eq(runs.id, run.id));
    const history = await db.select().from(runStatusHistory).where(eq(runStatusHistory.runId, run.id)).orderBy(runStatusHistory.sequence);
    expect(history.map(row => row.status)).toEqual([
      'draft', 'universe_built', 'designing', 'awaiting_kpi_approval', 'prescreening',
      'analysing', 'reviewing', 'awaiting_flag_review', 'packaging', 'done',
    ]);
    expect(await db.select().from(humanDecisions).where(eq(humanDecisions.runId, run.id))).toHaveLength(3);
    await expect(db.delete(humanDecisions).where(eq(humanDecisions.runId, run.id))).rejects.toThrow();
    await expect(db.insert(runStatusHistory).values({ runId: run.id, status: 'draft' })).rejects.toThrow();
  });

  it('stores call records and rejects audit edits', async () => {
    const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning();
    if (!run) throw new Error('No run inserted');
    const [call] = await db.insert(llmCalls).values({
      runId: run.id, role: 'designer', promptVersion: '1', model: 'fixture',
      params: {}, requestHash: 'hash', inputEvidenceIds: [], response: { ok: true },
    }).returning();
    if (!call) throw new Error('No call inserted');
    expect(call.response).toEqual({ ok: true });
    await expect(db.update(llmCalls).set({ role: 'modified' }).where(eq(llmCalls.id, call.id))).rejects.toThrow();
    await expect(client.unsafe('TRUNCATE llm_calls CASCADE')).rejects.toThrow();
  });

  it('rolls back the whole approval when the prepare step throws, and records its target when it succeeds', async () => {
    const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning();
    if (!run) throw new Error('No run inserted');
    for (const status of ['universe_built', 'designing', 'awaiting_kpi_approval'] as const) await db.update(runs).set({ status }).where(eq(runs.id, run.id));
    const [call] = await db.insert(llmCalls).values({ runId: run.id, role: 'designer', promptVersion: 'x', model: 'fixture', params: {}, requestHash: 'h', inputEvidenceIds: [] }).returning();
    const [draft] = await db.insert(kpiFrameworkDrafts).values({ runId: run.id, attempt: 1, promptVersion: 'x', model: 'fixture', llmCallId: call!.id, draft: {}, errors: [], valid: true, framework: {} }).returning();
    const insertVersion = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      const [v] = await tx.insert(kpiFrameworkVersions).values({ runId: run.id, version: 1, sourceDraftId: draft!.id, framework: {}, exclusions: [], edited: false, approvedBy: 'analyst' }).returning({ id: kpiFrameworkVersions.id });
      return v!.id;
    };
    await expect(approveGate({ db, runId: run.id, gate: 'awaiting_kpi_approval', userId: 'analyst', prepare: async tx => { await insertVersion(tx); throw new Error('rejected after writing'); } })).rejects.toThrow('rejected after writing');
    expect(await db.select().from(kpiFrameworkVersions).where(eq(kpiFrameworkVersions.runId, run.id))).toHaveLength(0);
    expect(await db.select().from(humanDecisions).where(eq(humanDecisions.runId, run.id))).toHaveLength(0);
    expect((await db.select().from(runs).where(eq(runs.id, run.id)))[0]).toMatchObject({ status: 'awaiting_kpi_approval', frameworkVersion: null });

    let versionId = '';
    await approveGate({ db, runId: run.id, gate: 'awaiting_kpi_approval', userId: 'analyst', prepare: async tx => { versionId = await insertVersion(tx); return { target: versionId, frameworkVersion: versionId }; } });
    expect((await db.select().from(humanDecisions).where(eq(humanDecisions.runId, run.id)))[0]).toMatchObject({ target: versionId, action: 'approve' });
    expect((await db.select().from(runs).where(eq(runs.id, run.id)))[0]).toMatchObject({ status: 'prescreening', frameworkVersion: versionId });
    await expect(client.unsafe('UPDATE kpi_framework_versions SET edited = true')).rejects.toThrow('append-only');
  });
});

