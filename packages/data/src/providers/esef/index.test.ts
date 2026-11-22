import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, esefDocuments, esefFilings, esefFilingsAsOf, exchangeListings, leiIsins, securities, securityIdsForLeis } from '@open-foresight/db';
import { createEsefProvider } from './index.js';

const read = (name: string) => readFile(new URL(`../../../fixtures/esef/${name}`, import.meta.url), 'utf8');
const indexText = await read('index.json');
const isinsText = await read('gleif-isins.json');
const reverseText = await read('gleif-reverse.json');
const report = await read('report-excerpt.xhtml');
const LEI = '549300D2K6PKKKXVNN73';
const index = JSON.parse(indexText) as { data: Array<{ attributes: Record<string, unknown>; relationships: unknown }>; included: unknown[] };

type Route = { status?: number; body?: string; headers?: Record<string, string> };
function stub(routes: { index?: (url: URL) => Route; isins?: (url: URL) => Route; reverse?: (url: URL) => Route; report?: (url: URL) => Route } = {}) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    calls.push(`${url.host}${url.pathname}`);
    let route: Route;
    if (url.host === 'gleif.fixture' && url.pathname.endsWith('/isins')) route = routes.isins?.(url) ?? { body: isinsText };
    else if (url.host === 'gleif.fixture') route = routes.reverse?.(url) ?? { body: reverseText };
    else if (url.pathname === '/api/filings') route = routes.index?.(url) ?? { body: indexText };
    else route = routes.report?.(url) ?? { body: report };
    return new Response(route.body ?? '', { status: route.status ?? 200, headers: route.headers });
  };
  return { calls, fetcher };
}
const make = (db: PostgresJsDatabase, s: ReturnType<typeof stub>, now = new Date('2026-11-22T10:00:00Z')) =>
  createEsefProvider({ db, fetch: s.fetcher, indexUrl: 'https://index.fixture', gleifUrl: 'https://gleif.fixture', now: () => now });

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('ESEF filings on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);

  it('ingests a real index entry by ISIN, falls back to the date added, and repeats without change', async () => {
    const s = stub();
    const provider = make(db, s);
    const first = await provider.sync({ isins: ['DK0015996318'] });
    expect(first).toMatchObject({ leis: 1, filings: 1, inserted: 1, unresolvedIsins: [], noFilings: [], tooLarge: [], availableFromDateAdded: 1 });
    const [filing] = await db.select().from(esefFilings).where(eq(esefFilings.lei, LEI));
    expect(filing).toMatchObject({ fxoId: '549300D2K6PKKKXVNN73-2026-09-30-ESEF-DK-0', country: 'DK', periodEnd: '2026-09-30', availableOn: '2026-11-11', availableSource: 'date_added', publishedAt: null });
    expect(filing?.entityName).toBe('A.P. MØLLER - MÆRSK A/S');
    const [doc] = await db.select().from(esefDocuments).where(eq(esefDocuments.filingId, filing?.id ?? ''));
    expect(doc?.body).toBe(report);
    expect(doc?.sha256).toHaveLength(64);
    expect(await db.select().from(leiIsins).where(eq(leiIsins.lei, LEI))).toHaveLength(10);
    expect(s.calls.filter(c => c.startsWith('gleif.fixture/api/v1/lei-records/')).length).toBe(1);

    const repeat = await provider.sync({ isins: ['DK0015996318'] });
    expect(repeat).toMatchObject({ filings: 1, inserted: 0 });
    expect(await db.select().from(esefFilings).where(eq(esefFilings.lei, LEI))).toHaveLength(1);
    expect(await db.select().from(leiIsins).where(eq(leiIsins.lei, LEI))).toHaveLength(10);
  });

  it('uses the published date when the index has one, and keeps a changed package as a new version', async () => {
    const changed = JSON.parse(indexText);
    changed.data[0].attributes = { ...changed.data[0].attributes, fxo_id: 'FXO-PUBLISHED-1', published: '2026-03-19 08:48:58', sha256: 'a'.repeat(64) };
    const provider = make(db, stub({ index: () => ({ body: JSON.stringify(changed) }) }));
    expect(await provider.sync({ leis: [LEI] })).toMatchObject({ inserted: 1, availableFromDateAdded: 0 });
    const [row] = await db.select().from(esefFilings).where(eq(esefFilings.fxoId, 'FXO-PUBLISHED-1'));
    expect(row).toMatchObject({ availableOn: '2026-03-19', availableSource: 'published' });
    expect(row?.publishedAt?.toISOString()).toBe('2026-03-19T08:48:58.000Z');

    const v2 = JSON.parse(JSON.stringify(changed));
    v2.data[0].attributes.sha256 = 'b'.repeat(64);
    expect(await make(db, stub({ index: () => ({ body: JSON.stringify(v2) }) })).sync({ leis: [LEI] })).toMatchObject({ inserted: 1 });
    expect(await db.select().from(esefFilings).where(eq(esefFilings.fxoId, 'FXO-PUBLISHED-1'))).toHaveLength(2);
  });

  it('reports unresolved ISINs and issuers with no filings, and follows GLEIF pages', async () => {
    const pages: string[] = [];
    const page = (n: number, total: number, isin: string) => JSON.stringify({ data: [{ id: `${LEI}-${n}`, attributes: { lei: LEI, isin } }], meta: { pagination: { currentPage: n, lastPage: total, perPage: 1, total, from: n, to: n } } });
    const s = stub({
      reverse: () => ({ body: JSON.stringify({ data: [], meta: { pagination: { currentPage: 1, lastPage: 1 } } }) }),
      isins: u => { pages.push(u.searchParams.get('page[number]') ?? ''); const n = Number(u.searchParams.get('page[number]')); return { body: page(n, 3, ['DK0000000001', 'DK0000000002', 'DK0000000003'][n - 1] ?? 'DK0000000009') }; },
      index: () => ({ body: JSON.stringify({ data: [], included: [] }) }),
    });
    const report2 = await make(db, s).sync({ isins: ['DK9999999999'], leis: ['ZZ999999999999999999'] });
    expect(report2.unresolvedIsins).toEqual(['DK9999999999']);
    expect(report2.noFilings).toEqual(['ZZ999999999999999999']);
    expect(pages).toEqual(['1', '2', '3']);
    const stored = (await db.select().from(leiIsins).where(eq(leiIsins.lei, 'ZZ999999999999999999'))).map(r => r.isin).sort();
    expect(stored).toEqual(['DK0000000001', 'DK0000000002', 'DK0000000003']);
  });

  it('retries a server error, and skips a report over the size limit', async () => {
    let calls = 0;
    const flaky = stub({ index: () => ++calls === 1 ? { status: 503 } : { body: indexText.replace('549300D2K6PKKKXVNN73-2026-09-30-ESEF-DK-0', 'FXO-RETRY-1') } });
    expect(await make(db, flaky).sync({ leis: [LEI] })).toMatchObject({ inserted: 1 });
    expect(calls).toBe(2);
    const big = stub({ index: () => ({ body: indexText.replace('549300D2K6PKKKXVNN73-2026-09-30-ESEF-DK-0', 'FXO-BIG-1') }), report: () => ({ body: 'x', headers: { 'content-length': String(80 * 1024 * 1024) } }) });
    expect(await make(db, big).sync({ leis: [LEI] })).toMatchObject({ filings: 0, inserted: 0, tooLarge: ['FXO-BIG-1'] });
    await expect(make(db, stub({ index: () => ({ status: 403 }) })).sync({ leis: [LEI] })).rejects.toThrow('ESEF index returned HTTP 403');
    await expect(make(db, stub()).sync({})).rejects.toThrow();
    await expect(make(db, stub()).sync({ leis: ['not-a-lei'] })).rejects.toThrow();
  });

  it('freezes filings in snapshots and filters by availability date', async () => {
    const early = await createSnapshot({ db, ingestedCutoff: new Date() });
    const lateIndex = indexText.replace('549300D2K6PKKKXVNN73-2026-09-30-ESEF-DK-0', 'FXO-LATE-1');
    await make(db, stub({ index: () => ({ body: lateIndex }) }), new Date()).sync({ leis: [LEI] });
    const later = await createSnapshot({ db });
    const ids = async (snapshotId: string, asOf: string) => (await esefFilingsAsOf({ db, snapshotId, asOf, lei: LEI })).map(f => f.fxoId);
    expect(await ids(early.id, '2026-12-31')).not.toContain('FXO-LATE-1');
    expect(await ids(later.id, '2026-12-31')).toContain('FXO-LATE-1');
    expect(await ids(later.id, '2026-11-10')).not.toContain('549300D2K6PKKKXVNN73-2026-09-30-ESEF-DK-0');
    expect(await ids(later.id, '2026-11-11')).toContain('549300D2K6PKKKXVNN73-2026-09-30-ESEF-DK-0');
    await expect(client.unsafe('DELETE FROM snapshot_esef_filings')).rejects.toThrow('append-only');
    expect(later.esefFilings).toBeGreaterThan(early.esefFilings);
  });

  it('finds every resolved security for an issuer, including other share classes', async () => {
    const [a, b] = await db.insert(securities).values([{ shareClassFigi: 'SC-MAERSK-A', name: 'MAERSK A' }, { shareClassFigi: 'SC-MAERSK-B', name: 'MAERSK B' }]).returning({ id: securities.id });
    if (!a || !b) throw new Error('no securities');
    const at = new Date();
    await db.insert(exchangeListings).values([
      { source: 'eodhd', symbol: 'MAERSK-A.CO', exchange: 'CO', name: 'A', type: 'Common Stock', isin: 'DK0010244425', status: 'resolved', securityId: a.id, shareClasses: [], observedAt: at },
      { source: 'eodhd', symbol: 'MAERSK-B.CO', exchange: 'CO', name: 'B', type: 'Common Stock', isin: 'DK0010244508', status: 'resolved', securityId: b.id, shareClasses: [], observedAt: at },
      { source: 'eodhd', symbol: 'AMBIG.CO', exchange: 'CO', name: 'Ambiguous', type: 'Common Stock', isin: 'DK0015996318', status: 'ambiguous', securityId: null, shareClasses: [], observedAt: at },
    ]);
    await db.insert(leiIsins).values({ lei: LEI, isin: 'DK0010244425', source: 'gleif', observedAt: at }).onConflictDoNothing();
    const found = await securityIdsForLeis({ db, leis: [LEI, 'NOSUCHLEI0000000000'] });
    expect([...(found.get(LEI) ?? [])].sort()).toEqual([a.id, b.id].sort());
    expect(found.has('NOSUCHLEI0000000000')).toBe(false);
  });
});
