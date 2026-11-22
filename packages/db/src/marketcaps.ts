import { and, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { dataSnapshots, marketCapObservations } from './schema.js';

export type MarketCapRow = { symbol: string; marketCap: number | null; sharesOutstanding: number | null; observedAt: Date };

/**
 * The latest market cap or share count observed on or before `asOf` and at most `maxAgeDays` earlier, as the snapshot saw it.
 * An observation is a snapshot of its own day. It never applies to an earlier date.
 */
export async function marketCapsAsOf(input: { db: PostgresJsDatabase; snapshotId: string; asOf: string; symbols: string[]; maxAgeDays: number }): Promise<MarketCapRow[]> {
  const end = new Date(`${input.asOf}T00:00:00Z`);
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== input.asOf) throw new Error('asOf must be a valid YYYY-MM-DD date');
  if (input.symbols.length === 0) return [];
  const upper = new Date(end.getTime() + 86_400_000);
  const lower = new Date(end.getTime() - input.maxAgeDays * 86_400_000);
  const [snapshot] = await input.db.select({ cutoff: dataSnapshots.ingestedCutoff }).from(dataSnapshots).where(eq(dataSnapshots.id, input.snapshotId));
  if (!snapshot) throw new Error('Unknown snapshot');
  const rows = await input.db.selectDistinctOn([marketCapObservations.symbol], { symbol: marketCapObservations.symbol, marketCap: marketCapObservations.marketCap, sharesOutstanding: marketCapObservations.sharesOutstanding, observedAt: marketCapObservations.observedAt })
    .from(marketCapObservations)
    .where(and(inArray(marketCapObservations.symbol, input.symbols), gte(marketCapObservations.observedAt, lower), lt(marketCapObservations.observedAt, upper), lte(marketCapObservations.observedAt, snapshot.cutoff)))
    .orderBy(marketCapObservations.symbol, sql`${marketCapObservations.observedAt} desc`, sql`${marketCapObservations.id} desc`);
  return rows.map(r => ({ symbol: r.symbol, marketCap: r.marketCap === null ? null : Number(r.marketCap), sharesOutstanding: r.sharesOutstanding === null ? null : Number(r.sharesOutstanding), observedAt: r.observedAt }));
}
