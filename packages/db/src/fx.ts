import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { dataSnapshots, fxRates } from './schema.js';

export type FxRateRow = { currency: string; date: string; perEur: number };

/**
 * The most recent rate on or before `asOf` for each currency, within `maxStaleDays`, as the snapshot saw it.
 * Only versions ingested at or before the snapshot cutoff count. EUR itself is not stored.
 */
export async function fxRatesAsOf(input: { db: PostgresJsDatabase; snapshotId: string; asOf: string; currencies: string[]; maxStaleDays: number }): Promise<FxRateRow[]> {
  const asOfDate = new Date(`${input.asOf}T00:00:00Z`);
  if (Number.isNaN(asOfDate.getTime()) || asOfDate.toISOString().slice(0, 10) !== input.asOf) throw new Error('asOf must be a valid YYYY-MM-DD date');
  const currencies = input.currencies.filter(c => c !== 'EUR');
  if (currencies.length === 0) return [];
  asOfDate.setUTCDate(asOfDate.getUTCDate() - input.maxStaleDays - 1);
  const from = asOfDate.toISOString().slice(0, 10);
  const [snapshot] = await input.db.select({ cutoff: dataSnapshots.ingestedCutoff }).from(dataSnapshots).where(eq(dataSnapshots.id, input.snapshotId));
  if (!snapshot) throw new Error('Unknown snapshot');
  const rows = await input.db.selectDistinctOn([fxRates.currency, fxRates.date], { currency: fxRates.currency, date: fxRates.date, perEur: fxRates.perEur })
    .from(fxRates)
    .where(and(inArray(fxRates.currency, currencies), gt(fxRates.date, from), lte(fxRates.date, input.asOf), lte(fxRates.ingestedAt, snapshot.cutoff)))
    .orderBy(fxRates.currency, fxRates.date, sql`${fxRates.ingestedAt} desc`, sql`${fxRates.id} desc`);
  const latest = new Map<string, FxRateRow>();
  for (const row of rows) latest.set(row.currency, { currency: row.currency, date: row.date, perEur: Number(row.perEur) });
  return [...latest.values()];
}
