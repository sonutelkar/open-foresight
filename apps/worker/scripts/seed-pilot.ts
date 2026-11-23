// Ingests a real 50-name store for the live check of PR 15. It is the only step that calls outside data sources.
// The worker never does this: agents read the local store only.
//   ECB FX, EODHD prices and symbol lists, OpenFIGI, Yahoo market caps (Python yfinance run with uv), SEC annual reports (10-K, 20-F, 40-F), ESEF reports, and real embeddings.
// Usage: DATABASE_URL=... EODHD_API_KEY=... SEC_USER_AGENT=... OPENROUTER_API_KEY=... bun scripts/seed-pilot.ts
// Every phase can be run again. Providers write versioned rows, and indexing skips documents it has indexed.
// A rerun of `sec` finds a changed submissions file for every filer and ingests a new version, which indexing then embeds again.
// To add only the aliased filers, run PHASES=aliases,index.
import { readFile } from 'node:fs/promises';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createEcbFxProvider, createEodhdListingsProvider, createEodhdProvider, createEsefProvider, createSecEdgarProvider, createSecSecurityProvider, createYahooProvider } from '@open-foresight/data';
import { exchangeListings, secFilings, secListings } from '@open-foresight/db';
import { annualForms, exchanges, issuerAliases } from '@open-foresight/core';
import { createEmbedder } from '@open-foresight/llm';
import { indexDocuments, linkIssuerAliases } from '@open-foresight/retrieval';

const env = (name: string) => { const v = process.env[name]; if (!v?.trim()) throw new Error(`Set ${name}`); return v; };
const sql = postgres(env('DATABASE_URL'), { max: 4 });
const db = drizzle(sql);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const phases = new Set((process.env.PHASES ?? 'fx,prices,caps,listings,sec,aliases,esef,index').split(','));
const t0 = Date.now();
const log = (phase: string, detail: unknown) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${phase.padEnd(9)} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

const fixture = JSON.parse(await readFile(new URL('../../../packages/data/fixtures/eodhd/universe-50.json', import.meta.url), 'utf8')) as { listings: Array<{ symbol: string }> };
// Only symbols on exchanges the universe screen supports. The fixture also lists a Milan name, which the screen would drop as unsupported.
const symbols = fixture.listings.map(l => l.symbol).filter(s => s.slice(s.lastIndexOf('.') + 1) in exchanges || s.endsWith('.US'));
const us = symbols.filter(s => s.endsWith('.US'));
const abroad = symbols.filter(s => !s.endsWith('.US'));
const exchangesOf = [...new Set(symbols.map(s => s.slice(s.lastIndexOf('.') + 1)))];
log('plan', `${symbols.length} symbols, ${us.length} US, ${abroad.length} elsewhere, exchanges ${exchangesOf.join(' ')}`);

const eodhdKey = env('EODHD_API_KEY');
if (phases.has('fx')) log('fx', await createEcbFxProvider({ db }).sync({ currencies: ['USD', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK'], from: day(-14), to: day(0) }));
const prices = createEodhdProvider({ db, apiKey: eodhdKey });
if (!prices) throw new Error('The EODHD adapter is disabled');
if (phases.has('prices')) log('prices', await prices.sync({ symbols, from: day(-45), to: day(0) }));
if (phases.has('caps')) log('caps', await createYahooProvider({ db }).sync({ symbols }));

const listings = createEodhdListingsProvider({ db, apiKey: eodhdKey });
if (!listings) throw new Error('The EODHD listings adapter is disabled');
if (phases.has('listings')) log('listings', await listings.sync({ exchanges: exchangesOf, only: symbols }));

// SEC: link US tickers to CIKs and securities, then take each filer's latest annual report.
const userAgent = env('SEC_USER_AGENT');
const tickers = us.map(s => s.slice(0, s.lastIndexOf('.')));
if (phases.has('sec')) log('security', await createSecSecurityProvider({ db, userAgent }).sync({ tickers }));
const edgar = createSecEdgarProvider({ db, userAgent });
const sec = await db.select({ ticker: secListings.ticker, cik: secListings.cik }).from(secListings).where(inArray(secListings.ticker, tickers));
const cikOf = new Map<string, string>();
for (const row of sec) if (!cikOf.has(row.ticker.toUpperCase())) cikOf.set(row.ticker.toUpperCase(), row.cik);
// Issuers that no ticker reaches are linked by hand in core. Link them, then ingest their filings too.
const aliasLink = phases.has('aliases') ? await linkIssuerAliases(db, issuerAliases) : { linked: 0, missing: [] };
log('aliases', aliasLink);
const targets = [
  ...(phases.has('sec') ? tickers.map(ticker => ({ label: ticker, cik: cikOf.get(ticker.toUpperCase()) })) : []),
  ...issuerAliases.filter(a => phases.has('aliases') && a.issuerKey.startsWith('cik:')).map(a => ({ label: a.symbol, cik: a.issuerKey.slice(4) })),
];
let filed = 0;
const noTenK: string[] = [];
for (const { label, cik } of targets) {
  if (!cik) { noTenK.push(`${label}(no cik)`); continue; }
  try {
    const submissions = await (await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'user-agent': userAgent } })).json() as { filings: { recent: { form: string[]; accessionNumber: string[] } } };
    const r = submissions.filings.recent;
    // The newest annual report is the first annual form in the list, which the SEC sorts by filing date, newest first.
    const at = r.form.findIndex(form => (annualForms as readonly string[]).includes(form));
    const accession = at >= 0 ? r.accessionNumber[at] : undefined;
    if (!accession) { noTenK.push(`${label}(no annual report)`); continue; }
    await edgar.sync({ cik, accessions: [accession] });
    filed++;
    if (filed % 5 === 0) log('filings', `${filed} annual reports ingested`);
  } catch (error) { noTenK.push(`${label}(${error instanceof Error ? error.message.slice(0, 60) : 'error'})`); }
}
log('filings', { ingested: filed, skipped: noTenK });
log('secdocs', (await db.select({ id: secFilings.id }).from(secFilings)).length);

// ESEF: annual reports for the non-US names with a resolved ISIN. The index has none for DE or CH, and GLEIF lists no ISIN for Nokia, so Nokia comes through its 20-F alias.
const isins = (await db.select({ isin: exchangeListings.isin, status: exchangeListings.status, symbol: exchangeListings.symbol }).from(exchangeListings).where(inArray(exchangeListings.symbol, abroad))).flatMap(r => r.status === 'resolved' && r.isin ? [r.isin] : []);
log('esef', `${isins.length} ISINs to look up`);
// filings.xbrl.org rate limits bursts, so go a few ISINs at a time and wait out any 429.
const esefProvider = createEsefProvider({ db });
const esefTotal = { filings: 0, bytes: 0 };
if (phases.has('esef')) for (let i = 0; i < isins.length; i += 4) {
  const chunk = isins.slice(i, i + 4);
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await esefProvider.sync({ isins: chunk, perLei: 1 }) as unknown as Record<string, unknown> & { bytes: number };
      esefTotal.bytes += r.bytes;
      log('esef', { chunk: chunk.length, ...r, bytes: `${(r.bytes / 1e6).toFixed(1)} MB` });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('esef', `attempt ${attempt} failed: ${message.slice(0, 80)}`);
      if (attempt >= 5) throw error;
      await new Promise(r => setTimeout(r, 60_000 * attempt));
    }
  }
  await new Promise(r => setTimeout(r, 10_000));
}
log('esef', { downloaded: `${(esefTotal.bytes / 1e6).toFixed(1)} MB` });

// Index every filing with real embeddings, in batches until none are left.
const embedder = await createEmbedder({ db, apiKey: env('OPENROUTER_API_KEY') });
log('index', `embedder ${embedder.model} via ${embedder.provider}`);
let total = { documents: 0, chunks: 0, tokens: 0, costUsd: 0, empty: 0 };
for (;;) {
  const r = await indexDocuments({ db, embedder, limit: 5 });
  total = { documents: total.documents + r.documents, chunks: total.chunks + r.chunks, tokens: total.tokens + r.tokens, costUsd: total.costUsd + r.costUsd, empty: total.empty + r.empty };
  log('index', total);
  if (r.documents + r.empty === 0) break;
}
await sql.end();
log('done', 'store is ready');
