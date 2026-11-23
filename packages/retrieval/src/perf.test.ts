import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, figiMappings, secFilings, secListings, secSourceDocuments, securities } from '@open-foresight/db';
import { filterByRelevance, type RelevanceJudge } from './relevance.js';
import { search } from './search.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = url ? describe : describe.skip;

enabled('retrieval performance', () => {
  it('answers 100 searches over a 10,000 chunk index inside the ceiling, and ranks vectors exactly', async () => {
    const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
    const db = drizzle(client);
    const tag = Math.random().toString(36).slice(2, 8);
    const stamp = new Date('2024-01-01T00:00:00Z');
    const targetCik = '0000990000';
    const [source] = await db.insert(secSourceDocuments).values({ url: `perf/${tag}`, transportUrl: `perf/${tag}`, sha256: tag, body: '', fetchedAt: stamp }).returning({ id: secSourceDocuments.id });
    const [filing] = await db.insert(secFilings).values({ cik: targetCik, accession: `${tag}-P`, form: '10-K', filedAt: '2024-01-01', primaryDocument: 'd', submissionSourceId: source!.id, documentSourceId: source!.id, ingestedAt: stamp }).returning({ id: secFilings.id });
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-perf-${tag}`, name: 'Perf Inc' }).returning({ id: securities.id });
    const [listing] = await db.insert(secListings).values({ cik: targetCik, ticker: `P${tag}`, exchange: 'Nasdaq', name: 'Perf', observedAt: stamp }).returning({ id: secListings.id });
    await db.insert(figiMappings).values({ listingId: listing!.id, securityId: security!.id, candidates: [], observedAt: stamp });
    const snapshot = await createSnapshot({ db });
    const version = `perf-${tag}`;

    // Ten issuers with 1,000 chunks each, built from 50 clusters of 1536 dimension vectors. One issuer is the target.
    const buildStart = performance.now();
    await client`select setseed(0.5)`;
    await client`create temp table perf_centers as select c as k, (select array_agg(random()::float4 - 0.5) from generate_series(1, 1536) x where c >= 0) as v from generate_series(0, 49) c`;
    await client.unsafe(`insert into document_chunks (doc_kind, doc_id, issuer_key, available_on, section, ordinal, start_offset, end_offset, text, embedding, index_version)
      select 'sec_filing', case when g % 10 = 0 then '${filing!.id}'::uuid else md5('${tag}' || (g % 10)::text)::uuid end,
        'cik:' || case when g % 10 = 0 then '${targetCik}' else '99' || lpad((g % 10)::text, 8, '0') end,
        date '2024-01-01' + (g % 300), 'perf', g, 0, 100,
        (select string_agg('w' || floor(random() * 400)::int, ' ') from generate_series(1, 30) y where g >= 0),
        (select array_agg(c.v + 0.2 * (random()::float4 - 0.5) order by c.i) from perf_centers p, unnest(p.v) with ordinality c(v, i) where p.k = g % 50)::vector(1536),
        '${version}'
      from generate_series(1, 10000) g`);
    const buildMs = performance.now() - buildStart;
    await client`analyze document_chunks`;
    const [{ count }] = await client`select count(*)::int as count from document_chunks where index_version = ${version}`;
    expect(count).toBe(10000);

    const sample = await client`select embedding::text as e from document_chunks where index_version = ${version} and issuer_key = ${`cik:${targetCik}`} order by id limit 100`;
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
    const queries = sample.map(r => (JSON.parse(r.e as string) as number[]).map(x => x + 0.05 * rnd()));
    const words = (i: number) => `w${(i * 7) % 400} w${(i * 13) % 400} w${(i * 29) % 400}`;

    const timings: number[] = [];
    let empty = 0;
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      const hits = await search({ db, snapshotId: snapshot.id, asOf: '2024-12-31', securityId: security!.id, query: words(i), queryEmbedding: queries[i], indexVersion: version, limit: 10, candidates: 50 });
      timings.push(performance.now() - t);
      if (hits.length === 0) empty++;
      expect(hits.every(h => h.issuerKey === `cik:${targetCik}`)).toBe(true);
    }
    const total = performance.now() - start;
    timings.sort((a, b) => a - b);

    // Independent oracle: rank the target issuer's chunks by cosine similarity in JavaScript and compare the vector ranking.
    const eligible = await client`select id, embedding::text as e from document_chunks where index_version = ${version} and issuer_key = ${`cik:${targetCik}`} and available_on <= date '2024-12-31'`;
    const vectors = eligible.map(r => ({ id: r.id as string, v: JSON.parse(r.e as string) as number[] }));
    const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    let mismatches = 0;
    for (let i = 0; i < 20; i++) {
      const q = queries[i]!, qn = norm(q);
      const expected = vectors.map(({ id, v }) => ({ id, d: 1 - v.reduce((a, x, j) => a + x * q[j]!, 0) / (norm(v) * qn) })).sort((a, b) => a.d - b.d || a.id.localeCompare(b.id)).slice(0, 10).map(x => x.id);
      const vectorOnly = await search({ db, snapshotId: snapshot.id, asOf: '2024-12-31', securityId: security!.id, query: '??', queryEmbedding: q, indexVersion: version, limit: 10, candidates: 50 });
      if (JSON.stringify(vectorOnly.map(h => h.chunkId)) !== JSON.stringify(expected)) mismatches++;
    }
    process.stdout.write(`${JSON.stringify({ perf: '100 searches over 10,000 chunks (1,000 eligible per security)', totalMs: Math.round(total), medianMs: Math.round(timings[50] ?? 0), p95Ms: Math.round(timings[95] ?? 0), buildMs: Math.round(buildMs), vectorRankingMismatchesOf20: mismatches, emptyResults: empty })}\n`);

    // The Jev relevance path on the same queries: 20 candidates, then the filter. Each query runs both paths, and which runs first alternates, so cache warmth and drift favour neither.
    // The recorded judge answers at once and keeps about half the passages, so this times the filter's own work and excludes provider latency.
    const judge: RelevanceJudge = { async decide(input) { return { id: 'perf', answers: Object.fromEntries(input.inputEvidenceIds.map((id, i) => [`relevant_p${i + 1}`, { type: 'noul' as const, noul: id.charCodeAt(0) % 2 ? 0.9 : 0.1 }])) }; } };
    const scope = { judge, runId: '00000000-0000-0000-0000-000000000000', asOf: '2024-12-31', company: 'Perf Inc', issuerKeys: [`cik:${targetCik}`] };
    const plain: number[] = [], filtered: number[] = [];
    let kept = 0, judged = 0;
    for (let i = 0; i < 100; i++) {
      const input = { db, snapshotId: snapshot.id, asOf: '2024-12-31', securityId: security!.id, query: words(i), queryEmbedding: queries[i], indexVersion: version, candidates: 50 };
      const timePlain = async () => { const t = performance.now(); await search({ ...input, limit: 10 }); plain.push(performance.now() - t); };
      const timeFiltered = async () => {
        const t = performance.now();
        const r = await filterByRelevance(scope, words(i), await search({ ...input, limit: 20 }));
        filtered.push(performance.now() - t);
        expect(r.failure).toBeUndefined();
        kept += r.hits.length; judged += Object.keys(r.probabilities).length;
      };
      if (i % 2) { await timePlain(); await timeFiltered(); } else { await timeFiltered(); await timePlain(); }
    }
    const filteredTotal = filtered.reduce((a, b) => a + b, 0);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[50]!;
    process.stdout.write(`${JSON.stringify({ perf: '100 searches through the relevance filter, alternating with plain search', filteredTotalMs: Math.round(filteredTotal), filteredMedianMs: +median(filtered).toFixed(2), plainMedianMs: +median(plain).toFixed(2), judged, kept })}\n`);
    await client.end();
    expect(empty).toBe(0);
    expect(mismatches).toBe(0);
    expect(total).toBeLessThan(60_000);
    expect(judged).toBe(2000);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(judged);
    expect(filteredTotal).toBeLessThan(60_000);
    expect(median(filtered)).toBeLessThan(1.25 * median(plain));
  }, 900_000);
});
