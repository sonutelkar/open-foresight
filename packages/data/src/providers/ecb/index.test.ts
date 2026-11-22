import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, fxRates } from '@open-foresight/db';
import { fxToUsdAsOf } from '../../fx.js';
import { createEcbFxProvider, parseEcbCsv } from './index.js';

const csv = await readFile(new URL('../../../fixtures/ecb/exr-2024-11.csv', import.meta.url), 'utf8');

describe('parseEcbCsv', () => {
  it('parses recorded rows and skips empty values', () => {
    const rows = parseEcbCsv(csv);
    expect(rows).toHaveLength(48);
    expect(rows.find(r => r.currency === 'USD' && r.date === '2024-11-08')?.perEur).toBe('1.0772');
    const header = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE';
    expect(parseEcbCsv(`${header}\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-11-01,`)).toEqual([]);
  });
  it('rejects malformed rows', () => {
    const header = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE';
    expect(() => parseEcbCsv(`${header}\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-11-01,-1`)).toThrow();
    expect(() => parseEcbCsv(`${header}\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-11-01`)).toThrow('columns');
    expect(() => parseEcbCsv(`${header}\nEXR.D.USD.EUR.SP00.A,D,USD,JPY,SP00,A,2024-11-01,1`)).toThrow();
  });
});

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('ECB FX on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 1 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  it('ingests recorded rates twice and converts as of a date, a weekend and a stale limit', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => { requests.push(request.url ?? ''); response.writeHead(200, { 'content-type': 'text/csv' }).end(csv); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local port');
    try {
      const provider = createEcbFxProvider({ db, baseUrl: `http://127.0.0.1:${address.port}`, now: () => new Date('2024-11-13T00:00:00Z') });
      const input = { currencies: ['USD', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK'], from: '2024-11-01', to: '2024-11-12' };
      expect(await provider.sync(input)).toMatchObject({ fetched: 48, inserted: 48 });
      expect(await provider.sync(input)).toMatchObject({ fetched: 48, inserted: 0 });
      expect(requests[0]).toContain('/service/data/EXR/D.CHF+DKK+GBP+NOK+SEK+USD.EUR.SP00.A');
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }

    const snapshot = await createSnapshot({ db });
    const currencies = ['USD', 'EUR', 'GBP', 'DKK'];
    const friday = await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf: '2024-11-08', currencies });
    expect(friday).toMatchObject({ USD: 1, EUR: 1.0772 });
    expect(friday.GBP).toBeCloseTo(1.0772 / 0.83188, 10);
    expect(friday.DKK).toBeCloseTo(1.0772 / 7.4573, 10);

    const sunday = await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf: '2024-11-10', currencies });
    expect(sunday.GBP).toBe(friday.GBP);
    expect(await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf: '2024-11-10', currencies, maxStaleDays: 1 })).toEqual({});
    expect(await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf: '2024-10-31', currencies })).toEqual({});
    const monday = await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf: '2024-11-11', currencies });
    expect(monday.GBP).toBeCloseTo(1.0651 / 0.8268, 10);

    // A rate revised after the snapshot is invisible to it and visible to a later one.
    await db.insert(fxRates).values({ source: 'ecb', currency: 'GBP', date: '2024-11-08', perEur: '0.9', ingestedAt: new Date() });
    expect((await fxToUsdAsOf({ db, snapshotId: snapshot.id, asOf: '2024-11-08', currencies })).GBP).toBe(friday.GBP);
    const later = await createSnapshot({ db });
    expect((await fxToUsdAsOf({ db, snapshotId: later.id, asOf: '2024-11-08', currencies })).GBP).toBeCloseTo(1.0772 / 0.9, 10);
  });

  it('fails clearly on server errors and bad input', async () => {
    const server = createServer((_, response) => response.writeHead(403).end());
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local port');
    try {
      const provider = createEcbFxProvider({ db, baseUrl: `http://127.0.0.1:${address.port}` });
      await expect(provider.sync({ currencies: ['USD'], from: '2024-11-01', to: '2024-11-02' })).rejects.toThrow('ECB returned HTTP 403');
      await expect(provider.sync({ currencies: ['EUR'], from: '2024-11-01', to: '2024-11-02' })).rejects.toThrow();
      await expect(provider.sync({ currencies: ['USD'], from: '2024-11-03', to: '2024-11-02' })).rejects.toThrow('after');
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});
