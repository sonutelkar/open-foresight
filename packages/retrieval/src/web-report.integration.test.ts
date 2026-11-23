import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createSnapshot, securities, securityIssuers, webDocuments } from '@open-foresight/db';
import { createRetriever, extractedTextFor, indexDocuments } from './index.js';
import { fakeEmbedder } from './test-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const pages = [
  'Page one is the cover. Siemens Annual Report 2025 with a table of contents and a letter from the board.',
  'Page two covers Smart Infrastructure. The segment sells electrical products and grid automation software and reported revenue of 24 billion euros.',
  'Page three covers Mobility and rail signalling, with new orders in the fiscal year and a growing backlog of projects.',
];
const text = pages.join('\n\n');
const headings = pages.map((p, i) => ({ offset: text.indexOf(p), level: 1, title: `Page ${i + 1}` }));
const QUOTE = 'grid automation software and reported revenue of 24 billion euros';

describe.skipIf(!url)('web reports in retrieval on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  const tag = randomUUID().slice(0, 8);
  const issuerKey = `lei:${tag.toUpperCase().padEnd(20, '0')}`;
  const fetchedAt = new Date('2026-11-20T10:00:00Z');

  async function setup() {
    const [security] = await db.insert(securities).values({ shareClassFigi: `SC-${tag}-${randomUUID()}`, name: 'Siemens AG' }).returning({ id: securities.id });
    await db.insert(securityIssuers).values({ securityId: security!.id, issuerKey, note: 'test link' });
    return security!.id;
  }
  const addDoc = async (over: Partial<typeof webDocuments.$inferInsert> = {}) => (await db.insert(webDocuments).values({
    url: `https://example.com/${tag}/${randomUUID()}.pdf`, finalUrl: `https://example.com/${tag}/report.pdf`, contentType: 'application/pdf', byteSize: 1000, rawSha256: randomUUID(),
    text, headings, extractor: 'test', issuerKey, entityName: 'Siemens AG', fetchedAt, availableOn: '2026-11-20', ...over,
  }).returning({ id: webDocuments.id }))[0]!.id;

  it('indexes stored text by page, finds a quote inside its snapshot, and hides it before its first fetch and outside the snapshot', async () => {
    const securityId = await setup();
    const embedder = fakeEmbedder();
    const docId = await addDoc();
    const snapshot = await createSnapshot({ db });
    const report = await indexDocuments({ db, embedder, kinds: ['web_report'], issuerKeys: [issuerKey] });
    expect(report).toMatchObject({ documents: 1 });
    const retriever = createRetriever({ db, embedder });

    const hits = await retriever.search({ snapshotId: snapshot.id, asOf: '2026-11-22', securityId, query: 'grid automation software revenue', docKinds: ['web_report'] });
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find(h => h.text.includes(QUOTE))!;
    expect(hit).toMatchObject({ docKind: 'web_report', docId, issuerKey, availableOn: '2026-11-20', section: 'Page 2' });
    const stored = (await extractedTextFor(db, 'web_report', docId))!;
    expect(stored.slice(hit.startOffset, hit.endOffset)).toBe(hit.text);

    expect(await retriever.search({ snapshotId: snapshot.id, asOf: '2026-11-19', securityId, query: 'grid automation software revenue', docKinds: ['web_report'] })).toEqual([]);
    const laterDoc = await addDoc({ fetchedAt: new Date(), availableOn: new Date().toISOString().slice(0, 10) });
    expect(laterDoc).not.toBe(docId);
    const hitsAfter = await retriever.search({ snapshotId: snapshot.id, asOf: new Date().toISOString().slice(0, 10), securityId, query: 'grid automation software revenue', docKinds: ['web_report'] });
    expect(new Set(hitsAfter.map(h => h.docId))).toEqual(new Set([docId]));
  });

  it('does not index a web report twice under one index version', async () => {
    await setup();
    await addDoc();
    const embedder = fakeEmbedder();
    const first = await indexDocuments({ db, embedder, kinds: ['web_report'], issuerKeys: [issuerKey] });
    const second = await indexDocuments({ db, embedder, kinds: ['web_report'], issuerKeys: [issuerKey] });
    expect(first.documents).toBeGreaterThan(0);
    expect(second.documents).toBe(0);
  });
});
