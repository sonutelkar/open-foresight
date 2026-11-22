import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, priceBars, secFacts, secSourceDocuments } from '@open-foresight/db';
import type { UniverseRules } from '@open-foresight/core';
import { buildUniverse } from '../../universe.js';
import { createEodhdProvider } from './index.js';

type Recorded = { symbols: Record<string, Array<Record<string, unknown>> | { httpStatus: number }> };
const fixtures = new URL('../../../fixtures/eodhd/', import.meta.url);
const recorded = JSON.parse(await readFile(new URL('eod-bars.json', fixtures), 'utf8')) as Recorded;
const universe = JSON.parse(await readFile(new URL('universe-50.json', fixtures), 'utf8')) as { asOf: string; fxToUsd: Record<string, number>; listings: Array<{ symbol: string; cik?: string; sharesOutstanding?: number }> };
const rules: UniverseRules = { regions: ['US', 'EU', 'UK', 'CH'], minMarketCapUsd: 1e9, minAdvUsd: 5e6, maxStaleDays: 5, advWindow: 20, minAdvBars: 10, fxToUsd: universe.fxToUsd, excluded: { 'KO.US': 'analyst exclusion' } };

describe('EODHD adapter without a key', () => {
  it('is disabled', () => {
    expect(createEodhdProvider({ db: drizzle(postgres('postgres://localhost/unused')) })).toBeUndefined();
    expect(createEodhdProvider({ db: drizzle(postgres('postgres://localhost/unused')), apiKey: '  ' })).toBeUndefined();
  });
});

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('EODHD prices and universe on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  async function serve(handler: (symbol: string, token: string | null) => { status: number; body: unknown }) {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      const u = new URL(request.url ?? '/', 'http://localhost');
      const symbol = decodeURIComponent(u.pathname.replace('/api/eod/', ''));
      requests.push(symbol);
      const { status, body } = handler(symbol, u.searchParams.get('api_token'));
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local port');
    return { base: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
  }
  const replay = (symbol: string, token: string | null) => {
    if (token !== 'fixture-key') return { status: 401, body: {} };
    const body = recorded.symbols[symbol];
    return !body || !Array.isArray(body) ? { status: 404, body: {} } : { status: 200, body };
  };

  it('ingests recorded bars twice, screens a 50-name universe and reports each reason', async () => {
    const symbols = universe.listings.map(l => l.symbol);
    const server = await serve(replay);
    try {
      const provider = createEodhdProvider({ db, apiKey: 'fixture-key', baseUrl: server.base, now: () => new Date('2024-11-09T00:00:00Z') });
      if (!provider) throw new Error('Expected provider');
      const first = await provider.sync({ symbols, from: '2024-09-20', to: '2024-11-08' });
      expect(first).toMatchObject({ symbols: 50, unknown: ['ENEL.MI', 'ZZZZ.US'], empty: [], skippedRows: 0 });
      expect(first.inserted).toBe(first.fetched);
      const repeat = await provider.sync({ symbols, from: '2024-09-20', to: '2024-11-08' });
      expect(repeat.inserted).toBe(0);
      expect(repeat.fetched).toBe(first.fetched);
    } finally { await server.close(); }

    const [source] = await db.insert(secSourceDocuments).values({ url: 'universe-50', transportUrl: 'universe-50', sha256: 'universe-50', body: '', fetchedAt: new Date('2024-11-02T00:00:00Z') }).returning({ id: secSourceDocuments.id });
    if (!source) throw new Error('no source');
    for (const l of universe.listings) if (l.cik && l.sharesOutstanding) await db.insert(secFacts).values({ key: `universe-50/${l.cik}`, cik: l.cik, accession: '0000000000-24-000001', taxonomy: 'dei', concept: 'EntityCommonStockSharesOutstanding', unit: 'shares', value: String(l.sharesOutstanding), periodEnd: '2024-09-30', filedAt: '2024-11-01', form: '10-Q', raw: {}, sourceId: source.id, sourcePointer: '/p', ingestedAt: new Date('2024-11-02T00:00:00Z') });

    const snapshot = await createSnapshot({ db });
    const decisions = await buildUniverse({ db, snapshotId: snapshot.id, asOf: universe.asOf, listings: universe.listings, rules });
    process.stdout.write(`${decisions.map(d => `${d.symbol.padEnd(11)} ${d.included ? 'IN ' : 'OUT'} cap=${d.marketCapUsd === null ? '-' : (d.marketCapUsd / 1e9).toFixed(2) + 'bn'} adv=${d.advUsd === null ? '-' : (d.advUsd / 1e6).toFixed(1) + 'm'} ${d.reasons.join(',')}`).join('\n')}\n`);
    expect(decisions).toHaveLength(50);

    const by = new Map(decisions.map(d => [d.symbol, d]));
    expect(by.get('AAPL.US')).toMatchObject({ included: true, reasons: [], region: 'US' });
    expect(by.get('KO.US')?.reasons).toEqual(['excluded_by_rule']);
    expect(by.get('ZZZZ.US')?.reasons).toEqual(['no_price', 'market_cap_unavailable', 'adv_unavailable']);
    expect(by.get('ENEL.MI')?.reasons).toEqual(['no_price', 'market_cap_unavailable', 'adv_unavailable']);
    expect(by.get('TPIC.US')?.reasons).toContain('below_min_market_cap');
    for (const d of decisions.filter(d => d.region !== 'US' && d.lastBarDate)) expect(d.reasons).toContain('market_cap_unavailable');
    expect(by.get('VWS.CO')?.reasons).toContain('fx_unavailable');
    expect(by.get('VOD.LSE')?.advUsd).toBeGreaterThan(5e6);

    // Same snapshot, earlier date: later bars are invisible.
    const early = await buildUniverse({ db, snapshotId: snapshot.id, asOf: '2024-10-01', listings: universe.listings.filter(l => l.symbol === 'AAPL.US'), rules });
    expect(early[0]?.lastBarDate).toBe('2024-10-01');

    // A bar corrected after the snapshot does not change that snapshot's answer.
    const before = by.get('AAPL.US')?.advUsd;
    await db.insert(priceBars).values({ source: 'eodhd', symbol: 'AAPL.US', date: '2024-11-08', close: '1', volume: '1', contentHash: 'correction', raw: {}, ingestedAt: new Date() });
    const after = await buildUniverse({ db, snapshotId: snapshot.id, asOf: universe.asOf, listings: universe.listings.filter(l => l.symbol === 'AAPL.US'), rules });
    expect(after[0]?.advUsd).toBe(before);
    const later = await createSnapshot({ db });
    const corrected = await buildUniverse({ db, snapshotId: later.id, asOf: universe.asOf, listings: universe.listings.filter(l => l.symbol === 'AAPL.US'), rules });
    expect(corrected[0]?.advUsd).not.toBe(before);
  }, 120_000);

  it('handles missing values, retries and failures without leaking the key', async () => {
    let calls = 0;
    const rows = [
      { date: '2023-05-01', open: 10, high: 11, low: 9, close: 10.5, adjusted_close: 10.5, volume: 100 },
      { date: '2023-05-02', open: null, high: null, low: null, close: 10.6, adjusted_close: 10.6, volume: null },
      { date: '2023-05-03', open: 1, high: 1, low: 1, close: null, adjusted_close: null, volume: 0 },
    ];
    const server = await serve((symbol, token) => {
      if (token !== 'secret-token') return { status: 401, body: {} };
      if (symbol === 'FLAKY.US') return ++calls === 1 ? { status: 503, body: {} } : { status: 200, body: rows };
      if (symbol === 'EMPTY.US') return { status: 200, body: [] };
      if (symbol === 'DENIED.US') return { status: 403, body: {} };
      return { status: 200, body: rows };
    });
    try {
      const provider = createEodhdProvider({ db, apiKey: 'secret-token', baseUrl: server.base });
      if (!provider) throw new Error('Expected provider');
      const report = await provider.sync({ symbols: ['FLAKY.US', 'EMPTY.US'], from: '2023-05-01', to: '2023-05-03' });
      expect(report).toMatchObject({ fetched: 2, inserted: 2, skippedRows: 1, empty: ['EMPTY.US'], unknown: [] });
      expect(calls).toBe(2);
      const stored = await db.select().from(priceBars).where((await import('drizzle-orm')).eq(priceBars.symbol, 'FLAKY.US'));
      expect(stored.find(r => r.date === '2023-05-02')).toMatchObject({ open: null, volume: null, close: '10.6' });
      const error = await provider.sync({ symbols: ['DENIED.US'], from: '2023-05-01', to: '2023-05-03' }).catch(e => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('EODHD returned HTTP 403 for DENIED.US');
      expect((error as Error).message).not.toContain('secret-token');
      await expect(provider.sync({ symbols: ['bad symbol'], from: '2023-05-01', to: '2023-05-03' })).rejects.toThrow();
      await expect(provider.sync({ symbols: ['A.US'], from: '2023-05-03', to: '2023-05-01' })).rejects.toThrow('after');
    } finally { await server.close(); }
  }, 30_000);
});
