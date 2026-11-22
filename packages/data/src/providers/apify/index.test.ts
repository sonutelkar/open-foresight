import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, marketCapObservations, priceBars, secFacts, secSourceDocuments } from '@open-foresight/db';
import type { UniverseRules } from '@open-foresight/core';
import { buildUniverse } from '../../universe.js';
import { createApifyMarketCapProvider } from './index.js';

const recorded = JSON.parse(await readFile(new URL('../../../fixtures/apify/yahoo-finance-12.json', import.meta.url), 'utf8')) as { items: Array<{ ticker: string; stock_info: { market_cap: number | string } }> };

describe('Apify market caps without a token', () => {
  it('is disabled', () => {
    expect(createApifyMarketCapProvider({ db: drizzle(postgres('postgres://localhost/unused')) })).toBeUndefined();
    expect(createApifyMarketCapProvider({ db: drizzle(postgres('postgres://localhost/unused')), token: ' ' })).toBeUndefined();
  });
});

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Apify market caps on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);

  function stub(handler: (body: { tickers: string[] }) => unknown[]) {
    const seen: Array<{ url: string; auth: string | null; body: { tickers: string[]; start_date: string; end_date: string } }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body });
      return Response.json(handler(body), { status: 201 });
    };
    return { seen, fetcher };
  }

  it('records real actor output as observations and reports gaps', async () => {
    const { seen, fetcher } = stub(body => recorded.items.filter(i => body.tickers.includes(i.ticker)));
    const provider = createApifyMarketCapProvider({ db, token: 'secret-token', fetch: fetcher, baseUrl: 'https://apify.fixture', batchSize: 5, maxChargeUsdPerBatch: 0.1, now: () => new Date('2026-11-22T18:10:00Z') });
    if (!provider) throw new Error('Expected provider');
    const symbols = ['AAPL.US', 'SAP.XETRA', 'SIE.XETRA', 'MC.PA', 'ASML.AS', 'NESN.SW', 'ROG.SW', 'ALO.PA', 'VOD.LSE', 'DSV.CO', 'VOLV-B.ST', 'ZZZ.XETRA', 'ENEL.MI'];
    const report = await provider.sync({ symbols });
    expect(report).toMatchObject({ requested: 13, observed: 9, batches: 3, unsupported: ['ENEL.MI'], missing: ['ROG.SW', 'ALO.PA', 'ZZZ.XETRA'] });
    expect(seen).toHaveLength(3);
    expect(seen.flatMap(s => s.body.tickers)).toEqual(['AAPL', 'SAP.DE', 'SIE.DE', 'MC.PA', 'ASML.AS', 'NESN.SW', 'ROG.SW', 'ALO.PA', 'VOD.L', 'DSV.CO', 'VOLV-B.ST', 'ZZZ.DE']);
    for (const s of seen) {
      expect(s.auth).toBe('Bearer secret-token');
      expect(s.url).not.toContain('secret-token');
      expect(new URL(s.url).searchParams.get('maxTotalChargeUsd')).toBe('0.1');
      expect(s.body).toMatchObject({ start_date: '2026-11-17', end_date: '2026-11-22' });
    }
    const [sap] = await db.select().from(marketCapObservations).where(eq(marketCapObservations.symbol, 'SAP.XETRA'));
    expect(sap).toMatchObject({ source: 'apify_yahoo', sourceSymbol: 'SAP.DE' });
    expect(Number(sap?.marketCap)).toBe(recorded.items.find(i => i.ticker === 'SAP.DE')?.stock_info.market_cap);
    expect(sap?.observedAt.toISOString()).toBe('2026-11-22T18:10:00.000Z');
  });

  it('fails without leaking the token and rejects bad input', async () => {
    const provider = createApifyMarketCapProvider({ db, token: 'secret-token', fetch: async () => new Response('', { status: 402 }), baseUrl: 'https://apify.fixture' });
    const error = await provider?.sync({ symbols: ['SAP.XETRA'] }).catch(e => e as Error);
    expect((error as Error).message).toBe('Apify returned HTTP 402');
    await expect(provider?.sync({ symbols: ['nodot'] })).rejects.toThrow();
    expect(() => createApifyMarketCapProvider({ db, token: 't', batchSize: 0 })).toThrow();
  });

  it('screens with observed caps only when the date and age allow, and prefers shares', async () => {
    const rules: UniverseRules = { regions: ['US', 'EU'], minMarketCapUsd: 1e9, minAdvUsd: 1e6, maxStaleDays: 30, advWindow: 5, minAdvBars: 3, fxToUsd: { USD: 1, EUR: 1.1 }, excluded: {} };
    const bars = (symbol: string) => Array.from({ length: 12 }, (_, i) => ({ source: 'eodhd', symbol, date: `2024-10-${String(20 + i).padStart(2, '0')}`, close: '100', volume: '100000', contentHash: `h${i}`, raw: {}, ingestedAt: new Date('2024-11-01T00:00:00Z') }));
    await db.insert(priceBars).values([...bars('OBSA.XETRA'), ...bars('SHRA.US')]);
    const at = (iso: string, symbol: string, value: number) => ({ source: 'apify_yahoo', symbol, sourceSymbol: symbol, marketCap: String(value), observedAt: new Date(iso) });
    await db.insert(marketCapObservations).values([at('2024-10-30T12:00:00Z', 'OBSA.XETRA', 2e11), at('2024-10-30T12:00:00Z', 'SHRA.US', 7e11)]);
    const [source] = await db.insert(secSourceDocuments).values({ url: 'apify-test', transportUrl: 'apify-test', sha256: 'apify-test', body: '', fetchedAt: new Date('2024-10-01T00:00:00Z') }).returning({ id: secSourceDocuments.id });
    if (!source) throw new Error('no source');
    await db.insert(secFacts).values({ key: 'apify-test/shra', cik: '9100000001', accession: '0000000000-24-000001', taxonomy: 'dei', concept: 'EntityCommonStockSharesOutstanding', unit: 'shares', value: '10000000', periodEnd: '2024-09-30', filedAt: '2024-10-15', form: '10-Q', raw: {}, sourceId: source.id, sourcePointer: '/p', ingestedAt: new Date('2024-10-16T00:00:00Z') });
    const snapshot = await createSnapshot({ db });
    const run = (asOf: string, extra: { maxMarketCapAgeDays?: number } = {}) => buildUniverse({ db, snapshotId: snapshot.id, asOf, listings: [{ symbol: 'OBSA.XETRA' }, { symbol: 'SHRA.US', cik: '9100000001' }], rules, ...extra });
    const by = (ds: Awaited<ReturnType<typeof run>>) => new Map(ds.map(d => [d.symbol, d]));

    const same = by(await run('2024-10-31'));
    expect(same.get('OBSA.XETRA')).toMatchObject({ included: true, marketCapSource: 'observed' });
    expect(same.get('OBSA.XETRA')?.marketCapUsd).toBeCloseTo(2.2e11, -3);
    expect(same.get('SHRA.US')).toMatchObject({ marketCapSource: 'shares_x_close', marketCapUsd: 1e9 });

    expect(by(await run('2024-10-29')).get('OBSA.XETRA')?.reasons).toContain('market_cap_unavailable');
    expect(by(await run('2024-11-06')).get('OBSA.XETRA')?.marketCapSource).toBe('observed'); // 7 calendar days old, allowed
    expect(by(await run('2024-11-07')).get('OBSA.XETRA')?.reasons).toContain('market_cap_unavailable'); // 8 days old
    expect(by(await run('2024-11-07', { maxMarketCapAgeDays: 10 })).get('OBSA.XETRA')?.marketCapSource).toBe('observed');
  });
});
