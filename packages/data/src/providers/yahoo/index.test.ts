import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, marketCapObservations, priceBars } from '@open-foresight/db';
import type { UniverseRules } from '@open-foresight/core';
import { buildUniverse } from '../../universe.js';
import { createYahooProvider, normalizeYahoo, uvRunner, type YahooRunner } from './index.js';

const recorded = (await readFile(new URL('../../../fixtures/yahoo/fetch-lines.jsonl', import.meta.url), 'utf8')).split('\n').filter(Boolean);
const bySymbol = new Map(recorded.map(l => [JSON.parse(l).symbol as string, l]));
const runnerFor = (exitCode = 0, extra: string[] = []): YahooRunner => async items => ({ lines: [...items.map(i => bySymbol.get(i.symbol)).filter((l): l is string => !!l), ...extra], exitCode, stderr: '' });

describe('normalizeYahoo', () => {
  it('converts London pence into pounds', () => {
    expect(normalizeYahoo({ marketCap: 2.51e12, price: 108.35, currency: 'GBp' })).toEqual({ currency: 'GBP', marketCap: 2.51e10, price: 1.0835 });
    expect(normalizeYahoo({ marketCap: 5, price: 2, currency: 'EUR' })).toEqual({ currency: 'EUR', marketCap: 5, price: 2 });
    expect(normalizeYahoo({ marketCap: null, price: null, currency: null })).toEqual({ currency: null, marketCap: null, price: null });
  });
});

const hasUv = spawnSync('uv', ['--version']).status === 0;
describe.skipIf(!hasUv)('uv runner', () => {
  it('starts the Python script and exits cleanly on an empty list', async () => {
    const result = await uvRunner({ timeoutMs: 120_000 })([]);
    expect(result).toMatchObject({ lines: [], exitCode: 0 });
  }, 130_000);
});

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Yahoo observations on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  const now = () => new Date('2024-10-31T12:00:00Z');

  it('stores recorded lines, converts pence and reports gaps', async () => {
    const report = await createYahooProvider({ db, run: runnerFor(), now }).sync({ symbols: ['AAPL.US', 'SAP.XETRA', 'NESN.SW', 'VOD.LSE', 'SHEL.LSE', 'DSV.CO', 'ROG.SW', 'ZZZZ.US', 'ENEL.MI'] });
    expect(report).toMatchObject({ requested: 9, observed: 6, missing: ['ROG.SW', 'ZZZZ.US'], unsupported: ['ENEL.MI'], rateLimited: false, notAttempted: [] });
    const [vod] = await db.select().from(marketCapObservations).where(eq(marketCapObservations.symbol, 'VOD.LSE'));
    expect(vod).toMatchObject({ source: 'yahoo_python', sourceSymbol: 'VOD.L', currency: 'GBP' });
    expect(Number(vod?.marketCap)).toBeCloseTo(25_103_220_966, -3);
    expect(Number(vod?.sharesOutstanding)).toBe(23168639889);
    expect(Number(vod?.price)).toBeCloseTo(1.0835, 4);
  });

  it('stops at a rate limit, keeps what it read and does not retry', async () => {
    const runner: YahooRunner = async items => ({ lines: [bySymbol.get('AAPL.US') ?? '', JSON.stringify({ symbol: 'SAP.XETRA', yahoo: 'SAP.DE', error: 'rate_limited' })], exitCode: 3, stderr: '' });
    const calls: number[] = [];
    const report = await createYahooProvider({ db, run: async items => { calls.push(items.length); return runner(items); }, now }).sync({ symbols: ['AAPL.US', 'SAP.XETRA', 'NESN.SW'] });
    expect(calls).toEqual([3]);
    expect(report).toMatchObject({ rateLimited: true, observed: 1, notAttempted: ['SAP.XETRA', 'NESN.SW'] });
  });

  it('fails on a crash and never calls the runner without supported symbols', async () => {
    await expect(createYahooProvider({ db, run: async () => ({ lines: [], exitCode: 1, stderr: 'boom' }), now }).sync({ symbols: ['AAPL.US'] })).rejects.toThrow('exit code 1: boom');
    let called = false;
    const report = await createYahooProvider({ db, run: async () => { called = true; return { lines: [], exitCode: 0, stderr: '' }; }, now }).sync({ symbols: ['ENEL.MI'] });
    expect(called).toBe(false);
    expect(report).toMatchObject({ observed: 0, unsupported: ['ENEL.MI'] });
    await expect(createYahooProvider({ db, run: runnerFor(), now }).sync({ symbols: ['bad symbol'] })).rejects.toThrow();
  });

  it('screens a London name from observed shares times the pound close', async () => {
    // Own symbols, so bars and observations from other test files in the shared database cannot interfere.
    const rules: UniverseRules = { regions: ['UK', 'CH'], minMarketCapUsd: 1e9, minAdvUsd: 1e6, maxStaleDays: 30, advWindow: 5, minAdvBars: 3, fxToUsd: { GBP: 1.3, CHF: 1.1 }, excluded: {} };
    const bars = (symbol: string, close: string) => Array.from({ length: 12 }, (_, i) => ({ source: 'eodhd', symbol, date: `2024-10-${String(20 + i).padStart(2, '0')}`, close, volume: '20000000', contentHash: `y${i}`, raw: {}, ingestedAt: new Date('2024-11-01T00:00:00Z') }));
    await db.insert(priceBars).values([...bars('YHVOD.LSE', '108.35'), ...bars('YHNES.SW', '85.55')]);
    const shares = (symbol: string) => (JSON.parse(bySymbol.get(symbol) ?? '{}') as { shares: number }).shares;
    await db.insert(marketCapObservations).values([
      { source: 'yahoo_python', symbol: 'YHVOD.LSE', sourceSymbol: 'VOD.L', sharesOutstanding: String(shares('VOD.LSE')), currency: 'GBP', observedAt: now() },
      { source: 'yahoo_python', symbol: 'YHNES.SW', sourceSymbol: 'NESN.SW', sharesOutstanding: String(shares('NESN.SW')), currency: 'CHF', observedAt: now() },
    ]);
    const snapshot = await createSnapshot({ db });
    const decisions = await buildUniverse({ db, snapshotId: snapshot.id, asOf: '2024-10-31', listings: [{ symbol: 'YHVOD.LSE' }, { symbol: 'YHNES.SW' }], rules });
    const by = new Map(decisions.map(d => [d.symbol, d]));
    expect(by.get('YHVOD.LSE')).toMatchObject({ included: true, marketCapSource: 'observed_shares_x_close' });
    expect(by.get('YHVOD.LSE')?.marketCapUsd).toBeCloseTo(23168639889 * 1.0835 * 1.3, -4);
    expect(by.get('YHNES.SW')?.marketCapUsd).toBeCloseTo(2572220000 * 85.55 * 1.1, -4);
  });
});
