// Records real ESEF index, GLEIF and report responses for one issuer (A.P. Moller - Maersk).
// Usage: bun scripts/record-esef-fixtures.ts
// No key is needed. The excerpt keeps the root element, replaces the 450 KB style head, and keeps a 200 KB window from the first text block.
// The cut is marked with a comment. The real report has its hidden ix:header at the end, which the excerpt leaves out.
import { writeFile } from 'node:fs/promises';

const lei = '549300D2K6PKKKXVNN73';
const headers = { 'user-agent': 'open-foresight-educational' };
const dir = new URL('../fixtures/esef/', import.meta.url);
const text = async (url: string) => { const r = await fetch(url, { headers }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); };

const index = await text(`https://filings.xbrl.org/api/filings?${new URLSearchParams({ 'filter[entity.identifier]': lei, sort: '-period_end', 'page[size]': '1', include: 'entity' })}`);
const isins = await text(`https://api.gleif.org/api/v1/lei-records/${lei}/isins?page%5Bsize%5D=100&page%5Bnumber%5D=1`);
const reverse = await text(`https://api.gleif.org/api/v1/lei-records?${new URLSearchParams({ 'filter[isin]': 'DK0015996318', 'page[size]': '5' })}`);
const reportUrl = JSON.parse(index).data[0].attributes.report_url as string;
const full = await text(`https://filings.xbrl.org${reportUrl}`);
const start = Math.max(0, full.indexOf('<ix:nonNumeric') - 500);
const prefix = `${full.slice(0, full.indexOf('<head>'))}<head><!-- style removed --></head><body>`;
const excerpt = `${prefix}\n<!-- excerpt: bytes 0 to ${start} of the report were removed -->\n${full.slice(start, start + 200_000)}`;
await writeFile(new URL('index.json', dir), index);
await writeFile(new URL('gleif-isins.json', dir), isins);
await writeFile(new URL('gleif-reverse.json', dir), reverse);
await writeFile(new URL('report-excerpt.xhtml', dir), excerpt);
console.log(JSON.stringify({ lei, reportUrl, fullBytes: Buffer.byteLength(full), excerptBytes: Buffer.byteLength(excerpt), textBlocksInExcerpt: (excerpt.match(/<ix:nonNumeric/g) ?? []).length, textBlocksInFull: (full.match(/<ix:nonNumeric/g) ?? []).length }));
