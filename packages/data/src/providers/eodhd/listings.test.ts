import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { exchangeListings, securities, secListings, figiMappings } from '@open-foresight/db';
import { createSecSecurityProvider } from '../../index.js';
import { createEodhdListingsProvider } from './listings.js';

const read = async (name: string) => JSON.parse(await readFile(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8'));
const lists = await read('openfigi-isin/eodhd-symbol-lists.json') as Record<string, Array<Record<string, unknown>>>;
const figi = await read('openfigi-isin/openfigi-isin.json') as Record<string, { data: unknown[] }>;
const secFixture = await read('sec-listings.json');
const figiTicker = await read('openfigi-mappings.json');

describe('EODHD listings without a key', () => {
  it('is disabled', () => {
    expect(createEodhdListingsProvider({ db: drizzle(postgres('postgres://localhost/unused')) })).toBeUndefined();
  });
});

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('EODHD listings on Postgres', () => {
  const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(sql);

  // Constructed: a second SAP venue, an ETF, a bad ISIN, no ISIN, an ambiguous ISIN and an unmatched ISIN.
  const sap = lists.XETRA?.[0];
  const extra: Record<string, Array<Record<string, unknown>>> = {
    F: [{ ...sap, Exchange: 'F' }],
    TST: [
      { Code: 'ETF1', Name: 'Some ETF', Exchange: 'TST', Type: 'ETF', Currency: 'EUR', Isin: 'DE000ETF0001' },
      { Code: 'BADI', Name: 'Bad Isin Co', Exchange: 'TST', Type: 'Common Stock', Currency: 'EUR', Isin: 'not-an-isin' },
      { Code: 'NOIS', Name: 'No Isin Co', Exchange: 'TST', Type: 'Common Stock', Currency: 'EUR', Isin: null },
      { Code: 'AMBI', Name: 'Ambiguous Co', Exchange: 'TST', Type: 'Common Stock', Currency: 'EUR', Isin: 'DE000AMBI009' },
      { Code: 'NONE', Name: 'Nothing Co', Exchange: 'TST', Type: 'Common Stock', Currency: 'EUR', Isin: 'DE000NONE003' },
    ],
  };
  const make = () => {
    const calls = { eodhd: [] as string[], figi: [] as string[][] };
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('openfigi.fixture')) {
        const jobs = JSON.parse(String(init?.body)) as Array<{ idType: string; idValue: string; marketSecDes: string }>;
        calls.figi.push(jobs.map(j => j.idValue));
        expect(jobs.every(j => j.idType === 'ID_ISIN' && j.marketSecDes === 'Equity')).toBe(true);
        return Response.json(jobs.map(j => {
          if (j.idValue === 'DE000AMBI009') return { data: [{ figi: 'A1', name: 'AMBI', shareClassFIGI: 'SCA' }, { figi: 'A2', name: 'AMBI', shareClassFIGI: 'SCB' }] };
          if (j.idValue === 'DE000NONE003') return { warning: 'No identifier found.' };
          const recorded = figi[j.idValue];
          return recorded ? { data: recorded.data } : { error: 'unexpected isin' };
        }));
      }
      const u = new URL(url);
      calls.eodhd.push(u.pathname);
      if (u.searchParams.get('api_token') !== 'fixture-key') return new Response('', { status: 401 });
      const code = u.pathname.split('/').pop() ?? '';
      return Response.json(lists[code] ?? extra[code] ?? []);
    };
    return { calls, provider: createEodhdListingsProvider({ db, apiKey: 'fixture-key', fetch: fetcher, baseUrl: 'https://eodhd.fixture', openFigiUrl: 'https://openfigi.fixture' }) };
  };

  it('links venue listings to one security shared with the SEC master', async () => {
    const secFetch: typeof fetch = async input => String(input).includes('sec.fixture') ? Response.json(secFixture) : Response.json(figiTicker);
    await createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: secFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture' }).sync();
    const [apple] = await db.select().from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(eq(secListings.ticker, 'AAPL'));
    const secSecurityId = apple?.figi_mappings.securityId;
    expect(secSecurityId).toBeTruthy();
    const [secApple] = await db.select().from(securities).where(eq(securities.id, secSecurityId ?? ''));
    expect(secApple?.shareClassFigi).toBe('BBG001S5N8V8');

    const { provider, calls } = make();
    if (!provider) throw new Error('Expected provider');
    const input = { exchanges: ['US', 'XETRA', 'F', 'SW', 'LSE', 'TST'] };
    const first = await provider.sync(input);
    expect(first).toMatchObject({ listings: 9, resolved: 5, ambiguous: 1, unmatched: 1, noIsin: 2 });
    expect(calls.figi.flat().sort()).toEqual([...new Set(calls.figi.flat())].sort());
    expect(calls.figi.flat()).not.toContain('not-an-isin');

    const rows = new Map((await db.select().from(exchangeListings)).map(r => [r.symbol, r]));
    expect(rows.get('AAPL.US')?.securityId).toBe(secSecurityId);
    expect(rows.get('SAP.XETRA')?.securityId).toBeTruthy();
    expect(rows.get('SAP.F')?.securityId).toBe(rows.get('SAP.XETRA')?.securityId);
    expect(rows.get('NESN.SW')?.securityId).not.toBe(rows.get('VOD.LSE')?.securityId);
    expect(rows.get('VOD.LSE')).toMatchObject({ status: 'resolved', currency: 'GBX' });
    expect(rows.get('AMBI.TST')).toMatchObject({ status: 'ambiguous', securityId: null });
    expect(rows.get('NONE.TST')).toMatchObject({ status: 'unmatched', securityId: null });
    expect(rows.get('NOIS.TST')).toMatchObject({ status: 'no_isin', securityId: null });
    expect(rows.get('BADI.TST')).toMatchObject({ status: 'no_isin', isin: null });
    expect(rows.has('ETF1.TST')).toBe(false);

    const securitiesBefore = (await db.select().from(securities)).length;
    const second = await provider.sync(input);
    expect(second).toMatchObject({ resolved: 5, ambiguous: 1, unmatched: 1, noIsin: 2 });
    expect((await db.select().from(securities)).length).toBe(securitiesBefore);
    const again = new Map((await db.select().from(exchangeListings)).map(r => [r.symbol, r.securityId]));
    for (const [symbol, row] of rows) expect(again.get(symbol)).toBe(row.securityId);
    expect(again.size).toBe(rows.size);

    const only = await provider.sync({ exchanges: ['XETRA', 'F'], only: ['SAP.F'] });
    expect(only.listings).toBe(1);
  });

  it('fails without leaking the key', async () => {
    const provider = createEodhdListingsProvider({ db, apiKey: 'secret-token', fetch: async () => new Response('', { status: 403 }), baseUrl: 'https://eodhd.fixture' });
    const error = await provider?.sync({ exchanges: ['US'] }).catch(e => e as Error);
    expect((error as Error).message).toContain('HTTP 403');
    expect((error as Error).message).not.toContain('secret-token');
    await expect(provider?.sync({ exchanges: ['bad/exchange'] })).rejects.toThrow();
  });
});
