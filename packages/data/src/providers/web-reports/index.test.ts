import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Heading } from '@open-foresight/core';
import { webDocuments } from '@open-foresight/db';
import { createWebReportsProvider } from './index.js';

const fixture = (name: string) => readFile(new URL(`../../../fixtures/web-reports/${name}`, import.meta.url));
const pdf = new Uint8Array(await fixture('report.pdf'));
const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
const html = (await fixture('report.html')).toString('utf8');
const pdfPageStarts = ['Northwind Grid AG Annual Report 2025\nFiscal year', 'Smart Infrastructure segment\nThe segment sells', 'Mobility and rail signalling segment\nThe segment supplies'];
const AGENT = 'open-foresight-educational';
/** A new issuer for each test, because one company's identical bytes under two URLs are one report. */
const newIssuer = () => `lei:NW${randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase()}`;
let ISSUER = newIssuer();

type Reply = { status?: number; body?: BodyInit | null; headers?: Record<string, string> } | 'network_error';
/** A stubbed web. Unknown URLs, robots.txt included, answer 404. */
function web(routes: Record<string, (headers: Headers) => Reply>) {
  const calls: Array<{ url: string; headers: Headers; at: number }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: url.href, headers, at: performance.now() });
    const reply = routes[url.href]?.(headers) ?? { status: 404 };
    if (reply === 'network_error') throw new TypeError('fetch failed');
    return new Response(reply.body ?? null, { status: reply.status ?? 200, headers: reply.headers });
  };
  return { calls, fetcher };
}
/** A trailing PDF comment changes the bytes and the hash but not the pages, so one fixture can stand for different reports. */
const pdfReply = (headers: Record<string, string> = {}, variant = '') => () => ({ body: variant ? Buffer.concat([pdf, Buffer.from(`\n%variant ${variant}\n`)]) : pdf.slice(), headers: { 'content-type': 'application/pdf', ...headers } });
const htmlReply = (body: string) => () => ({ body, headers: { 'content-type': 'text/html; charset=utf-8' } });
const input = (urls: string[]) => ({ issuerKey: ISSUER, entityName: 'Northwind Grid AG', mustMention: ['Contoso', 'NORTHWIND'], urls });

const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('web reports on Postgres', () => {
  const client = postgres(url ?? 'postgres://localhost/unused', { max: 2 });
  const db = drizzle(client);
  beforeEach(() => { ISSUER = newIssuer(); });
  afterAll(async () => { await client.end(); });
  const make = (stub: ReturnType<typeof web>, over: Partial<Parameters<typeof createWebReportsProvider>[0]> = {}) =>
    createWebReportsProvider({ db, userAgent: AGENT, allowedDomains: ['northwind.test'], fetch: stub.fetcher, minDelayMs: 0, now: () => new Date('2026-11-22T10:00:00Z'), ...over });
  const rows = (prefix: string) => db.select().from(webDocuments).where(like(webDocuments.url, `${prefix}%`)).orderBy(asc(webDocuments.fetchedAt));

  it('stores a PDF behind a redirect, with a heading at the start of each page', async () => {
    const tag = randomUUID();
    const start = `https://www.northwind.test/${tag}/annual-report`, final = `https://assets.northwind.test/${tag}/report.pdf`;
    const stub = web({
      [start]: () => ({ status: 302, headers: { location: final } }),
      [final]: pdfReply({ etag: '"v1"', 'last-modified': 'Mon, 17 Nov 2025 08:00:00 GMT' }),
    });
    const attemptId = randomUUID();
    const report = await make(stub, { now: () => new Date('2026-11-22T23:30:00-03:00') }).sync({ ...input([start]), attemptId, periodEnd: '2025-09-30' });

    const [row, ...more] = await rows(start);
    expect(more).toEqual([]);
    expect(report).toEqual({ stored: [{ url: start, id: row?.id, pages: 3, chars: row?.text.length }], unchanged: [], rejected: [] });
    expect(row).toMatchObject({
      url: start, finalUrl: final, contentType: 'application/pdf', byteSize: pdf.byteLength, rawSha256: pdfSha256,
      etag: '"v1"', lastModified: 'Mon, 17 Nov 2025 08:00:00 GMT', extractor: 'unpdf@2.2.1',
      issuerKey: ISSUER, entityName: 'Northwind Grid AG', periodEnd: '2025-09-30', attemptId, availableOn: '2026-11-23',
    });
    expect(row?.fetchedAt.toISOString()).toBe('2026-11-23T02:30:00.000Z');
    const text = row?.text ?? '';
    const headings = row?.headings as Heading[];
    expect(headings.map(h => [h.title, h.level])).toEqual([['Page 1', 1], ['Page 2', 1], ['Page 3', 1]]);
    headings.forEach((h, i) => expect(text.slice(h.offset).startsWith(pdfPageStarts[i] ?? '-')).toBe(true));
    expect(headings.slice(1).map(h => text.slice(h.offset - 2, h.offset))).toEqual(['\n\n', '\n\n']);
    expect(stub.calls.map(c => c.url)).toEqual([`https://www.northwind.test/robots.txt`, start, `https://assets.northwind.test/robots.txt`, final]);
    expect(stub.calls.map(c => c.headers.get('user-agent'))).toEqual([AGENT, AGENT, AGENT, AGENT]);
  });

  it('stores HTML with the headings of its sections', async () => {
    const page = `https://ir.northwind.test/${randomUUID()}/annual-report-2025.html`;
    const report = await make(web({ [page]: htmlReply(html) })).sync(input([page]));
    const [row] = await rows(page);
    expect(report.stored).toEqual([{ url: page, id: row?.id, pages: null, chars: row?.text.length }]);
    expect(row).toMatchObject({ contentType: 'text/html', extractor: 'core-html', byteSize: Buffer.byteLength(html) });
    const headings = row?.headings as Heading[];
    expect(headings.map(h => h.title)).toEqual(['Letter from the board', 'Smart Infrastructure segment', 'Mobility and rail signalling segment']);
    for (const h of headings) expect(row?.text.slice(h.offset).startsWith(h.title)).toBe(true);
  });

  it('rejects each bad URL with its reason, stores nothing for it, and goes on to the next', async () => {
    const tag = randomUUID();
    const base = `https://www.northwind.test/${tag}`;
    const filler = `<p>${'The group sells grid equipment to utilities. '.repeat(500)}</p>`;
    const cases: Array<[string, string, ((headers: Headers) => Reply)?]> = [
      ['not a url', 'invalid_url'],
      [`http://www.northwind.test/${tag}/plain.pdf`, 'not_https'],
      [`https://northwind.example/${tag}/r.pdf`, 'not_allowed_domain'],
      [`https://northwind.test.evil.example/${tag}/r.pdf`, 'not_allowed_domain'],
      [`https://evilnorthwind.test/${tag}/r.pdf`, 'not_allowed_domain'],
      [`${base}/off-list`, 'redirected_off_allow_list', () => ({ status: 302, headers: { location: `https://cdn.example/${tag}/r.pdf` } })],
      [`${base}/to-http`, 'not_https', () => ({ status: 301, headers: { location: `http://www.northwind.test/${tag}/r.pdf` } })],
      [`${base}/loop`, 'too_many_redirects', () => ({ status: 307, headers: { location: `${base}/loop` } })],
      [`${base}/login`, 'login_required', () => ({ status: 401 })],
      [`${base}/forbidden`, 'login_required', () => ({ status: 403 })],
      [`${base}/missing`, 'http_404'],
      [`${base}/broken`, 'http_500', () => ({ status: 500 })],
      [`${base}/not-modified`, 'http_304', () => ({ status: 304 })],
      [`${base}/declared-large.pdf`, 'too_large', () => ({ body: pdf.slice(), headers: { 'content-type': 'application/pdf', 'content-length': '300000' } })],
      [`${base}/streamed-large.pdf`, 'too_large', () => ({ body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(100_000)); } }), headers: { 'content-type': 'application/pdf' } })],
      [`${base}/archive.zip`, 'unsupported_content_type', () => ({ body: pdf.slice(), headers: { 'content-type': 'application/zip' } })],
      [`${base}/corrupt.pdf`, 'extract_failed', () => ({ body: 'this is not a PDF', headers: { 'content-type': 'application/pdf' } })],
      [`${base}/short.html`, 'too_little_text', htmlReply('<p>Northwind Grid AG</p>')],
      [`${base}/late-mention.html`, 'wrong_company', htmlReply(`${filler}<p>Northwind Grid AG</p>`)],
      [`${base}/offline.pdf`, 'fetch_failed', () => 'network_error'],
    ];
    const good = `${base}/good.pdf`;
    const stub = web({ ...Object.fromEntries(cases.flatMap(([u, , reply]) => reply ? [[u, reply]] : [])), [good]: pdfReply() });
    const report = await make(stub, { maxBytes: 200_000 }).sync(input([...cases.map(([u]) => u), good]));
    expect(report.rejected).toEqual(cases.map(([u, reason]) => ({ url: u, reason })));
    expect(report.stored.map(s => s.url)).toEqual([good]);
    expect(report.unchanged).toEqual([]);
    expect((await rows(base)).map(r => r.url)).toEqual([good]);
    expect(stub.calls.some(c => c.url.includes('cdn.example') || c.url.startsWith('http:'))).toBe(false);
  });

  it('follows robots.txt for our agent, or for every agent when no group names ours', async () => {
    const tag = randomUUID().slice(0, 8);
    const origin = (name: string) => `https://${name}-${tag}.northwind.test`;
    const robots = (body: string) => () => ({ body, headers: { 'content-type': 'text/plain' } });
    const stub = web({
      [`${origin('a')}/robots.txt`]: robots('User-agent: *\nDisallow: /private\nAllow: /private/annual\n'),
      [`${origin('b')}/robots.txt`]: robots('User-agent: *\nDisallow: /\n\nUser-agent: open-foresight-educational\nDisallow:\n'),
      [`${origin('c')}/robots.txt`]: robots('User-agent: Open-Foresight-Educational # us\nDisallow: /reports/\nUser-agent: *\nAllow: /\n'),
      [`${origin('d')}/robots.txt`]: robots('User-agent: *\nDisallow: /*.pdf$\n'),
      [`${origin('e')}/robots.txt`]: () => ({ status: 503 }),
      [`${origin('f')}/robots.txt`]: () => 'network_error',
      ...Object.fromEntries(['a/private/annual/r.pdf', 'a/private/annual/r2.pdf', 'b/r.pdf', 'd/files/r.pdf?download=1', 'g/r.pdf'].map((p, i) => [`${origin(p.slice(0, 1))}${p.slice(1)}`, pdfReply({}, `robots-${i}`)])),
    });
    const urls = ['a/private/annual/r.pdf', 'a/private/notes.pdf', 'a/private/annual/r2.pdf', 'b/r.pdf', 'c/reports/r.pdf', 'd/files/r.pdf', 'd/files/r.pdf?download=1', 'e/r.pdf', 'f/r.pdf', 'g/r.pdf']
      .map(p => `${origin(p.slice(0, 1))}${p.slice(1)}`);
    const report = await make(stub).sync(input(urls));
    const at = (i: number) => urls[i] ?? '';
    expect(report.stored.map(s => s.url)).toEqual([at(0), at(2), at(3), at(6), at(9)]);
    expect(report.rejected).toEqual([1, 4, 5, 7, 8].map(i => ({ url: at(i), reason: 'robots_disallowed' })));
    expect(stub.calls.filter(c => c.url === `${origin('a')}/robots.txt`)).toHaveLength(1);
    expect(stub.calls.filter(c => !c.url.endsWith('/robots.txt') && /\/\/[ef]-/.test(c.url))).toEqual([]);
  });

  it('waits minDelayMs between the starts of two requests to one host, and not across hosts', async () => {
    const tag = randomUUID();
    const one = `https://one.northwind.test/${tag}`, two = `https://two.northwind.test/${tag}`;
    const stub = web({});
    const report = await make(stub, { minDelayMs: 400 }).sync(input([`${one}/a.pdf`, `${two}/a.pdf`, `${one}/b.pdf`]));
    expect(report.rejected.map(r => r.reason)).toEqual(['http_404', 'http_404', 'http_404']);
    const starts = (host: string) => stub.calls.filter(c => new URL(c.url).host === host).map(c => c.at);
    const gaps = (times: number[]) => times.slice(1).map((t, i) => t - (times[i] ?? 0));
    const first = starts('one.northwind.test'), second = starts('two.northwind.test');
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(2);
    for (const gap of [...gaps(first), ...gaps(second)]) expect(gap).toBeGreaterThanOrEqual(398);
    expect((second[0] ?? 0) - (first[1] ?? 0)).toBeLessThan(200);
  });

  it('sends validators from the newest version, counts a 304 or the same bytes as unchanged, and keeps new bytes as a new version', async () => {
    const page = `https://ir.northwind.test/${randomUUID()}/annual-report.html`;
    let served = { body: html, etag: '"v1"', lastModified: 'Mon, 17 Nov 2025 08:00:00 GMT' };
    let honorsValidators = false;
    const stub = web({ [page]: h => honorsValidators && h.get('if-none-match') === served.etag ? { status: 304 }
      : { body: served.body, headers: { 'content-type': 'text/html', etag: served.etag, 'last-modified': served.lastModified } } });
    const on = (day: string) => make(stub, { now: () => new Date(`${day}T09:00:00Z`) });
    const sent = () => { const h = stub.calls.at(-1)?.headers; return [h?.get('if-none-match'), h?.get('if-modified-since')]; };

    expect((await on('2026-11-20').sync(input([page]))).stored).toHaveLength(1);
    expect(sent()).toEqual([null, null]);
    expect(await on('2026-11-20').sync(input([page]))).toEqual({ stored: [], unchanged: [page], rejected: [] });
    expect(sent()).toEqual(['"v1"', 'Mon, 17 Nov 2025 08:00:00 GMT']);
    expect(await rows(page)).toHaveLength(1);

    served = { body: html.replace('9.4 billion', '9.6 billion'), etag: '"v2"', lastModified: 'Fri, 21 Nov 2025 08:00:00 GMT' };
    expect((await on('2026-11-21').sync(input([page]))).stored).toHaveLength(1);
    expect((await rows(page)).map(r => [r.availableOn, r.etag, r.text.includes('9.6 billion')])).toEqual([['2026-11-20', '"v1"', false], ['2026-11-21', '"v2"', true]]);

    honorsValidators = true;
    expect(await on('2026-11-22').sync(input([page]))).toEqual({ stored: [], unchanged: [page], rejected: [] });
    expect(sent()).toEqual(['"v2"', 'Fri, 21 Nov 2025 08:00:00 GMT']);
    expect(await rows(page)).toHaveLength(2);
  });

  it('treats the same bytes at a second URL, such as a mirror, as the same report', async () => {
    const a = `https://ir.northwind.test/${randomUUID()}/report.html`, b = `https://ir.northwind.test/${randomUUID()}/mirror.html`;
    const body = html.replace('9.4 billion', `9.${Math.floor(Math.random() * 1e6)} billion`);
    const stub = web({ [a]: () => ({ body, headers: { 'content-type': 'text/html' } }), [b]: () => ({ body, headers: { 'content-type': 'text/html' } }) });
    const report = await make(stub).sync(input([a, b]));
    expect(report.stored.map(r => r.url)).toEqual([a]);
    expect(report.unchanged).toEqual([b]);
    expect(await rows(a)).toHaveLength(1);
    expect(await rows(b)).toHaveLength(0);
  });

  it('refuses bad input and options before fetching anything', async () => {
    const stub = web({});
    const provider = make(stub);
    await expect(provider.sync({ ...input(['https://www.northwind.test/r.pdf']), mustMention: [] })).rejects.toThrow();
    await expect(provider.sync({ ...input(['https://www.northwind.test/r.pdf']), issuerKey: 'Northwind' })).rejects.toThrow();
    await expect(provider.sync({ ...input(['https://www.northwind.test/r.pdf']), periodEnd: '30.09.2025' })).rejects.toThrow();
    expect(stub.calls).toEqual([]);
    expect(() => createWebReportsProvider({ db, userAgent: ' ', allowedDomains: ['northwind.test'] })).toThrow('user agent');
    expect(() => createWebReportsProvider({ db, userAgent: AGENT, allowedDomains: [' '] })).toThrow('allowed domain');
  });

  it('extracts a 200-page PDF within 30 seconds', async () => {
    const pages = Array.from({ length: 200 }, (_, p) => Array.from({ length: 50 }, (_, l) => `Northwind Grid AG page ${p + 1} line ${l + 1}: revenue, orders and margins of the segment in fiscal 2025.`));
    const big = makePdf(pages);
    const page = `https://ir.northwind.test/${randomUUID()}/large.pdf`;
    const start = performance.now();
    const report = await make(web({ [page]: () => ({ body: big.slice(), headers: { 'content-type': 'application/pdf' } }) })).sync(input([page]));
    const elapsed = performance.now() - start;
    process.stdout.write(`${JSON.stringify({ perf: '200-page PDF', bytes: big.byteLength, chars: report.stored[0]?.chars, ms: Math.round(elapsed) })}\n`);
    expect(report.stored[0]?.pages).toBe(200);
    const [row] = await rows(page);
    const headings = row?.headings as Heading[];
    expect(headings).toHaveLength(200);
    expect(row?.text.slice(headings[199]?.offset).startsWith('Northwind Grid AG page 200 line 1:')).toBe(true);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});

/** A plain PDF with one Helvetica text line per string, made in memory. */
function makePdf(pages: string[][]) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((lines, i) => {
    const stream = `BT /F1 8 Tf 10 TL 40 800 Td ${lines.map(line => `(${line}) '`).join(' ')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
