// The local API and web app. Usage: DATABASE_URL=... APPROVAL_TOKEN=... bun src/server.ts
// It queues work for the worker (apps/worker) and never calls a model itself.
// It listens on 127.0.0.1 only. Every change needs the approver token in the x-approval-token header.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources } from '@open-foresight/core';
import { createPublisher } from '../../worker/src/publisher.js';
import { createApp } from './app.js';

const env = (name: string) => { const v = process.env[name]; if (!v?.trim()) throw new Error(`Set ${name}`); return v; };
const token = env('APPROVAL_TOKEN');
if (token.length < 16) throw new Error('APPROVAL_TOKEN must be at least 16 characters');
const sql = postgres(env('DATABASE_URL'), { max: 5 });
const db = drizzle(sql);
const availableSources = enabledSources({ eodhd: Boolean(process.env.EODHD_API_KEY?.trim()) });
const publisher = await createPublisher(env('DATABASE_URL'));

const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const { app } = createApp({
  db, token, availableSources, today: () => new Date().toISOString().slice(0, 10),
  enqueue: runId => publisher.enqueue(runId),
  staticDir: existsSync(webDist) ? webDist : undefined,
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, info => console.log(`Open Foresight listening on http://127.0.0.1:${info.port}`));
