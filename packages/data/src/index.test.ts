import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { figiMappings, secListings } from '@open-foresight/db';
import { createSecSecurityProvider, parseSecListings } from './index.js';

const secFixture: unknown = JSON.parse(await readFile(new URL('../fixtures/sec-listings.json', import.meta.url), 'utf8'));
const figiFixture: unknown = JSON.parse(await readFile(new URL('../fixtures/openfigi-mappings.json', import.meta.url), 'utf8'));

it('validates and deduplicates SEC listings without merging share classes', () => {
  const result = parseSecListings(secFixture);
  expect(result).toHaveLength(3);
  expect(result[0]).toMatchObject({ cik: '0000320193', ticker: 'AAPL' });
  expect(() => parseSecListings({ fields: ['ticker'], data: [] })).toThrow();
});

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('security sync with Postgres', () => {
  it('retries a rate limit and reuses stable security IDs', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    let calls = 0;
    const fixtureFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('sec.fixture')) return Response.json(secFixture);
      expect(init?.method).toBe('POST');
      calls++;
      if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      return Response.json(figiFixture);
    };
    try {
      const provider = createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture' });
      const first = await provider.sync();
      const [apple] = await db.select().from(secListings).where(eq(secListings.ticker, 'AAPL'));
      const [microsoft] = await db.select().from(secListings).where(eq(secListings.ticker, 'MSFT'));
      expect(apple).toBeDefined(); expect(microsoft).toBeDefined();
      if (!apple || !microsoft) throw new Error('Missing fixture listings');
      const [initial] = await db.select().from(figiMappings).where(eq(figiMappings.listingId, apple.id));
      const [microsoftMapping] = await db.select().from(figiMappings).where(eq(figiMappings.listingId, microsoft.id));
      expect(first).toMatchObject({ records: 3, resolved: 3, ambiguous: 0, unmatched: 0 });
      expect(initial?.securityId).toBeTruthy();
      expect(microsoftMapping?.securityId).toBeTruthy();
      const second = await provider.sync();
      const [again] = await db.select().from(figiMappings).where(eq(figiMappings.listingId, apple.id));
      const listingsAfter = await db.select().from(secListings).where(eq(secListings.ticker, 'AAPL'));
      const mappingsAfter = await db.select().from(figiMappings).where(eq(figiMappings.listingId, apple.id));
      expect(second).toMatchObject({ records: 3, resolved: 3, ambiguous: 0, unmatched: 0 });
      expect(again?.securityId).toBe(initial?.securityId);
      expect(listingsAfter).toHaveLength(1);
      expect(mappingsAfter).toHaveLength(1);
      expect(calls).toBe(3);
    } finally { await sql.end(); }
  });
  it('preserves multiple FIGI candidates without selecting one', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const ticker = `AMBIG${Date.now()}`;
    const fixtureFetch: typeof fetch = async input => String(input).includes('sec.fixture')
      ? Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[333333, 'Ambiguous issuer', ticker, 'Test']] })
      : Response.json([{ data: [{ figi: 'BBG000B9XRY4', name: 'APPLE INC' }, { figi: 'BBG000BPH459', name: 'MICROSOFT CORP' }] }]);
    try {
      const db = drizzle(sql);
      const report = await createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture' }).sync();
      const [mapping] = await db.select().from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(eq(secListings.ticker, ticker));
      expect(report).toMatchObject({ ambiguous: 1, resolved: 0 });
      expect(mapping?.figi_mappings.securityId).toBeNull();
      expect(mapping?.figi_mappings.candidates).toHaveLength(2);
    } finally { await sql.end(); }
  });
  it('does not assign a ticker shared by different issuers', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const ticker = `COLLIDE${Date.now()}`;
    const fixtureFetch: typeof fetch = async input => String(input).includes('sec.fixture')
      ? Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[111111, 'Issuer A', ticker, 'Test'], [222222, 'Issuer B', ticker, 'Test']] })
      : Response.json([{ data: [{ figi: `fixture-${ticker}`, name: 'Issuer A' }] }, { data: [{ figi: `fixture-${ticker}`, name: 'Issuer A' }] }]);
    try {
      const db = drizzle(sql);
      const report = await createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture' }).sync();
      const mappings = await db.select().from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(eq(secListings.ticker, ticker));
      expect(report).toMatchObject({ resolved: 0, ambiguous: 2 });
      expect(mappings).toHaveLength(2);
      expect(mappings.every(row => row.figi_mappings.securityId === null)).toBe(true);
    } finally { await sql.end(); }
  });
  it('preserves a FIGI claimed by different CIKs and rejects a mismatched ticker', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const stamp = String(Date.now());
    const tickers = [`A${stamp}`, `B${stamp}`, `C${stamp}`];
    const fixtureFetch: typeof fetch = async input => String(input).includes('sec.fixture')
      ? Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: tickers.map((ticker, index) => [400000 + index, `Issuer ${index}`, ticker, 'Test']) })
      : Response.json([
        { data: [{ figi: `shared-${stamp}`, name: 'Issuer 0', ticker: tickers[0], exchCode: 'US' }] },
        { data: [{ figi: `shared-${stamp}`, name: 'Issuer 1', ticker: tickers[1], exchCode: 'US' }] },
        { data: [{ figi: `other-${stamp}`, name: 'Issuer 2', ticker: 'WRONG', exchCode: 'US' }] },
      ]);
    try {
      const db = drizzle(sql);
      const report = await createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture' }).sync();
      expect(report).toMatchObject({ resolved: 0, ambiguous: 3 });
      for (const ticker of tickers) {
        const rows = await db.select().from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(eq(secListings.ticker, ticker));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.figi_mappings.securityId).toBeNull();
        expect(rows[0]?.figi_mappings.candidates).toHaveLength(1);
      }
    } finally { await sql.end(); }
  });
  it('keeps an absent issuer conflict unresolved across later syncs', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const stamp = String(Date.now());
    let current = 0;
    const tickers = [`OLD${stamp}`, `NEW${stamp}`];
    const fixtureFetch: typeof fetch = async input => String(input).includes('sec.fixture')
      ? Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[600000 + current, `Issuer ${current}`, tickers[current], 'Test']] })
      : Response.json([{ data: [{ figi: `cross-sync-${stamp}`, name: `Issuer ${current}`, ticker: tickers[current], exchCode: 'US' }] }]);
    try {
      const db = drizzle(sql);
      const provider = createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture' });
      expect(await provider.sync()).toMatchObject({ resolved: 1, reclassified: 0 });
      const read = (ticker: string) => db.select().from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(eq(secListings.ticker, ticker));
      expect((await read(tickers[0] ?? ''))[0]?.figi_mappings.securityId).toBeTruthy();
      current = 1;
      expect(await provider.sync()).toMatchObject({ resolved: 0, ambiguous: 1, reclassified: 1 });
      expect((await read(tickers[0] ?? ''))[0]?.figi_mappings.securityId).toBeNull();
      expect((await read(tickers[1] ?? ''))[0]?.figi_mappings.securityId).toBeNull();
      expect(await provider.sync()).toMatchObject({ resolved: 0, ambiguous: 1, reclassified: 0 });
      expect((await read(tickers[1] ?? ''))[0]?.figi_mappings.securityId).toBeNull();
    } finally { await sql.end(); }
  });
  it('does not invalidate a unique match because another issuer has an ambiguous candidate', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const stamp = String(Date.now());
    const tickers = [`VALID${stamp}`, `MAYBE${stamp}`];
    const fixtureFetch: typeof fetch = async input => String(input).includes('sec.fixture')
      ? Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[700001, 'Issuer 1', tickers[0], 'Test'], [700002, 'Issuer 2', tickers[1], 'Test']] })
      : Response.json([
        { data: [{ figi: `unique-${stamp}`, name: 'Issuer 1', ticker: tickers[0], exchCode: 'US' }] },
        { data: [{ figi: `unique-${stamp}`, name: 'Issuer 1', ticker: tickers[0], exchCode: 'US' }, { figi: `other-${stamp}`, name: 'Issuer 2', ticker: tickers[1], exchCode: 'US' }] },
      ]);
    try {
      const db = drizzle(sql);
      const provider = createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture' });
      expect(await provider.sync()).toMatchObject({ resolved: 1, ambiguous: 1, reclassified: 0 });
      const read = () => db.select().from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(eq(secListings.ticker, tickers[0] ?? ''));
      const [before] = await read();
      expect(before?.figi_mappings.securityId).toBeTruthy();
      expect(await provider.sync()).toMatchObject({ resolved: 1, ambiguous: 1, reclassified: 0 });
      const [after] = await read();
      expect(after?.figi_mappings.securityId).toBe(before?.figi_mappings.securityId);
    } finally { await sql.end(); }
  });
  it('serializes concurrent syncs that claim the same FIGI', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const stamp = String(Date.now());
    const tickers = [`LEFT${stamp}`, `RIGHT${stamp}`];
    const db = drizzle(sql);
    const provider = (index: number) => createSecSecurityProvider({ db, userAgent: 'test contact@example.com', secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture', fetch: async input => String(input).includes('sec.fixture')
      ? Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[800000 + index, `Issuer ${index}`, tickers[index], 'Test']] })
      : Response.json([{ data: [{ figi: `parallel-${stamp}`, name: `Issuer ${index}`, ticker: tickers[index], exchCode: 'US' }] }]) });
    try {
      await Promise.all([provider(0).sync(), provider(1).sync()]);
      for (const ticker of tickers) {
        const rows = await db.select().from(secListings).innerJoin(figiMappings, eq(secListings.id, figiMappings.listingId)).where(eq(secListings.ticker, ticker));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.figi_mappings.securityId).toBeNull();
      }
    } finally { await sql.end(); }
  });
  it('writes nothing if a later mapping batch fails', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const prefix = `FAIL${Date.now()}`;
    const tickers = Array.from({ length: 101 }, (_, index) => `${prefix}${index}`);
    let calls = 0;
    const fixtureFetch: typeof fetch = async input => {
      if (String(input).includes('sec.fixture')) return Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: tickers.map((ticker, index) => [500000 + index, `Issuer ${index}`, ticker, 'Test']) });
      calls++;
      if (calls === 1) return Response.json(Array.from({ length: 100 }, () => ({ warning: 'No identifier found.' })));
      return new Response('', { status: 400 });
    };
    try {
      const db = drizzle(sql);
      const provider = createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture', openFigiApiKey: 'fixture' });
      await expect(provider.sync()).rejects.toThrow('HTTP 400');
      const rows = await db.select().from(secListings).where(eq(secListings.ticker, tickers[0] ?? ''));
      expect(rows).toHaveLength(0);
    } finally { await sql.end(); }
  });
  it('ingests a 1,000-listing fixture within the plan ceiling', async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused');
    const db = drizzle(sql);
    const prefix = 'OFPR07BENCH';
    const data = Array.from({ length: 1000 }, (_, index) => [900000000 + index, `Fixture ${index}`, `${prefix}${index}`, 'TEST']);
    const fixtureFetch: typeof fetch = async (input, init) => {
      if (String(input).includes('sec.fixture')) return Response.json({ fields: ['cik', 'name', 'ticker', 'exchange'], data });
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : [];
      return Response.json(body.map(() => ({ warning: 'No identifier found.' })));
    };
    try {
      const provider = createSecSecurityProvider({ db, userAgent: 'test contact@example.com', fetch: fixtureFetch, secUrl: 'https://sec.fixture', openFigiUrl: 'https://figi.fixture', openFigiApiKey: 'fixture' });
      await provider.sync();
      const timings: number[] = [];
      for (let iteration = 0; iteration < 3; iteration++) {
        const started = performance.now();
        const report = await provider.sync();
        timings.push(performance.now() - started);
        expect(report).toMatchObject({ records: 1000, unmatched: 1000 });
      }
      timings.sort((a, b) => a - b);
      expect(timings[1]).toBeLessThan(30_000);
    } finally { await sql.end(); }
  }, 130_000);
});
