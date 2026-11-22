import { describe, expect, it } from 'vitest';
import { deriveMetrics, exchangeOf, fxToUsd, screenUniverse, yahooSymbol, type Bar, type Metrics, type UniverseRules } from './universe.js';

const rules: UniverseRules = { regions: ['US', 'EU', 'UK', 'CH'], minMarketCapUsd: 1e9, minAdvUsd: 5e6, maxStaleDays: 5, advWindow: 3, minAdvBars: 2, fxToUsd: { USD: 1, GBP: 1.25, EUR: 1.1 }, excluded: { 'BAD.US': 'sanctioned' } };
const bars = (rows: Array<[string, number, number | null]>): Bar[] => rows.map(([date, close, volume]) => ({ date, close, volume }));

describe('deriveMetrics', () => {
  const base = { quoteScale: 1, sharesOutstanding: 1000, advWindow: 3, minAdvBars: 2 };
  it('ignores bars after the as-of date and uses the last close on or before it', () => {
    const m = deriveMetrics({ ...base, asOf: '2024-03-02', bars: bars([['2024-03-01', 10, 100], ['2024-03-02', 12, 100], ['2024-03-03', 99, 999]]) });
    expect(m).toMatchObject({ lastBarDate: '2024-03-02', lastClose: 12, marketCapLocal: 12000 });
    expect(m.advLocal).toBe((10 * 100 + 12 * 100) / 2);
  });
  it('skips missing volume and reports ADV unavailable below the minimum bar count', () => {
    const m = deriveMetrics({ ...base, asOf: '2024-03-05', bars: bars([['2024-03-03', 10, null], ['2024-03-04', 10, null], ['2024-03-05', 10, 50]]) });
    expect(m.advLocal).toBeNull();
    expect(m.lastClose).toBe(10);
  });
  it('averages only the most recent window of traded bars', () => {
    const m = deriveMetrics({ ...base, asOf: '2024-03-05', bars: bars([['2024-03-01', 1000, 1000], ['2024-03-02', 1, 1], ['2024-03-03', 1, 1], ['2024-03-05', 1, 1]]) });
    expect(m.advLocal).toBe(1);
  });
  it('has no price or cap when no bar exists on or before the date', () => {
    expect(deriveMetrics({ ...base, asOf: '2024-01-01', bars: bars([['2024-03-01', 10, 1]]) })).toEqual({ lastBarDate: null, lastClose: null, advLocal: null, marketCapLocal: null, marketCapSource: null });
  });
  it('scales pence quotes into pounds', () => {
    expect(deriveMetrics({ ...base, quoteScale: 0.01, asOf: '2024-03-01', bars: bars([['2024-03-01', 7218, 10]]) }).lastClose).toBeCloseTo(72.18);
  });
  it('has no market cap without shares', () => {
    expect(deriveMetrics({ ...base, sharesOutstanding: null, asOf: '2024-03-01', bars: bars([['2024-03-01', 10, 10]]) }).marketCapLocal).toBeNull();
  });
});

describe('exchangeOf', () => {
  it('maps suffixes to regions and rejects unknown ones', () => {
    expect(exchangeOf('AAPL.US')?.region).toBe('US');
    expect(exchangeOf('VOD.LSE')).toMatchObject({ region: 'UK', quoteScale: 0.01 });
    expect(exchangeOf('NESN.SW')?.region).toBe('CH');
    expect(exchangeOf('X.TO')).toBeUndefined();
    expect(exchangeOf('NOSUFFIX')).toBeUndefined();
  });
});

describe('screenUniverse', () => {
  const ok: Metrics = { lastBarDate: '2024-03-01', lastClose: 10, advLocal: 6e6, marketCapLocal: 2e9, marketCapSource: 'shares_x_close' };
  const decide = (symbol: string, over: Partial<Metrics> = {}) => screenUniverse([{ symbol, ...ok, ...over }], rules, '2024-03-01')[0]!;
  it('includes a name that passes every rule', () => {
    expect(decide('AAPL.US')).toMatchObject({ included: true, reasons: [], region: 'US', marketCapUsd: 2e9, advUsd: 6e6 });
  });
  it('converts local currency to USD before comparing thresholds', () => {
    expect(decide('VOD.LSE', { marketCapLocal: 0.9e9 }).reasons).toEqual([]);
    expect(decide('VOD.LSE', { marketCapLocal: 0.7e9 }).reasons).toEqual(['below_min_market_cap']);
  });
  it('reports every failing rule', () => {
    const d = decide('BAD.US', { lastBarDate: '2024-02-01', marketCapLocal: 1, advLocal: 1 });
    expect(d.included).toBe(false);
    expect(d.reasons).toEqual(['excluded_by_rule', 'stale_price', 'below_min_market_cap', 'below_min_adv']);
  });
  it('separates missing data from low values', () => {
    expect(decide('SAP.XETRA', { marketCapLocal: null }).reasons).toEqual(['market_cap_unavailable']);
    expect(decide('SAP.XETRA', { advLocal: null }).reasons).toEqual(['adv_unavailable']);
    expect(decide('ZZZ.US', { lastBarDate: null, lastClose: null, advLocal: null, marketCapLocal: null, marketCapSource: null }).reasons).toEqual(['no_price', 'market_cap_unavailable', 'adv_unavailable']);
  });
  it('flags unsupported exchanges, disallowed regions and missing FX', () => {
    expect(decide('X.TO').reasons).toContain('unsupported_exchange');
    expect(screenUniverse([{ symbol: 'NESN.SW', ...ok }], { ...rules, regions: ['US'] }, '2024-03-01')[0]!.reasons).toEqual(['region_not_allowed', 'fx_unavailable']);
  });
  it('treats the stale limit as inclusive', () => {
    expect(decide('AAPL.US', { lastBarDate: '2024-02-25' }).reasons).toEqual([]);
    expect(decide('AAPL.US', { lastBarDate: '2024-02-24' }).reasons).toEqual(['stale_price']);
  });
});

describe('fxToUsd', () => {
  it('converts euro-quoted rates into USD per unit', () => {
    const out = fxToUsd({ USD: 1.08, GBP: 0.84, CHF: 0.9 });
    expect(out.USD).toBe(1);
    expect(out.EUR).toBe(1.08);
    expect(out.GBP).toBeCloseTo(1.08 / 0.84);
    expect(out.CHF).toBeCloseTo(1.2);
  });
  it('returns nothing without a usable USD rate and skips bad rates', () => {
    expect(fxToUsd({ GBP: 0.84 })).toEqual({});
    expect(fxToUsd({ USD: 0 })).toEqual({});
    expect(fxToUsd({ USD: 1.1, GBP: 0 })).toEqual({ USD: 1, EUR: 1.1 });
  });
});

describe('yahooSymbol', () => {
  it('maps EODHD symbols to Yahoo tickers', () => {
    expect(yahooSymbol('AAPL.US')).toBe('AAPL');
    expect(yahooSymbol('BRK-B.US')).toBe('BRK-B');
    expect(yahooSymbol('SAP.XETRA')).toBe('SAP.DE');
    expect(yahooSymbol('VOD.LSE')).toBe('VOD.L');
    expect(yahooSymbol('VOLV-B.ST')).toBe('VOLV-B.ST');
    expect(yahooSymbol('ENEL.MI')).toBeUndefined();
  });
});

describe('observed market cap', () => {
  const base = { quoteScale: 1, advWindow: 3, minAdvBars: 2, asOf: '2024-03-01', bars: bars([['2024-03-01', 10, 100], ['2024-02-29', 10, 100]]) };
  it('is used only when shares are missing, and says so', () => {
    expect(deriveMetrics({ ...base, sharesOutstanding: 50, observedMarketCap: 999 })).toMatchObject({ marketCapLocal: 500, marketCapSource: 'shares_x_close' });
    expect(deriveMetrics({ ...base, sharesOutstanding: null, observedMarketCap: 999 })).toMatchObject({ marketCapLocal: 999, marketCapSource: 'observed' });
    expect(deriveMetrics({ ...base, sharesOutstanding: null })).toMatchObject({ marketCapLocal: null, marketCapSource: null });
  });
  it('prefers observed shares times the as-of close over an observed cap', () => {
    expect(deriveMetrics({ ...base, sharesOutstanding: null, observedShares: 30, observedMarketCap: 999 })).toMatchObject({ marketCapLocal: 300, marketCapSource: 'observed_shares_x_close' });
    expect(deriveMetrics({ ...base, sharesOutstanding: 50, observedShares: 30 })).toMatchObject({ marketCapLocal: 500, marketCapSource: 'shares_x_close' });
  });
});
