import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { webDocuments } from '@open-foresight/db';
import type { YahooRunner } from './index.js';
import { createYahooProfileProvider, profileContentType, profileText } from './profile.js';

const summary = 'E.ON SE operates as an energy company in Germany, the United Kingdom, Sweden and the Netherlands. The company operates through Energy Networks, Energy Infrastructure Solutions and Energy Retail segments. Energy Networks operates power and gas distribution networks and offers maintenance and repair services for them.';
const url = process.env.TEST_DATABASE_URL;

describe('profileText', () => {
  it('puts the name, sector and industry above the summary and skips missing parts', () => {
    expect(profileText({ name: 'E.ON SE', sector: 'Utilities', industry: 'Utilities - Diversified', summary: ` ${summary} ` })).toBe(`E.ON SE\nSector: Utilities. Industry: Utilities - Diversified\n\n${summary}`);
    expect(profileText({ summary })).toBe(`\n\n${summary}`);
  });
});

describe.skipIf(!url)('Yahoo company profiles on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const key = () => `lei:PR${randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase()}`;
  const runner = (lines: Array<Record<string, unknown>>, exitCode = 0): { run: YahooRunner; sent: Array<{ symbol: string; yahoo: string }> } => {
    const sent: Array<{ symbol: string; yahoo: string }> = [];
    return { sent, run: async items => { sent.push(...items); return { lines: lines.map(l => JSON.stringify(l)), exitCode, stderr: '' }; } };
  };
  const now = () => new Date('2026-11-23T10:00:00Z');

  it('stores a profile as its own kind, dated by its fetch day, and a second fetch of the same text is unchanged', async () => {
    const issuerKey = key();
    const r = runner([{ symbol: 'EOAN.XETRA', yahoo: 'EOAN.DE', name: 'E.ON SE', sector: 'Utilities', industry: 'Utilities - Diversified', summary }]);
    const provider = createYahooProfileProvider({ db, run: r.run, now });
    const item = { symbol: 'EOAN.XETRA', issuerKey, entityName: 'E.ON SE' };
    expect(await provider.sync({ items: [item] })).toEqual({ stored: ['EOAN.XETRA'], unchanged: [], missing: [], unsupported: [], rateLimited: false });
    expect(r.sent).toEqual([{ symbol: 'EOAN.XETRA', yahoo: 'EOAN.DE' }]);
    const [row] = await db.select().from(webDocuments).where(eq(webDocuments.issuerKey, issuerKey));
    expect(row).toMatchObject({ url: 'yahoo-finance://profile/EOAN.DE', contentType: profileContentType, extractor: 'yahoo-yfinance', availableOn: '2026-11-23', entityName: 'E.ON SE' });
    expect(row?.text).toContain('Sector: Utilities');
    expect(row?.headings).toEqual([{ offset: 0, level: 1, title: 'Company profile' }]);
    expect(await provider.sync({ items: [item] })).toMatchObject({ stored: [], unchanged: ['EOAN.XETRA'] });
    expect(await db.select().from(webDocuments).where(eq(webDocuments.issuerKey, issuerKey))).toHaveLength(1);
  });

  it('reports a short summary, a Yahoo error and an unsupported symbol, and stores nothing for them', async () => {
    const issuerKey = key();
    const r = runner([{ symbol: 'SHORT.XETRA', yahoo: 'SHORT.DE', summary: 'Too short.' }, { symbol: 'ERR.XETRA', yahoo: 'ERR.DE', error: 'HTTPError: 404' }]);
    const provider = createYahooProfileProvider({ db, run: r.run, now });
    const items = ['SHORT.XETRA', 'ERR.XETRA', 'ODD.ZZ'].map(symbol => ({ symbol, issuerKey, entityName: 'Test AG' }));
    expect(await provider.sync({ items })).toEqual({ stored: [], unchanged: [], missing: ['SHORT.XETRA', 'ERR.XETRA'], unsupported: ['ODD.ZZ'], rateLimited: false });
    expect(await db.select().from(webDocuments).where(eq(webDocuments.issuerKey, issuerKey))).toHaveLength(0);
  });

  it('stops and says so on a rate limit, and refuses bad input and a failing reader', async () => {
    const issuerKey = key();
    const limited = runner([{ symbol: 'EOAN.XETRA', yahoo: 'EOAN.DE', summary }, { symbol: 'RWE.XETRA', yahoo: 'RWE.DE', error: 'rate_limited' }], 3);
    const report = await createYahooProfileProvider({ db, run: limited.run, now }).sync({ items: [{ symbol: 'EOAN.XETRA', issuerKey, entityName: 'E.ON SE' }, { symbol: 'RWE.XETRA', issuerKey, entityName: 'RWE AG' }] });
    expect(report).toMatchObject({ stored: ['EOAN.XETRA'], rateLimited: true });
    await expect(createYahooProfileProvider({ db, run: runner([], 1).run }).sync({ items: [{ symbol: 'EOAN.XETRA', issuerKey, entityName: 'E.ON SE' }] })).rejects.toThrow('exit code 1');
    await expect(createYahooProfileProvider({ db, run: runner([]).run }).sync({ items: [{ symbol: 'EOAN.XETRA', issuerKey: 'bad key', entityName: 'E.ON SE' }] })).rejects.toThrow();
  });
});
