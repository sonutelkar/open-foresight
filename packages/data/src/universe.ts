import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { factsAsOf, pricesAsOf } from '@open-foresight/db';
import { deriveMetrics, exchangeOf, screenUniverse, type Decision, type UniverseRules } from '@open-foresight/core';

export type UniverseListing = { symbol: string; cik?: string };

/**
 * Screens listings as of a date against a frozen snapshot.
 * Prices come from price_bars. US shares outstanding come from the SEC `dei` fact filed most recently on or before `asOf`.
 * Names without shares have no market cap and are excluded with that reason.
 */
export async function buildUniverse(input: { db: PostgresJsDatabase; snapshotId: string; asOf: string; listings: UniverseListing[]; rules: UniverseRules }): Promise<Decision[]> {
  const { db, snapshotId, asOf, rules } = input;
  const lookback = Math.max(rules.advWindow * 2 + 14, rules.maxStaleDays + 1);
  const bars = await pricesAsOf({ db, snapshotId, asOf, symbols: input.listings.map(l => l.symbol), lookbackDays: lookback });
  const bySymbol = new Map<string, Array<{ date: string; close: number; volume: number | null }>>();
  for (const bar of bars) {
    const list = bySymbol.get(bar.symbol) ?? [];
    list.push({ date: bar.date, close: Number(bar.close), volume: bar.volume === null ? null : Number(bar.volume) });
    bySymbol.set(bar.symbol, list);
  }
  const shares = new Map<string, { periodEnd: string; filedAt: string; value: number }>();
  const ciks = [...new Set(input.listings.flatMap(l => l.cik ? [l.cik] : []))];
  if (ciks.length) for (const f of await factsAsOf({ db, snapshotId, asOf, ciks, taxonomy: 'dei', concept: 'EntityCommonStockSharesOutstanding' })) {
    if (f.unit !== 'shares') continue;
    const best = shares.get(f.cik);
    if (!best || f.periodEnd > best.periodEnd || (f.periodEnd === best.periodEnd && f.filedAt > best.filedAt)) shares.set(f.cik, { periodEnd: f.periodEnd, filedAt: f.filedAt, value: Number(f.value) });
  }
  const candidates = input.listings.map(l => ({
    symbol: l.symbol,
    ...deriveMetrics({ bars: bySymbol.get(l.symbol) ?? [], asOf, quoteScale: exchangeOf(l.symbol)?.quoteScale ?? 1, sharesOutstanding: l.cik ? shares.get(l.cik)?.value ?? null : null, advWindow: rules.advWindow, minAdvBars: rules.minAdvBars }),
  }));
  return screenUniverse(candidates, rules, asOf);
}
