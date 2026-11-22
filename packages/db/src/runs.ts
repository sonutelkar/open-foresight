import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { humanDecisions, runs } from './schema.js';

type Gate = 'awaiting_kpi_approval' | 'awaiting_flag_review';
type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

const nextStage: Record<Gate, 'prescreening' | 'packaging'> = {
  awaiting_kpi_approval: 'prescreening',
  awaiting_flag_review: 'packaging',
};

export async function approveGate(input: {
  db: PostgresJsDatabase;
  runId: string;
  gate: Gate;
  userId: string;
  reason?: string;
  /**
   * Runs inside the approval transaction after the gate is checked and before it is recorded.
   * It returns the decision's target and, optionally, the framework version to set on the run.
   * Throwing aborts the whole approval, so nothing it wrote stays.
   */
  prepare?: (tx: Tx) => Promise<{ target: string; frameworkVersion?: string }>;
}): Promise<void> {
  await input.db.transaction(async (tx) => {
    const [run] = await tx.select({ status: runs.status }).from(runs)
      .where(eq(runs.id, input.runId)).for('update');
    if (!run || run.status !== input.gate) {
      throw new Error('Run is not awaiting this approval');
    }
    const prepared = input.prepare ? await input.prepare(tx) : undefined;
    if (prepared?.frameworkVersion) await tx.update(runs).set({ frameworkVersion: prepared.frameworkVersion }).where(eq(runs.id, input.runId));
    await tx.insert(humanDecisions).values({
      runId: input.runId,
      userId: input.userId,
      stage: input.gate,
      target: prepared?.target ?? input.runId,
      action: 'approve',
      reason: input.reason,
    });
    const changed = await tx.update(runs).set({ status: nextStage[input.gate] })
      .where(and(eq(runs.id, input.runId), eq(runs.status, input.gate))).returning({ id: runs.id });
    if (changed.length !== 1) throw new Error('Run changed while approving');
  });
}
