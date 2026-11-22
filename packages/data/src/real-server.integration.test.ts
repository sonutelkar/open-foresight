import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { inArray, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { figiMappings, secListings } from '@open-foresight/db';
import { createSecSecurityProvider } from './index.js';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('real fixture HTTP and PostgreSQL', () => {
  it('syncs twice with stable IDs and unresolved mappings', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const tickers = [`A${suffix}`, `B${suffix}`, `C${suffix}`];
    const sec = { fields: ['cik', 'name', 'ticker', 'exchange'], data: tickers.map((ticker, index) => [111000 + index, `Fixture ${index}`, ticker, 'Test']) };
    const responses = [
      { data: [{ figi: `one-${suffix}`, name: 'Fixture 0', ticker: tickers[0], exchCode: 'US' }] },
      { data: [{ figi: `two-${suffix}`, name: 'Fixture 1', ticker: tickers[1], exchCode: 'US' }, { figi: `three-${suffix}`, name: 'Fixture 1', ticker: tickers[1], exchCode: 'US' }] },
      { warning: 'No identifier found.' },
    ];
    let secRequests = 0, figiRequests = 0;
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/sec') { secRequests++; response.end(JSON.stringify(sec)); return; }
      if (request.url === '/figi' && request.method === 'POST') {
        figiRequests++;
        for await (const _ of request) {}
        response.end(JSON.stringify(responses));
        return;
      }
      response.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local TCP address');
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    try {
      const provider = createSecSecurityProvider({ db, userAgent: 'fixture contact@example.com', secUrl: `http://127.0.0.1:${address.port}/sec`, openFigiUrl: `http://127.0.0.1:${address.port}/figi` });
      const first = await provider.sync();
      const read = () => db.select({ ticker: secListings.ticker, listingId: secListings.id, securityId: figiMappings.securityId, candidates: figiMappings.candidates }).from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(inArray(secListings.ticker, tickers));
      const before = await read();
      const second = await provider.sync();
      const after = await read();
      expect(first).toMatchObject({ records: 3, resolved: 1, ambiguous: 1, unmatched: 1 });
      expect(second).toMatchObject({ records: 3, resolved: 1, ambiguous: 1, unmatched: 1 });
      expect(before).toHaveLength(3);
      expect(after).toHaveLength(3);
      expect(new Map(after.map(row => [row.ticker, [row.listingId, row.securityId]]))).toEqual(new Map(before.map(row => [row.ticker, [row.listingId, row.securityId]])));
      expect(before.find(row => row.ticker === tickers[0])?.securityId).toBeTruthy();
      expect(before.find(row => row.ticker === tickers[1])).toMatchObject({ securityId: null, candidates: responses[1]?.data });
      expect(before.find(row => row.ticker === tickers[2])?.securityId).toBeNull();
      expect([secRequests, figiRequests]).toEqual([2, 2]);
      process.stdout.write(`${JSON.stringify({ before, after, secRequests, figiRequests })}\n`);
    } finally {
      await sql.end();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
