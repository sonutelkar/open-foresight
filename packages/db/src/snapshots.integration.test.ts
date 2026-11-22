import { afterAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, factsAsOf, filingsAsOf } from './snapshots.js';
import { secFacts, secFilings, secSourceDocuments, snapshotFacts } from './schema.js';

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('point-in-time snapshots', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 1 });
  const db = drizzle(client);
  afterAll(async () => { await client.end(); });

  const t = (iso: string) => new Date(iso);
  async function source(tag: string) {
    const [row] = await db.insert(secSourceDocuments).values({ url: `u/${tag}`, transportUrl: `u/${tag}`, sha256: tag, body: tag, fetchedAt: t('2024-01-01T00:00:00Z') }).returning({ id: secSourceDocuments.id });
    if (!row) throw new Error('no source');
    return row.id;
  }
  async function filing(cik: string, accession: string, filedAt: string, ingestedAt: string, sourceId: string) {
    const [row] = await db.insert(secFilings).values({ cik, accession, form: '10-K', filedAt, primaryDocument: 'd.htm', submissionSourceId: sourceId, documentSourceId: sourceId, ingestedAt: t(ingestedAt) }).returning({ id: secFilings.id });
    if (!row) throw new Error('no filing');
    return row.id;
  }
  async function fact(cik: string, accession: string, filedAt: string, value: string, ingestedAt: string, sourceId: string) {
    const [row] = await db.insert(secFacts).values({ key: `${cik}/${accession}/${value}`, cik, accession, taxonomy: 'us-gaap', concept: 'Revenues', unit: 'USD', value, periodStart: '2023-01-01', periodEnd: '2023-12-31', filedAt, form: '10-K', raw: {}, sourceId, sourcePointer: '/p', ingestedAt: t(ingestedAt) }).returning({ id: secFacts.id });
    if (!row) throw new Error('no fact');
    return row.id;
  }

  it('freezes membership and returns exact as-of records', async () => {
    const cik = String(900000000 + Math.floor(Math.random() * 99999999)).padStart(10, '0');
    const src = await source(cik);
    const original = await filing(cik, '0000000001-24-000001', '2024-02-01', '2024-02-02T00:00:00Z', src);
    const amended = await filing(cik, '0000000001-24-000002', '2024-06-01', '2024-06-02T00:00:00Z', src);
    const future = await filing(cik, '0000000001-24-000003', '2999-01-01', '2024-06-03T00:00:00Z', src);
    const factOriginal = await fact(cik, '0000000001-24-000001', '2024-02-01', '100', '2024-02-02T00:00:00Z', src);
    const factRestated = await fact(cik, '0000000001-24-000002', '2024-06-01', '110', '2024-06-02T00:00:00Z', src);

    const snapshot = await createSnapshot({ db, ingestedCutoff: t('2024-07-01T00:00:00Z') });
    expect(snapshot.filings).toBeGreaterThanOrEqual(3);

    // Late arrival: old filing date, ingested after the snapshot cutoff. Not a member.
    const late = await filing(cik, '0000000001-24-000004', '2024-03-01', '2024-08-01T00:00:00Z', src);
    const lateFact = await fact(cik, '0000000001-24-000004', '2024-03-01', '105', '2024-08-01T00:00:00Z', src);

    const ids = async (asOf: string) => ({
      filings: (await filingsAsOf({ db, snapshotId: snapshot.id, asOf, cik })).map(r => r.id),
      facts: (await factsAsOf({ db, snapshotId: snapshot.id, asOf, cik })).map(r => r.id),
    });
    expect(await ids('2024-01-31')).toEqual({ filings: [], facts: [] });
    expect(await ids('2024-02-01')).toEqual({ filings: [original], facts: [factOriginal] }); // boundary day included
    expect(await ids('2024-05-31')).toEqual({ filings: [original], facts: [factOriginal] });
    expect(await ids('2024-06-01')).toEqual({ filings: [original, amended], facts: [factRestated] });
    expect(await ids('2999-12-31')).toEqual({ filings: [original, amended, future], facts: [factRestated] });
    for (const asOf of ['2024-06-30', '2024-12-31']) {
      const got = await ids(asOf);
      expect(got.filings).not.toContain(late);
      expect(got.facts).not.toContain(lateFact);
      expect(got.filings).not.toContain(future);
    }

    const later = await createSnapshot({ db });
    expect((await filingsAsOf({ db, snapshotId: later.id, asOf: '2024-06-30', cik })).map(r => r.id)).toEqual([original, late, amended]);
    expect((await factsAsOf({ db, snapshotId: later.id, asOf: '2024-06-30', cik })).map(r => r.id)).toEqual([factRestated]);
    expect((await factsAsOf({ db, snapshotId: later.id, asOf: '2024-03-15', cik })).map(r => r.id)).toEqual([lateFact]);

    await expect(client.unsafe('DELETE FROM snapshot_facts')).rejects.toThrow('append-only');
    await expect(db.update(snapshotFacts).set({ factId: factOriginal })).rejects.toThrow();
    await expect(filingsAsOf({ db, snapshotId: snapshot.id, asOf: '2024-02-30', cik })).rejects.toThrow('asOf');
    await expect(createSnapshot({ db, ingestedCutoff: t('2999-01-01T00:00:00Z') })).rejects.toThrow('future');
  });

  it('answers 100 as-of queries over 10,000 records inside the ceiling', async () => {
    const cik = String(800000000 + Math.floor(Math.random() * 99999999)).padStart(10, '0');
    const src = await source(`perf-${cik}`);
    await client`INSERT INTO sec_filings (cik, accession, form, filed_at, primary_document, submission_source_id, document_source_id, ingested_at)
      SELECT ${cik}, '0000000002-24-' || lpad(i::text, 6, '0'), '10-K', date '2000-01-01' + (i % 9000), 'd.htm', ${src}, ${src}, timestamptz '2024-01-01'
      FROM generate_series(1, 5000) i`;
    await client`INSERT INTO sec_facts (key, cik, accession, taxonomy, concept, unit, value, period_end, filed_at, form, raw, source_id, source_pointer, ingested_at)
      SELECT ${cik} || '/' || i, ${cik}, '0000000002-24-' || lpad(i::text, 6, '0'), 'us-gaap', 'C' || (i % 500), 'USD', i, date '2000-12-31' + (i % 20), date '2000-01-01' + (i % 9000), '10-K', '{}'::jsonb, ${src}, '/p', timestamptz '2024-01-01'
      FROM generate_series(1, 5000) i`;
    const snapshot = await createSnapshot({ db });
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const asOf = new Date(Date.UTC(2000, 0, 1 + ((i * 89) % 9000))).toISOString().slice(0, 10);
      await filingsAsOf({ db, snapshotId: snapshot.id, asOf, cik });
      await factsAsOf({ db, snapshotId: snapshot.id, asOf, cik });
    }
    const elapsed = performance.now() - start;
    process.stdout.write(`${JSON.stringify({ perf: '100 as-of query pairs over 10,000 records', ms: Math.round(elapsed) })}\n`);
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});
