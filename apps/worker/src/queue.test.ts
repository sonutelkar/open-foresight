import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { runs } from '@open-foresight/db';
import { createPublisher, type Publisher } from './publisher.js';
import { startWorker } from './queue.js';
import type { WorkerDeps } from './stages.js';
import { approve, createRun, fakeDesigner, fakeGateway, fakeRetriever, freshDatabase, seedWorld } from './test-world.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('pg-boss queue', () => {
  let world: Awaited<ReturnType<typeof freshDatabase>>;
  let db: PostgresJsDatabase;
  let issuers: Map<string, string>;
  let publisher: Publisher;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  const designer = () => fakeDesigner(db);
  let d: ReturnType<typeof fakeDesigner>;
  let g: ReturnType<typeof fakeGateway>;

  beforeAll(async () => {
    world = await freshDatabase(); db = world.db;
    issuers = new Map([...(await seedWorld(db))].map(([, v]) => [v.id, v.issuerKey]));
    d = designer(); g = fakeGateway(db);
    const deps: WorkerDeps = { db, design: d.design, gateway: g.generator, retriever: fakeRetriever(id => issuers.get(id) ?? 'none'), availableSources: ['sec_filings', 'esef_filings', 'sec_facts', 'prices', 'market_cap'], scoreConcurrency: 2 };
    const overrides = { retryLimit: 2, retryDelay: 1, retryBackoff: false } as const;
    publisher = await createPublisher(world.url, overrides);
    worker = await startWorker({ connectionString: world.url, deps, overrides, pollingIntervalSeconds: 0.5 });
  }, 60_000);
  afterAll(async () => { await worker?.stop(); await publisher?.stop(); await world?.close(); }, 60_000);

  const statusOf = async (id: string) => (await db.select({ s: runs.status }).from(runs).where(eq(runs.id, id)))[0]!.s;
  async function until(id: string, want: string, ms = 40_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await statusOf(id)) === want) return; await new Promise(r => setTimeout(r, 200)); }
    throw new Error(`Run ${id} is ${await statusOf(id)}, wanted ${want}`);
  }

  it('drives a run to gate 1 from one enqueue, deduplicating repeats, then to done after approval', async () => {
    const before = d.state.calls;
    const runId = await createRun(db);
    await Promise.all([publisher.enqueue(runId), publisher.enqueue(runId), publisher.enqueue(runId)]);
    await until(runId, 'awaiting_kpi_approval');
    expect(d.state.calls - before).toBe(1);
    await approve(db, runId);
    await publisher.enqueue(runId);
    await until(runId, 'done');
  }, 60_000);

  it('retries a transient model outage and finishes without repeating finished model calls', async () => {
    const runId = await createRun(db);
    await publisher.enqueue(runId);
    await until(runId, 'awaiting_kpi_approval');
    await approve(db, runId);
    const base = g.state.calls;
    g.state.failAfter = base + 4;
    await publisher.enqueue(runId);
    await new Promise(r => setTimeout(r, 1500));
    g.state.failAfter = Infinity;
    await until(runId, 'done');
    expect(g.state.calls - base).toBe(12);
  }, 60_000);

  it('fails a run at once when the stage cannot succeed, and records why', async () => {
    d.state.fail = true;
    const runId = await createRun(db);
    await publisher.enqueue(runId);
    await until(runId, 'failed');
    d.state.fail = false;
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect((run?.settings as { failure: { stage: string; message: string } }).failure.message).toContain('no valid framework');
  }, 60_000);

  it('resumes a run whose job was never sent', async () => {
    const runId = await createRun(db);
    expect(await worker.resume()).toBeGreaterThanOrEqual(1);
    await until(runId, 'awaiting_kpi_approval');
  }, 60_000);
});
