import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { runs } from '@open-foresight/db';
import { createGateway } from '../src/index.js';
import { models } from '../../../config/models.js';

if (process.argv.slice(2).join(' ') !== '--confirm-paid-live') {
  throw new Error('Refusing paid API calls without --confirm-paid-live');
}
const { DATABASE_URL: databaseUrl, OPENROUTER_API_KEY: apiKey } = process.env;
if (!databaseUrl || !apiKey) throw new Error('DATABASE_URL and OPENROUTER_API_KEY are required');

const sql = postgres(databaseUrl);
const db = drizzle(sql);
try {
  const gateway = await createGateway({ apiKey, models, db });
  const [run] = await db.insert(runs).values({ settings: { purpose: 'live gateway smoke test' }, modelProfile: 'smoke' }).returning();
  if (!run) throw new Error('Could not create smoke test run');
  process.stdout.write(`Audit run ID: ${run.id}\n`);
  for (const role of ['designer', 'analyst']) {
    const result = await gateway.generate({
      runId: run.id, role, promptVersion: 'smoke-v1', system: 'Reply in the requested JSON format.',
      user: 'Return the word ok in the answer field.', schemaName: 'smoke',
      schema: z.object({ answer: z.literal('ok') }).strict(), inputEvidenceIds: [], maxOutputTokens: 32,
    });
    process.stdout.write(`${role}: ${result.answer}\n`);
  }
} finally {
  await sql.end();
}
