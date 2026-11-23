import type { Region } from './universe.js';

/** Evidence and data sources a KPI may name. A source is usable only when it is enabled for the run. */
export const sourceCatalog = {
  sec_filings: { kind: 'text', regions: ['US'], description: 'SEC 10-K and 10-Q text for US filers, searched as cited passages.' },
  esef_filings: { kind: 'text', regions: ['EU', 'UK'], description: 'Annual and interim report text for issuers outside the US. ESEF reports for FR, NL, GB, ES, IT, SE and DK, and reports fetched from company sites for issuers the ESEF index lacks, such as German and Swiss ones.' },
  sec_facts: { kind: 'quant', regions: ['US'], description: 'SEC XBRL company facts such as revenue, R&D and capex for US filers, with filing dates.' },
  prices: { kind: 'quant', regions: ['US', 'EU', 'UK', 'CH'], description: 'Daily closing prices and volume from EODHD. Needs an EODHD key.' },
  market_cap: { kind: 'quant', regions: ['US', 'EU', 'UK', 'CH'], description: 'Market capitalisation from filing share counts, or from a recent observed value for non-US names.' },
} as const satisfies Record<string, { kind: 'text' | 'quant'; regions: readonly Region[]; description: string }>;
export type SourceId = keyof typeof sourceCatalog;
export const sourceIds = Object.keys(sourceCatalog) as SourceId[];

/** Sources enabled for a run. `prices` needs the optional EODHD adapter. */
export function enabledSources(options: { eodhd: boolean }): SourceId[] {
  return sourceIds.filter(id => id !== 'prices' || options.eodhd);
}

/**
 * Quant functions a `quant` KPI may name. This is the contract for the Analyst ticket, which implements each one.
 * A function reads only the listed sources and returns one number per security.
 * `market` functions measure size, liquidity or momentum. They describe a stock, not its exposure to a theme, so a framework may give them little weight.
 */
export const quantCatalog = {
  market_cap_usd: { group: 'market', sources: ['market_cap'], description: 'Market capitalisation in US dollars. A market factor, not theme exposure.' },
  adv_usd_20d: { group: 'market', sources: ['prices'], description: 'Average daily traded value over 20 trading days, in US dollars. A market factor, not theme exposure.' },
  price_return_12m: { group: 'market', sources: ['prices'], description: 'Total price return over the 12 months to the as-of date, as a fraction. A market factor, not theme exposure.' },
  revenue_growth_yoy: { group: 'financial', sources: ['sec_facts'], description: 'Year on year revenue growth from the latest annual filing, as a fraction. US filers only.' },
  rd_intensity: { group: 'financial', sources: ['sec_facts'], description: 'Research and development expense divided by revenue, as a fraction. US filers only.' },
  capex_intensity: { group: 'financial', sources: ['sec_facts'], description: 'Capital expenditure divided by revenue, as a fraction. US filers only.' },
  gross_margin: { group: 'financial', sources: ['sec_facts'], description: 'Gross profit divided by revenue, as a fraction. US filers only.' },
} as const satisfies Record<string, { group: 'market' | 'financial'; sources: readonly SourceId[]; description: string }>;
export type QuantId = keyof typeof quantCatalog;
export const quantIds = Object.keys(quantCatalog) as QuantId[];
