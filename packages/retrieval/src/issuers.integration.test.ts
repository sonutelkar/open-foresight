import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { exchangeListings, securities } from '@open-foresight/db';
import { issuerKeysForSecurity, linkIssuerAliases } from './issuers.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('issuer aliases on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });
  const tag = randomUUID().slice(0, 8);

  async function listing(symbol: string, resolved = true) {
    const [s] = await db.insert(securities).values({ shareClassFigi: `SC-${tag}-${symbol}`, name: symbol }).returning({ id: securities.id });
    await db.insert(exchangeListings).values({ source: 'test', symbol, exchange: 'XX', name: symbol, type: 'Common Stock', isin: `XX${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`, status: resolved ? 'resolved' as const : 'unmatched' as const, securityId: resolved ? s!.id : null, shareClasses: [], observedAt: new Date() });
    return s!.id;
  }

  it('adds the aliased issuer to a security that has none, and links once however often it runs', async () => {
    const symbol = `AL${tag}.XX`;
    const id = await listing(symbol);
    expect(await issuerKeysForSecurity(db, id)).toEqual([]);
    const alias = { symbol, issuerKey: 'cik:0000034088', note: 'test link for an issuer that no ticker reaches' };
    expect(await linkIssuerAliases(db, [alias])).toEqual({ linked: 1, missing: [] });
    expect(await linkIssuerAliases(db, [alias])).toEqual({ linked: 0, missing: [] });
    expect(await issuerKeysForSecurity(db, id)).toEqual(['cik:0000034088']);
  });

  it('keeps the issuers a security already has, and reports a symbol with no resolved security', async () => {
    const symbol = `BE${tag}.XX`;
    const id = await listing(symbol);
    await linkIssuerAliases(db, [{ symbol, issuerKey: 'lei:549300A0JPRWG1KI7U06', note: 'first test link' }, { symbol, issuerKey: 'cik:0000924613', note: 'second test link' }]);
    expect(await issuerKeysForSecurity(db, id)).toEqual(['cik:0000924613', 'lei:549300A0JPRWG1KI7U06']);
    const unresolved = `CE${tag}.XX`;
    await listing(unresolved, false);
    expect(await linkIssuerAliases(db, [{ symbol: unresolved, issuerKey: 'cik:0000034088', note: 'no security to attach to' }, { symbol: `NONE${tag}.XX`, issuerKey: 'cik:0000034088', note: 'no listing at all' }])).toEqual({ linked: 0, missing: [unresolved, `NONE${tag}.XX`] });
  });
});
