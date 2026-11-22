export type Region = 'US' | 'EU' | 'UK' | 'CH';
export type Bar = { date: string; close: number; volume: number | null };

type Exchange = { region: Region; currency: string; quoteScale: number };
/** EODHD exchange codes. LSE quotes are in pence, so its prices are scaled by 0.01 into pounds. */
export const exchanges: Readonly<Record<string, Exchange>> = {
  US: { region: 'US', currency: 'USD', quoteScale: 1 },
  LSE: { region: 'UK', currency: 'GBP', quoteScale: 0.01 },
  SW: { region: 'CH', currency: 'CHF', quoteScale: 1 },
  XETRA: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  PA: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  AS: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  MC: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  MI: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  BR: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  HE: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  LS: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  VI: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  IR: { region: 'EU', currency: 'EUR', quoteScale: 1 },
  CO: { region: 'EU', currency: 'DKK', quoteScale: 1 },
};

export function exchangeOf(symbol: string): Exchange | undefined {
  const code = symbol.slice(symbol.lastIndexOf('.') + 1);
  return symbol.includes('.') ? exchanges[code] : undefined;
}

export type Reason =
  | 'unsupported_exchange' | 'region_not_allowed' | 'excluded_by_rule'
  | 'no_price' | 'stale_price' | 'fx_unavailable'
  | 'market_cap_unavailable' | 'below_min_market_cap'
  | 'adv_unavailable' | 'below_min_adv';

export type UniverseRules = {
  regions: Region[];
  minMarketCapUsd: number;
  minAdvUsd: number;
  maxStaleDays: number;
  advWindow: number;
  minAdvBars: number;
  /** Units of USD per one unit of each currency. Supplied by the caller; there is no FX source yet. */
  fxToUsd: Record<string, number>;
  /** Symbol to reason text. */
  excluded: Record<string, string>;
};

export type Metrics = {
  lastBarDate: string | null;
  lastClose: number | null;
  /** Average of close times volume over the last `advWindow` bars with a volume, in pounds, euros, dollars or francs. */
  advLocal: number | null;
  marketCapLocal: number | null;
};

const dayMs = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);

/** Derives metrics from bars dated on or before `asOf`. Bars after `asOf` are ignored. `bars` need not be sorted. */
export function deriveMetrics(input: { bars: Bar[]; asOf: string; quoteScale: number; sharesOutstanding: number | null; advWindow: number; minAdvBars: number }): Metrics {
  const bars = input.bars.filter(b => b.date <= input.asOf).sort((a, b) => b.date.localeCompare(a.date));
  const last = bars[0];
  if (!last) return { lastBarDate: null, lastClose: null, advLocal: null, marketCapLocal: null };
  const lastClose = last.close * input.quoteScale;
  const traded = bars.filter(b => b.volume !== null).slice(0, input.advWindow);
  const advLocal = traded.length >= input.minAdvBars ? traded.reduce((sum, b) => sum + b.close * input.quoteScale * (b.volume ?? 0), 0) / traded.length : null;
  const marketCapLocal = input.sharesOutstanding === null ? null : input.sharesOutstanding * lastClose;
  return { lastBarDate: last.date, lastClose, advLocal, marketCapLocal };
}

export type Candidate = { symbol: string } & Metrics;
export type Decision = {
  symbol: string; included: boolean; reasons: Reason[];
  region: Region | null; marketCapUsd: number | null; advUsd: number | null; lastBarDate: string | null;
};

/** Applies the hard filters. Every failing rule is reported, not only the first. */
export function screenUniverse(candidates: Candidate[], rules: UniverseRules, asOf: string): Decision[] {
  return candidates.map(c => {
    const exchange = exchangeOf(c.symbol);
    const reasons: Reason[] = [];
    if (!exchange) reasons.push('unsupported_exchange');
    else if (!rules.regions.includes(exchange.region)) reasons.push('region_not_allowed');
    if (c.symbol in rules.excluded) reasons.push('excluded_by_rule');
    if (c.lastBarDate === null) reasons.push('no_price');
    else if (days(c.lastBarDate, asOf) > rules.maxStaleDays) reasons.push('stale_price');
    const fx = exchange ? rules.fxToUsd[exchange.currency] : undefined;
    if (exchange && fx === undefined && (c.marketCapLocal !== null || c.advLocal !== null)) reasons.push('fx_unavailable');
    const marketCapUsd = fx !== undefined && c.marketCapLocal !== null ? c.marketCapLocal * fx : null;
    const advUsd = fx !== undefined && c.advLocal !== null ? c.advLocal * fx : null;
    if (c.marketCapLocal === null) reasons.push('market_cap_unavailable');
    else if (marketCapUsd !== null && marketCapUsd < rules.minMarketCapUsd) reasons.push('below_min_market_cap');
    if (c.advLocal === null) reasons.push('adv_unavailable');
    else if (advUsd !== null && advUsd < rules.minAdvUsd) reasons.push('below_min_adv');
    return { symbol: c.symbol, included: reasons.length === 0, reasons, region: exchange?.region ?? null, marketCapUsd, advUsd, lastBarDate: c.lastBarDate };
  });
}
