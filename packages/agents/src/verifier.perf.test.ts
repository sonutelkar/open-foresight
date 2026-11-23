import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { ResolvedCitation } from '@open-foresight/core';
import { documentChunks } from '@open-foresight/db';
import { loadStoredSpans } from './verifier.js';

const url = process.env.TEST_DATABASE_URL;
const N = 1000;

describe.skipIf(!url)('Stored span validation performance', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('validates 1,000 fixture citations against stored chunks inside the ceiling', async () => {
    const issuer = `cik:p${Math.floor(Math.random() * 1e9)}`;
    const text = (i: number) => `${'Background sentence. '.repeat(40)}Our grid products segment ${i} generated $3.1 billion of revenue, or 26% of total revenue, in fiscal 2025. ${'Closing sentence. '.repeat(40)}`;
    const zero = new Array(1536).fill(0) as number[];
    const version = `perf-${randomUUID()}`;
    const rows = await db.insert(documentChunks).values(Array.from({ length: 200 }, (_, i) => ({ docKind: 'sec_filing', docId: randomUUID(), issuerKey: issuer, availableOn: '2026-05-01', section: 'Item 1. Business', ordinal: i, startOffset: 0, endOffset: 100, text: text(i), embedding: zero, indexVersion: version }))).returning();
    const citations: ResolvedCitation[] = Array.from({ length: N }, (_, i) => { const r = rows[i % rows.length]!; return { evidenceId: `e${i}`, quote: `grid products segment ${i % rows.length} generated $3.1 billion of revenue`, chunkId: r.id, docKind: 'sec_filing', docId: r.docId, section: r.section, startOffset: 0, endOffset: 100, availableOn: '2026-05-01' }; });
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      const out = await loadStoredSpans(db, citations, { asOf: '2026-11-01', issuerKeys: [issuer] });
      times.push(performance.now() - t);
      expect(out.spans).toHaveLength(N);
      expect(out.rejected).toHaveLength(0);
    }
    times.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ perf: 'validate 1,000 fixture citations against stored chunks', medianMs: Math.round(times[1]!), runsMs: times.map(Math.round) })}\n`);
    expect(times[1]!).toBeLessThan(30_000);
  }, 60_000);
});
