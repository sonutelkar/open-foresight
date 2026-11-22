import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createEsefProvider } from './index.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = url ? describe : describe.skip;

enabled('50-filing ESEF ingestion performance', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('ingests 50 constructed filings from one recorded report within the ceiling', async () => {
    const read = (name: string) => readFile(new URL(`../../../fixtures/esef/${name}`, import.meta.url), 'utf8');
    const indexTemplate = JSON.parse(await read('index.json'));
    const isins = await read('gleif-isins.json');
    const report = await read('report-excerpt.xhtml');
    const leis = Array.from({ length: 50 }, (_, i) => `PERF${String(i).padStart(14, '0')}${String(i % 100).padStart(2, '0')}`);
    const fetcher: typeof fetch = async input => {
      const u = new URL(String(input));
      if (u.host === 'gleif.fixture') return new Response(isins);
      if (u.pathname === '/api/filings') {
        const lei = u.searchParams.get('filter[entity.identifier]') ?? '';
        const body = JSON.parse(JSON.stringify(indexTemplate));
        body.data[0].attributes.fxo_id = `${lei}-2026-09-30-ESEF-DK-0`;
        body.data[0].attributes.sha256 = lei;
        return Response.json(body);
      }
      return new Response(report);
    };
    const provider = createEsefProvider({ db, fetch: fetcher, indexUrl: 'https://index.fixture', gleifUrl: 'https://gleif.fixture' });
    const start = performance.now();
    const result = await provider.sync({ leis });
    const elapsed = performance.now() - start;
    process.stdout.write(`${JSON.stringify({ perf: '50 filings x 206 KB report', inserted: result.inserted, ms: Math.round(elapsed) })}\n`);
    expect(result).toMatchObject({ filings: 50, inserted: 50 });
    expect(elapsed).toBeLessThan(120_000);
  }, 180_000);
});
