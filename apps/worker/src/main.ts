// The worker. Usage: DATABASE_URL=... OPENROUTER_API_KEY=... bun src/main.ts
// It drives runs through the stages the API queues: universe, Designer, then, after gate 1, prescreening, scoring and packaging.
// The Jev check of the stored spans behind level 3 and 4 scores is on. JEV_SPAN_CHECK=0 turns it off.
// The Jev check that settles the gate KPI at level 0 for names outside the theme is on. JEV_EXPOSURE_CHECK=0 turns it off.
// It reads only the local Postgres store, and its only outside calls are the model and embedding calls through packages/llm.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources } from '@open-foresight/core';
import { runDesigner } from '@open-foresight/agents';
import { createEmbedder, createGateway } from '@open-foresight/llm';
import { createRetriever } from '@open-foresight/retrieval';
import { models } from '../../../config/models.js';
import { startWorker } from './queue.js';

const env = (name: string) => { const v = process.env[name]; if (!v?.trim()) throw new Error(`Set ${name}`); return v; };
const connectionString = env('DATABASE_URL');
const apiKey = env('OPENROUTER_API_KEY');
const sql = postgres(connectionString, { max: 10 });
const db = drizzle(sql);
const availableSources = enabledSources({ eodhd: Boolean(process.env.EODHD_API_KEY?.trim()) });
const gateway = await createGateway({ apiKey, models: models.filter(m => m.role === 'designer' || m.role === 'analyst'), db });
const embedder = await createEmbedder({ db, apiKey });
const retriever = createRetriever({ db, embedder });
const stamp = () => new Date().toISOString().slice(11, 19);

const worker = await startWorker({
  connectionString,
  deps: {
    db, gateway, retriever, availableSources, judge: process.env.JEV_SPAN_CHECK === '0' ? undefined : gateway, exposureJudge: process.env.JEV_EXPOSURE_CHECK === '0' ? undefined : gateway, scoreConcurrency: Number(process.env.SCORE_CONCURRENCY ?? 3),
    design: ({ runId, input }) => runDesigner({ db, gateway, runId, input, availableSources }),
    log: message => console.log(`${stamp()} ${message}`),
  },
});
console.log(`${stamp()} worker ready, resumed ${await worker.resume()} run(s)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void worker.stop().finally(() => process.exit(0)); });
