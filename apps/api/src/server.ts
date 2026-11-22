// The local API and web app. Usage: DATABASE_URL=... OPENROUTER_API_KEY=... APPROVAL_TOKEN=... bun src/server.ts
// It listens on 127.0.0.1 only. Every change needs the approver token in the x-approval-token header.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources } from '@open-foresight/core';
import { runDesigner } from '@open-foresight/agents';
import { createGateway } from '@open-foresight/llm';
import { models } from '../../../config/models.js';
import { createApp } from './app.js';

const env = (name: string) => { const v = process.env[name]; if (!v?.trim()) throw new Error(`Set ${name}`); return v; };
const token = env('APPROVAL_TOKEN');
if (token.length < 16) throw new Error('APPROVAL_TOKEN must be at least 16 characters');
const sql = postgres(env('DATABASE_URL'), { max: 5 });
const db = drizzle(sql);
const availableSources = enabledSources({ eodhd: Boolean(process.env.EODHD_API_KEY?.trim()) });
const designerModel = models.find(m => m.role === 'designer');
if (!designerModel) throw new Error('config/models.ts has no designer role');
const gateway = await createGateway({ apiKey: env('OPENROUTER_API_KEY'), models: [designerModel], db });

const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const { app } = createApp({
  db, token, availableSources, today: () => new Date().toISOString().slice(0, 10),
  design: ({ runId, input }) => runDesigner({ db, gateway, runId, input, availableSources }),
  staticDir: existsSync(webDist) ? webDist : undefined,
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, info => console.log(`Open Foresight listening on http://127.0.0.1:${info.port}`));
