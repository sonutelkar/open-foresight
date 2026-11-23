/** Annual report forms the SEC path ingests: 10-K for US issuers, 20-F and 40-F for foreign private issuers. */
export const annualForms = ['10-K', '20-F', '40-F'] as const;

/**
 * An issuer that code cannot link to a listing by ticker, FIGI or ISIN, so it is linked by hand. Each entry names the listing symbol and the issuer key of the filer.
 * The key is `cik:` with a ten digit CIK, or `lei:` with a LEI. A listing with an alias gains that issuer's filings as evidence, and keeps any it already has.
 */
export type IssuerAlias = { symbol: string; issuerKey: string; note: string };

export const issuerAliases: readonly IssuerAlias[] = [
  { symbol: 'XOM.US', issuerKey: 'cik:0000034088', note: 'SEC ticker data now lists the new holding company, CIK 2115436, which has filed no 10-K. Exxon Mobil Corp files it.' },
  { symbol: 'SAP.XETRA', issuerKey: 'cik:0001000184', note: 'SAP SE files an English 20-F with the SEC. The filings index has no German ESEF reports.' },
  { symbol: 'NOKIA.HE', issuerKey: 'cik:0000924613', note: 'Nokia Corp files an English 20-F with the SEC. GLEIF lists no ISIN for its LEI, and its ESEF report is in Finnish.' },
];

export const isIssuerKey = (value: string) => /^cik:\d{10}$/.test(value) || /^lei:[A-Z0-9]{20}$/.test(value);
