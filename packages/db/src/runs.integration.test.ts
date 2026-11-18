import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { approveGate } from './runs.js';
import { humanDecisions, llmCalls, runs, runStatusHistory } from './schema.js';

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
});
