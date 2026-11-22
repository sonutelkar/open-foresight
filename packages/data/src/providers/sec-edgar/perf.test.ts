import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSecEdgarProvider } from './index.js';

const enabled = process.env.TEST_DATABASE_URL && process.env.SEC_50_COMPANY_PERF === '1' ? describe : describe.skip;
enabled('50-company constructed SEC fixture performance', () => {
  it('ingests 50 derived companies with three warm runs under the ceiling', async () => {
    const path = new URL('../../../fixtures/sec-edgar/', import.meta.url);
    const submissions = JSON.parse(await readFile(new URL('submissions.json', path), 'utf8'));
    const facts = JSON.parse(await readFile(new URL('companyfacts.json', path), 'utf8'));
    const original = await readFile(new URL('d10k.txt', path), 'utf8');
    const amendment = await readFile(new URL('d10ka.txt', path), 'utf8');
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      const match = request.url?.match(/CIK(\d{10})\.json$/);
      if (request.url?.startsWith('/submissions/') && match?.[1]) return response.end(JSON.stringify({ ...submissions, cik: match[1] }));
      if (request.url?.startsWith('/api/xbrl/companyfacts/') && match?.[1]) return response.end(JSON.stringify({ ...facts, cik: Number(match[1]) }));
      if (request.url?.endsWith('/d10k.htm')) return response.end(original);
      if (request.url?.endsWith('/d10ka.htm')) return response.end(amendment);
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local port');
    const base = `http://127.0.0.1:${address.port}`;
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    try {
      const provider = createSecEdgarProvider({ db: drizzle(sql), userAgent: 'fixture contact@example.com', dataBaseUrl: base, archivesBaseUrl: `${base}/Archives/edgar/data` });
      const timings: number[] = [];
      for (let run = 0; run < 4; run++) {
        const start = performance.now();
        for (let i = 0; i < 50; i++) {
          const result = await provider.sync({ cik: String(700000000 + i), accessions: ['0001193125-09-214859', '0001193125-10-012091'] });
          expect(result).toMatchObject({ filings: 2, facts: 2 });
        }
        if (run) timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      process.stdout.write(`${JSON.stringify({ description: '50 constructed CIKs derived from one recorded Apple fixture', requests, warmRunsMs: timings })}\n`);
      expect(requests).toBe(800);
      expect(timings[1]).toBeLessThan(120_000);
    } finally {
      await sql.end();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 600_000);
});
