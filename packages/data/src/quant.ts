import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { exchangeOf, quantCatalog, type QuantId } from '@open-foresight/core';
import { factsAsOf, pricesAsOf } from '@open-foresight/db';
import { fxToUsdAsOf } from './fx.js';
import { buildUniverse } from './universe.js';

/** A stored input a quant value was computed from, so the number can be traced back to a fact or a price bar. */
export type QuantInput =
  | { kind: 'fact'; factId: string; concept: string; value: number; periodStart: string | null; periodEnd: string; filedAt: string; accession: string; sourcePointer: string }
  | { kind: 'price'; symbol: string; date: string; close: number; adjustedClose: number | null }
  | { kind: 'derived'; name: string; value: number | string };
export type QuantResult = { quantId: QuantId; value: number | null; inputs: QuantInput[]; note: string | null };

const revenueConcepts = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet'];
const numerators: Partial<Record<QuantId, string[]>> = {
  rd_intensity: ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'],
  capex_intensity: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  gross_margin: ['GrossProfit'],
};
const dayMs = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);
const shiftDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

type FactRow = Awaited<ReturnType<typeof factsAsOf>>[number];
const asInput = (f: FactRow): QuantInput => ({ kind: 'fact', factId: f.id, concept: f.concept, value: Number(f.value), periodStart: f.periodStart, periodEnd: f.periodEnd, filedAt: f.filedAt, accession: f.accession, sourcePointer: f.sourcePointer });

/** Annual USD facts, one per fiscal period end, taking the first concept in priority order that has a value for that period. */
function annualByPeriod(rows: FactRow[], concepts: string[]): Map<string, FactRow> {
  const out = new Map<string, FactRow>();
  for (const concept of concepts) {
    for (const f of rows) {
      if (f.concept !== concept || f.unit !== 'USD' || !f.periodStart) continue;
      const length = days(f.periodStart, f.periodEnd);
      if (length < 350 || length > 380 || out.has(f.periodEnd)) continue;
      out.set(f.periodEnd, f);
    }
  }
  return out;
}

async function financial(options: { db: PostgresJsDatabase; snapshotId: string; asOf: string; quantId: QuantId; ciks: string[] }): Promise<QuantResult> {
  const { quantId } = options;
  const wanted = [...revenueConcepts, ...(numerators[quantId] ?? [])];
  for (const cik of options.ciks) {
    const rows = await factsAsOf({ db: options.db, snapshotId: options.snapshotId, asOf: options.asOf, cik, taxonomy: 'us-gaap', concepts: wanted });
    const revenue = annualByPeriod(rows, revenueConcepts);
    if (revenue.size === 0) continue;
    if (quantId === 'revenue_growth_yoy') {
      const [latestEnd] = [...revenue.keys()].sort().reverse();
      if (!latestEnd) continue;
      const priorEnd = [...revenue.keys()].find(end => Math.abs(days(end, shiftDays(latestEnd, -365))) <= 15);
      const latest = revenue.get(latestEnd), prior = priorEnd ? revenue.get(priorEnd) : undefined;
      if (!latest || !prior || Number(prior.value) <= 0) return { quantId, value: null, inputs: latest ? [asInput(latest)] : [], note: 'No annual revenue for the prior year' };
      return { quantId, value: Number(latest.value) / Number(prior.value) - 1, inputs: [asInput(latest), asInput(prior)], note: null };
    }
    const top = annualByPeriod(rows, numerators[quantId] ?? []);
    const period = [...top.keys()].filter(end => revenue.has(end)).sort().reverse()[0];
    const numerator = period ? top.get(period) : undefined, denominator = period ? revenue.get(period) : undefined;
    if (!numerator || !denominator) return { quantId, value: null, inputs: [], note: `No annual ${(numerators[quantId] ?? []).join(' or ')} alongside revenue` };
    if (Number(denominator.value) <= 0) return { quantId, value: null, inputs: [asInput(numerator), asInput(denominator)], note: 'Revenue is not positive' };
    return { quantId, value: Number(numerator.value) / Number(denominator.value), inputs: [asInput(numerator), asInput(denominator)], note: null };
  }
  return { quantId, value: null, inputs: [], note: 'No annual SEC facts for this security, so it has no value (US filers only)' };
}

/**
 * Computes one registered quant function for a security as of a date, from the local store only.
 * The result has the value, or null with a note, and the stored inputs it came from.
 * `ciks` are the security's SEC filers. Financial functions read annual US GAAP facts filed on or before the as-of date.
 */
export async function computeQuant(options: { db: PostgresJsDatabase; snapshotId: string; asOf: string; quantId: QuantId; symbol: string; ciks: string[] }): Promise<QuantResult> {
  const { db, snapshotId, asOf, quantId, symbol } = options;
  if (!(quantId in quantCatalog)) throw new Error(`Unknown quant function: ${quantId}`);
  const group = quantCatalog[quantId].group;
  if (group === 'financial') return financial({ db, snapshotId, asOf, quantId, ciks: options.ciks });
  const exchange = exchangeOf(symbol);
  if (!exchange) return { quantId, value: null, inputs: [], note: `Unsupported exchange for ${symbol}` };
  if (quantId === 'price_return_12m') {
    const bars = await pricesAsOf({ db, snapshotId, asOf, symbols: [symbol], lookbackDays: 400 });
    const priced = bars.map(b => ({ date: b.date, close: Number(b.close), adjusted: b.adjustedClose === null ? null : Number(b.adjustedClose) })).sort((a, b) => a.date.localeCompare(b.date));
    const end = priced.at(-1);
    const target = shiftDays(asOf, -365);
    const start = [...priced].reverse().find(b => b.date <= target);
    if (!end || days(end.date, asOf) > 7) return { quantId, value: null, inputs: [], note: 'No recent price' };
    if (!start || days(start.date, target) > 10) return { quantId, value: null, inputs: [{ kind: 'price', symbol, date: end.date, close: end.close, adjustedClose: end.adjusted }], note: 'No price near one year earlier' };
    const price = (b: typeof end) => b.adjusted ?? b.close;
    return { quantId, value: price(end) / price(start) - 1, inputs: [{ kind: 'price', symbol, date: start.date, close: start.close, adjustedClose: start.adjusted }, { kind: 'price', symbol, date: end.date, close: end.close, adjustedClose: end.adjusted }], note: null };
  }
  const fx = exchange.currency === 'USD' ? { USD: 1 } : await fxToUsdAsOf({ db, snapshotId, asOf, currencies: [exchange.currency, 'USD'] });
  const [decision] = await buildUniverse({
    db, snapshotId, asOf, listings: [{ symbol, cik: options.ciks[0] }],
    rules: { regions: ['US', 'EU', 'UK', 'CH'], minMarketCapUsd: 0, minAdvUsd: 0, maxStaleDays: 10, advWindow: 20, minAdvBars: 10, fxToUsd: fx, excluded: {} },
  });
  const value = quantId === 'market_cap_usd' ? decision?.marketCapUsd : decision?.advUsd;
  const inputs: QuantInput[] = quantId === 'market_cap_usd' && decision?.marketCapSource ? [{ kind: 'derived', name: 'market_cap_source', value: decision.marketCapSource }] : [];
  if (decision?.lastBarDate) inputs.push({ kind: 'derived', name: 'last_price_date', value: decision.lastBarDate });
  return { quantId, value: value ?? null, inputs, note: value == null ? `No ${quantId} for ${symbol}: ${decision?.reasons.join(', ') || 'no data'}` : null };
}
