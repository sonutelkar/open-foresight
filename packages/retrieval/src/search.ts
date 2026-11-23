import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Embedder } from '@open-foresight/llm';
import { reciprocalRankFusion } from './fusion.js';
import { indexVersionFor, type DocKind } from './indexer.js';
import { issuerKeysForSecurity } from './issuers.js';
import { orTsQuery } from './query.js';

export type Hit = {
  chunkId: string; docKind: DocKind; docId: string; issuerKey: string; section: string;
  startOffset: number; endOffset: number; text: string; availableOn: string;
  score: number; ranks: { text: number | null; vector: number | null };
};
export type SearchInput = {
  db: PostgresJsDatabase; snapshotId: string; asOf: string; securityId: string; query: string;
  /** Without a vector only full-text results are returned. */
  queryEmbedding?: number[]; indexVersion: string; limit?: number; candidates?: number;
  /** Only passages available on or after this date, for a lookback window. */
  since?: string;
  /** Only these kinds of document. */
  docKinds?: DocKind[];
};

type Row = { id: string; doc_kind: DocKind; doc_id: string; issuer_key: string; section: string; start_offset: number; end_offset: number; text: string; available_on: string };
const columns = sql`dc.id, dc.doc_kind, dc.doc_id, dc.issuer_key, dc.section, dc.start_offset, dc.end_offset, dc.text, dc.available_on::text as available_on`;

/**
 * Hybrid search over one security's evidence. A chunk is eligible only when its issuer belongs to the security,
 * its document is a member of the snapshot, it was available on or before `asOf`, and it has the given index version.
 * Full-text and vector results are combined by reciprocal rank fusion. The vector ranking is exact, with ties broken by id.
 */
export async function search(input: SearchInput): Promise<Hit[]> {
  const limit = input.limit ?? 10;
  const candidates = input.candidates ?? 50;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf) || Number.isNaN(Date.parse(`${input.asOf}T00:00:00Z`))) throw new Error('asOf must be a valid YYYY-MM-DD date');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(candidates) || candidates < limit || candidates > 500) throw new Error('Invalid search limits');
  if (input.queryEmbedding && input.queryEmbedding.length === 0) throw new Error('Empty query embedding');
  if (input.since !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.since) || Number.isNaN(Date.parse(`${input.since}T00:00:00Z`)))) throw new Error('since must be a valid YYYY-MM-DD date');
  if (input.docKinds && input.docKinds.length === 0) return [];
  const keys = await issuerKeysForSecurity(input.db, input.securityId);
  if (keys.length === 0) return [];
  const keyList = sql.join(keys.map(k => sql`${k}`), sql`, `);
  const sinceFilter = input.since ? sql`and dc.available_on >= ${input.since}::date` : sql``;
  const kindFilter = input.docKinds ? sql`and dc.doc_kind in (${sql.join(input.docKinds.map(k => sql`${k}`), sql`, `)})` : sql``;
  const eligible = sql`dc.index_version = ${input.indexVersion} and dc.issuer_key in (${keyList}) and dc.available_on <= ${input.asOf}::date ${sinceFilter} ${kindFilter}
    and ((dc.doc_kind = 'sec_filing' and dc.doc_id in (select filing_id from snapshot_filings where snapshot_id = ${input.snapshotId}::uuid))
      or (dc.doc_kind = 'esef_filing' and dc.doc_id in (select filing_id from snapshot_esef_filings where snapshot_id = ${input.snapshotId}::uuid))
      or (dc.doc_kind in ('web_report', 'company_profile') and dc.doc_id in (select document_id from snapshot_web_documents where snapshot_id = ${input.snapshotId}::uuid)))`;
  const tsquery = orTsQuery(input.query);
  return input.db.transaction(async tx => {
    const rows = new Map<string, Row>();
    const textRows = tsquery
      ? await tx.execute<Row>(sql`select ${columns} from document_chunks dc where ${eligible} and dc.tsv @@ to_tsquery('simple', ${tsquery}) order by ts_rank_cd(dc.tsv, to_tsquery('simple', ${tsquery})) desc, dc.id limit ${candidates}`)
      : [];
    const vectorRows = input.queryEmbedding
      ? await tx.execute<Row>(sql`select ${columns} from document_chunks dc where ${eligible} order by dc.embedding <=> ${`[${input.queryEmbedding.join(',')}]`}::vector, dc.id limit ${candidates}`)
      : [];
    for (const row of [...textRows, ...vectorRows]) rows.set(row.id, row);
    const fused = reciprocalRankFusion([[...textRows].map(r => r.id), [...vectorRows].map(r => r.id)]).slice(0, limit);
    return fused.flatMap(f => {
      const r = rows.get(f.id);
      return r ? [{ chunkId: r.id, docKind: r.doc_kind, docId: r.doc_id, issuerKey: r.issuer_key, section: r.section, startOffset: r.start_offset, endOffset: r.end_offset, text: r.text, availableOn: r.available_on, score: f.score, ranks: { text: f.ranks[0] ?? null, vector: f.ranks[1] ?? null } }] : [];
    });
  });
}

/** Embeds the query with the pinned model, then searches. */
export function createRetriever(options: { db: PostgresJsDatabase; embedder: Embedder }) {
  const indexVersion = indexVersionFor(options.embedder);
  return {
    indexVersion,
    async search(input: Omit<SearchInput, 'db' | 'indexVersion' | 'queryEmbedding'> & { vector?: boolean }): Promise<Hit[]> {
      const { vector, ...rest } = input;
      const embedded = vector === false ? undefined : (await options.embedder.embed([input.query], 'query')).vectors[0];
      return search({ ...rest, db: options.db, indexVersion, queryEmbedding: embedded });
    },
  };
}
