import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, secSourceDocuments } from '@open-foresight/db';
import type { UniverseRules } from '@open-foresight/core';
import { buildUniverse } from './universe.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = url ? describe : describe.skip;

enabled('universe filter performance', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('filters 3,000 securities with 30 bars each, three warm runs under the ceiling', async () => {
    const [source] = await db.insert(secSourceDocuments).values({ url: 'universe-perf', transportUrl: 'universe-perf', sha256: 'universe-perf', body: '', fetchedAt: new Date('2024-11-02T00:00:00Z') }).returning({ id: secSourceDocuments.id });
    if (!source) throw new Error('no source');
    await client`INSERT INTO price_bars (source, symbol, date, open, high, low, close, volume, content_hash, raw, ingested_at)
      SELECT 'eodhd', 'P' || lpad(s::text, 4, '0') || '.US', date '2024-10-01' + d, 10, 11, 9, 10 + (s % 50), 20000 + (s % 40) * 10000 + d, 'h', '{}'::jsonb, timestamptz '2024-11-09'
      FROM generate_series(1, 3000) s, generate_series(0, 29) d`;
    await client`INSERT INTO sec_facts (key, cik, accession, taxonomy, concept, unit, value, period_end, filed_at, form, raw, source_id, source_pointer, ingested_at)
      SELECT 'perf/' || s, lpad((910000000 + s)::text, 10, '0'), '0000000000-24-000001', 'dei', 'EntityCommonStockSharesOutstanding', 'shares', 1000000 * (s % 700), date '2024-09-30', date '2024-10-15', '10-Q', '{}'::jsonb, ${source.id}, '/p', timestamptz '2024-11-02'
      FROM generate_series(1, 3000) s`;
    const listings = Array.from({ length: 3000 }, (_, i) => ({ symbol: `P${String(i + 1).padStart(4, '0')}.US`, cik: String(910000000 + i + 1).padStart(10, '0') }));
    const rules: UniverseRules = { regions: ['US'], minMarketCapUsd: 1e9, minAdvUsd: 5e6, maxStaleDays: 5, advWindow: 20, minAdvBars: 10, fxToUsd: { USD: 1 }, excluded: {} };
    const snapshot = await createSnapshot({ db });
    const timings: number[] = [];
    let included = 0;
    for (let run = 0; run < 4; run++) {
      const start = performance.now();
      const decisions = await buildUniverse({ db, snapshotId: snapshot.id, asOf: '2024-10-30', listings, rules });
      if (run) timings.push(performance.now() - start);
      expect(decisions).toHaveLength(3000);
      included = decisions.filter(d => d.included).length;
    }
    timings.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: 'filter 3,000 securities x 30 bars', included, warmRunsMs: timings.map(Math.round) })}\n`);
    expect(included).toBeGreaterThan(0);
    expect(included).toBeLessThan(3000);
    expect(timings[1]).toBeLessThan(10_000);
  }, 120_000);
});
