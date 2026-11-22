import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { enabledSources } from '@open-foresight/core';
import { llmCalls, runs } from '@open-foresight/db';
import { runDesigner, type DesignerInput, type StructuredGenerator } from './designer.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = url ? describe : describe.skip;
const recorded = JSON.parse(readFileSync(new URL('../fixtures/designer-real-completion.json', import.meta.url), 'utf8')) as { choices: Array<{ message: { content: string } }> };
const draft = JSON.parse(recorded.choices[0]!.message.content) as unknown;

const input: DesignerInput = {
  brief: 'Smart energy: companies that make the electricity system more efficient, flexible and digital over a five year horizon, including grid equipment, efficiency products and storage, with second order suppliers.',
  regions: ['US', 'EU', 'UK', 'CH'], exposureStyle: 'broad', asOf: '2026-11-20',
  universeSample: Array.from({ length: 40 }, (_, i) => ({ symbol: `SYM${i}.US`, name: `Company ${i}`, sector: 'Industrials' })),
};

enabled('Designer performance', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('processes 100 recorded drafts, with a saved draft and audit row each, inside the ceiling', async () => {
    const generator: StructuredGenerator = {
      async generate(request) {
        const value = request.schema.parse(draft);
        const [row] = await db.insert(llmCalls).values({ runId: request.runId, role: request.role, promptVersion: request.promptVersion, model: 'recorded/designer', provider: 'recorded', params: {}, requestHash: randomUUID(), inputEvidenceIds: request.inputEvidenceIds, response: recorded as object }).returning({ id: llmCalls.id });
        request.onAudit?.(row?.id ?? '');
        return value;
      },
    };
    const sources = enabledSources({ eodhd: true });
    const timings: number[] = [];
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const [run] = await db.insert(runs).values({ settings: {}, modelProfile: 'test' }).returning({ id: runs.id });
      const t = performance.now();
      const result = await runDesigner({ db, gateway: generator, runId: run!.id, input, availableSources: sources });
      timings.push(performance.now() - t);
      expect(result.ok).toBe(true);
    }
    const total = performance.now() - start;
    timings.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: '100 recorded Designer drafts', totalMs: Math.round(total), medianMs: Math.round(timings[50] ?? 0), p95Ms: Math.round(timings[95] ?? 0) })}\n`);
    expect(total).toBeLessThan(30_000);
  }, 120_000);
});
