import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { documentChunks, esefDocuments, esefFilings, secFilings, secSourceDocuments, webDocuments } from '@open-foresight/db';
import { EXTRACTOR_VERSION, htmlToText, type DocKind as CoreDocKind, type Heading } from '@open-foresight/core';
import type { Embedder } from '@open-foresight/llm';
import { CHUNKER_VERSION, chunkText } from './chunk.js';

export type DocKind = CoreDocKind;
export type IndexReport = { indexVersion: string; documents: number; chunks: number; tokens: number; costUsd: number; empty: number };

export const indexVersionFor = (embedder: Pick<Embedder, 'model'>) => `${EXTRACTOR_VERSION}:${CHUNKER_VERSION}:${embedder.model}`;

/** A document waiting to be chunked. HTML filings carry their raw body, and web reports carry text that was extracted when they were fetched. */
type Pending = { docKind: DocKind; docId: string; issuerKey: string; availableOn: string; body?: string; extracted?: { text: string; headings: Heading[] } };

async function pending(db: PostgresJsDatabase, version: string, kinds: DocKind[], limit: number, issuerKeys?: string[]): Promise<Pending[]> {
  const out: Pending[] = [];
  const ciks = issuerKeys?.flatMap(k => k.startsWith('cik:') ? [k.slice(4)] : []);
  const leis = issuerKeys?.flatMap(k => k.startsWith('lei:') ? [k.slice(4)] : []);
  if (kinds.includes('sec_filing') && (!ciks || ciks.length > 0)) {
    const rows = await db.select({ id: secFilings.id, cik: secFilings.cik, filedAt: secFilings.filedAt, body: secSourceDocuments.body })
      .from(secFilings).innerJoin(secSourceDocuments, eq(secSourceDocuments.id, secFilings.documentSourceId))
      .leftJoin(documentChunks, and(eq(documentChunks.docKind, 'sec_filing'), eq(documentChunks.docId, secFilings.id), eq(documentChunks.indexVersion, version), eq(documentChunks.ordinal, 0)))
      .where(and(isNull(documentChunks.id), ciks ? inArray(secFilings.cik, ciks) : undefined)).limit(limit);
    out.push(...rows.map(r => ({ docKind: 'sec_filing' as const, docId: r.id, issuerKey: `cik:${r.cik}`, availableOn: r.filedAt, body: r.body })));
  }
  if (kinds.includes('esef_filing') && out.length < limit && (!leis || leis.length > 0)) {
    const rows = await db.select({ id: esefFilings.id, lei: esefFilings.lei, availableOn: esefFilings.availableOn, body: esefDocuments.body })
      .from(esefFilings).innerJoin(esefDocuments, eq(esefDocuments.filingId, esefFilings.id))
      .leftJoin(documentChunks, and(eq(documentChunks.docKind, 'esef_filing'), eq(documentChunks.docId, esefFilings.id), eq(documentChunks.indexVersion, version), eq(documentChunks.ordinal, 0)))
      .where(and(isNull(documentChunks.id), leis ? inArray(esefFilings.lei, leis) : undefined)).limit(limit - out.length);
    out.push(...rows.map(r => ({ docKind: 'esef_filing' as const, docId: r.id, issuerKey: `lei:${r.lei}`, availableOn: r.availableOn, body: r.body })));
  }
  if (kinds.includes('web_report') && out.length < limit) {
    const rows = await db.select({ id: webDocuments.id, issuerKey: webDocuments.issuerKey, availableOn: webDocuments.availableOn, text: webDocuments.text, headings: webDocuments.headings })
      .from(webDocuments)
      .leftJoin(documentChunks, and(eq(documentChunks.docKind, 'web_report'), eq(documentChunks.docId, webDocuments.id), eq(documentChunks.indexVersion, version), eq(documentChunks.ordinal, 0)))
      .where(and(isNull(documentChunks.id), issuerKeys ? inArray(webDocuments.issuerKey, issuerKeys) : undefined)).limit(limit - out.length);
    out.push(...rows.map(r => ({ docKind: 'web_report' as const, docId: r.id, issuerKey: r.issuerKey, availableOn: r.availableOn, extracted: { text: r.text, headings: r.headings as Heading[] } })));
  }
  return out;
}

/**
 * Chunks and embeds every filing that has no chunks under the current index version. Repeat calls find nothing to do.
 * Each document is written in one transaction, so a failure leaves no partial document.
 */
export async function indexDocuments(options: { db: PostgresJsDatabase; embedder: Embedder; kinds?: DocKind[]; limit?: number; /** Index only these issuers, such as `cik:0000320193` or `lei:...`. Default is every issuer. */ issuerKeys?: string[] }): Promise<IndexReport> {
  const version = indexVersionFor(options.embedder);
  const docs = await pending(options.db, version, options.kinds ?? ['sec_filing', 'esef_filing', 'web_report'], options.limit ?? 1000, options.issuerKeys);
  const report: IndexReport = { indexVersion: version, documents: 0, chunks: 0, tokens: 0, costUsd: 0, empty: 0 };
  for (const doc of docs) {
    const extracted = doc.extracted ?? htmlToText(doc.body ?? '');
    const chunks = chunkText(extracted);
    if (chunks.length === 0) { report.empty++; continue; }
    const embedded = await options.embedder.embed(chunks.map(c => c.text), `index:${doc.docKind}`);
    await options.db.transaction(async tx => {
      for (let i = 0; i < chunks.length; i += 200) {
        await tx.insert(documentChunks).values(chunks.slice(i, i + 200).map((c, j) => ({
          docKind: doc.docKind, docId: doc.docId, issuerKey: doc.issuerKey, availableOn: doc.availableOn,
          section: c.section, ordinal: c.ordinal, startOffset: c.start, endOffset: c.end, text: c.text,
          embedding: embedded.vectors[i + j] ?? [], indexVersion: version,
        }))).onConflictDoNothing();
      }
    });
    report.documents++; report.chunks += chunks.length; report.tokens += embedded.tokens; report.costUsd += embedded.costUsd;
  }
  return report;
}

/** The text a chunk's offsets point into, extracted the way the indexer extracted it. */
export async function extractedTextFor(db: PostgresJsDatabase, docKind: DocKind, docId: string): Promise<string | undefined> {
  if (docKind === 'sec_filing') {
    const [row] = await db.select({ body: secSourceDocuments.body }).from(secFilings).innerJoin(secSourceDocuments, eq(secSourceDocuments.id, secFilings.documentSourceId)).where(eq(secFilings.id, docId));
    return row ? htmlToText(row.body).text : undefined;
  }
  if (docKind === 'web_report') {
    const [row] = await db.select({ text: webDocuments.text }).from(webDocuments).where(eq(webDocuments.id, docId));
    return row?.text;
  }
  const [row] = await db.select({ body: esefDocuments.body }).from(esefDocuments).where(eq(esefDocuments.filingId, docId));
  return row ? htmlToText(row.body).text : undefined;
}
