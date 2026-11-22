// Records real EODHD EOD responses for the 50-symbol universe fixture.
// Usage: EODHD_API_KEY=... bun scripts/record-eodhd-fixtures.ts
// Costs one API call per symbol. The key is sent to EODHD only and never written to the output.
import { writeFile } from 'node:fs/promises';

const symbols = [
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'AMZN.US', 'GOOGL.US', 'XOM.US', 'JPM.US', 'JNJ.US', 'PG.US', 'KO.US',
  'ENPH.US', 'FSLR.US', 'RUN.US', 'PLUG.US', 'BE.US', 'SEDG.US', 'NEE.US', 'AES.US', 'ARRY.US', 'SHLS.US',
  'CLNE.US', 'FCEL.US', 'AMRC.US', 'TPIC.US', 'STEM.US',
  'SAP.XETRA', 'SIE.XETRA', 'RWE.XETRA', 'EOAN.XETRA', 'ASML.AS', 'MC.PA', 'SU.PA', 'ALO.PA', 'ENGI.PA', 'ENEL.MI', 'IBE.MC', 'NOKIA.HE', 'VWS.CO',
  'VOD.LSE', 'SSE.LSE', 'NG.LSE', 'BP.LSE', 'SHEL.LSE', 'ITM.LSE',
  'NESN.SW', 'ROG.SW', 'NOVN.SW', 'ABBN.SW', 'SIKA.SW',
  'ZZZZ.US',
];
const from = '2024-09-20', to = '2024-11-08';
const key = process.env.EODHD_API_KEY;
if (!key) throw new Error('Set EODHD_API_KEY');
const out: Record<string, unknown> = {};
for (const symbol of symbols) {
  const response = await fetch(`https://eodhd.com/api/eod/${encodeURIComponent(symbol)}?${new URLSearchParams({ api_token: key, fmt: 'json', from, to })}`);
  out[symbol] = response.ok ? await response.json() : { httpStatus: response.status };
}
await writeFile(new URL('../fixtures/eodhd/eod-bars.json', import.meta.url), `${JSON.stringify({ recordedAt: new Date().toISOString(), from, to, symbols: out }, null, 1)}\n`);
console.log(Object.entries(out).map(([s, v]) => `${s}:${Array.isArray(v) ? v.length : JSON.stringify(v)}`).join(' '));
