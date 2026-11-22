import { PgBoss } from 'pg-boss';

export const advanceQueue = 'run.advance';
export type Payload = { runId: string };

/**
 * Queue settings. The `exclusive` policy allows one queued or active job per run, so a run is never driven by two workers.
 * A job that stops sending a heartbeat, because its worker died, goes back to the queue after thirty seconds and resumes from the saved state.
 */
export const defaultQueueOptions = { policy: 'exclusive', retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 6 * 3600, heartbeatSeconds: 30, deleteAfterSeconds: 7 * 86_400 } as const;
export type QueueOverrides = Partial<{ retryLimit: number; retryDelay: number; retryBackoff: boolean; heartbeatSeconds: number }>;

export type Publisher = { enqueue(runId: string): Promise<void>; stop(): Promise<void> };

/** Starts a pg-boss client that only sends jobs. The API uses this. The schema is created or upgraded on start. */
export async function createPublisher(connectionString: string, overrides: QueueOverrides = {}): Promise<Publisher> {
  const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
  boss.on('error', error => console.error('pg-boss', error));
  await boss.start();
  await boss.createQueue(advanceQueue, { ...defaultQueueOptions, ...overrides });
  return {
    async enqueue(runId) { await boss.send(advanceQueue, { runId } satisfies Payload, { singletonKey: runId }); },
    async stop() { await boss.stop({ graceful: true, timeout: 5000 }); },
  };
}

