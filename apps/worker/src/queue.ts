import { PgBoss, type JobWithMetadata } from 'pg-boss';
import { inArray } from 'drizzle-orm';
import { runs } from '@open-foresight/db';
import { advanceQueue, defaultQueueOptions, type Payload, type QueueOverrides } from './publisher.js';
import { drive, failRun, StageFailure, type RunStatus, type WorkerDeps } from './stages.js';

/** The statuses a worker moves by itself. A run in any other status is waiting for a person or finished. */
const workingStatuses: RunStatus[] = ['draft', 'universe_built', 'designing', 'prescreening', 'analysing', 'packaging'];

/**
 * Starts the worker. Each job drives one run to its next gate or its end.
 * A thrown error retries the job. After the last retry the run is marked failed with the reason. A `StageFailure` fails the run at once.
 * `resume` queues every run that is mid-pipeline, so jobs lost with a wiped queue, or never sent, still run.
 */
export async function startWorker(options: { connectionString: string; deps: WorkerDeps; overrides?: QueueOverrides; pollingIntervalSeconds?: number }) {
  const { deps } = options;
  const boss = new PgBoss({ connectionString: options.connectionString });
  boss.on('error', error => console.error('pg-boss', error));
  await boss.start();
  await boss.createQueue(advanceQueue, { ...defaultQueueOptions, ...options.overrides });
  const resume = async () => {
    const stuck = await deps.db.select({ id: runs.id }).from(runs).where(inArray(runs.status, workingStatuses));
    for (const r of stuck) await boss.send(advanceQueue, { runId: r.id } satisfies Payload, { singletonKey: r.id });
    return stuck.length;
  };
  await boss.work(advanceQueue, { includeMetadata: true, batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 }, async (jobs: JobWithMetadata<Payload>[]) => {
    for (const job of jobs) {
      const { runId } = job.data;
      try {
        const status = await drive(deps, runId);
        deps.log?.(`run ${runId.slice(0, 8)} stopped at ${status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log?.(`run ${runId.slice(0, 8)} stage failed: ${message}`);
        if (error instanceof StageFailure || job.retryCount >= job.retryLimit) { await failRun(deps.db, runId, 'worker', message); return; }
        throw error;
      }
    }
  });
  const sweep = setInterval(() => { void resume().catch(error => console.error('resume', error)); }, 30_000);
  return { resume, async stop() { clearInterval(sweep); await boss.stop({ graceful: true, timeout: 10_000 }); } };
}
