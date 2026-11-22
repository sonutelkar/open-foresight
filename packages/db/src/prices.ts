import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { dataSnapshots, priceBars } from './schema.js';

export type PriceBarRow = { symbol: string; date: string; close: string; adjustedClose: string | null; volume: string | null };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new Error('asOf must be a valid YYYY-MM-DD date');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Bars dated within `lookbackDays` before `asOf` (inclusive), as the snapshot saw them.
 * Only bar versions ingested at or before the snapshot cutoff count, and the latest such version of each day wins.
 */
export async function pricesAsOf(input: { db: PostgresJsDatabase; snapshotId: string; asOf: string; symbols: string[]; lookbackDays: number }): Promise<PriceBarRow[]> {
  if (input.symbols.length === 0) return [];
  const from = addDays(input.asOf, -input.lookbackDays);
  const [snapshot] = await input.db.select({ cutoff: dataSnapshots.ingestedCutoff }).from(dataSnapshots).where(eq(dataSnapshots.id, input.snapshotId));
  if (!snapshot) throw new Error('Unknown snapshot');
  return input.db.selectDistinctOn([priceBars.symbol, priceBars.date], { symbol: priceBars.symbol, date: priceBars.date, close: priceBars.close, adjustedClose: priceBars.adjustedClose, volume: priceBars.volume })
    .from(priceBars)
    .where(and(inArray(priceBars.symbol, input.symbols), gt(priceBars.date, from), lte(priceBars.date, input.asOf), lte(priceBars.ingestedAt, snapshot.cutoff)))
    .orderBy(priceBars.symbol, priceBars.date, sql`${priceBars.ingestedAt} desc`, sql`${priceBars.id} desc`);
}
