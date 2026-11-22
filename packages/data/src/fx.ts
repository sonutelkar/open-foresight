import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { fxRatesAsOf } from '@open-foresight/db';
import { fxToUsd } from '@open-foresight/core';

/**
 * USD per unit of each currency as of a date, from ECB reference rates stored in a snapshot.
 * A rate older than `maxStaleDays` is treated as missing. The ECB publishes on business days only.
 */
export async function fxToUsdAsOf(input: { db: PostgresJsDatabase; snapshotId: string; asOf: string; currencies: string[]; maxStaleDays?: number }): Promise<Record<string, number>> {
  const rows = await fxRatesAsOf({ db: input.db, snapshotId: input.snapshotId, asOf: input.asOf, currencies: [...new Set([...input.currencies, 'USD'])], maxStaleDays: input.maxStaleDays ?? 5 });
  return fxToUsd(Object.fromEntries(rows.map(r => [r.currency, r.perEur])));
}
