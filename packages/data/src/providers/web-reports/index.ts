import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { htmlToText, type Heading } from '@open-foresight/core';
import { webDocuments } from '@open-foresight/db';
import { extractText } from 'unpdf';
import { z } from 'zod';
import type { DataProvider } from '../../index.js';

export type WebReportRejection =
  | 'invalid_url' | 'not_https' | 'not_allowed_domain' | 'redirected_off_allow_list' | 'too_many_redirects'
  | 'robots_disallowed' | 'fetch_failed' | 'login_required' | `http_${number}`
  | 'too_large' | 'unsupported_content_type' | 'extract_failed' | 'too_little_text' | 'wrong_company';
export type WebReportsSyncInput = {
  issuerKey: string; entityName: string;
  /** The report must contain one of these, ignoring case, in its first 20,000 characters. */
  mustMention: string[];
  urls: string[]; attemptId?: string; periodEnd?: string;
};
export type WebReportsSyncReport = {
  stored: Array<{ url: string; id: string; pages: number | null; chars: number }>;
  unchanged: string[];
  rejected: Array<{ url: string; reason: WebReportRejection }>;
};
/** A fetched page as it is stored. */
export type StoredPage = Omit<typeof webDocuments.$inferInsert, 'id'>;
/** Where fetched pages go. The default is `web_documents`. */
export type WebPageStore = {
  /** The validators of the latest stored copy of a URL, for a conditional request. */
  previous(url: string): Promise<{ etag: string | null; lastModified: string | null } | undefined>;
  /** Stores a page and returns its id, or null when the same page is already stored. */
  save(page: StoredPage): Promise<string | null>;
};
type Input = z.infer<typeof inputSchema>;
type Rule = { allow: boolean; pattern: string };
type Rejected = { reason: WebReportRejection };

const inputSchema = z.object({
  issuerKey: z.string().regex(/^(lei|cik):[A-Z0-9]+$/), entityName: z.string().trim().min(1),
  mustMention: z.array(z.string().trim().min(1)).min(1), urls: z.array(z.string()).min(1),
  attemptId: z.string().uuid().optional(), periodEnd: z.string().date().optional(),
});
const kinds = new Map<string, 'pdf' | 'html'>([['application/pdf', 'pdf'], ['text/html', 'html'], ['application/xhtml+xml', 'html']]);
const redirects = new Set([301, 302, 303, 307, 308]);
const unpdfVersion = (JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve('unpdf')), '..', 'package.json'), 'utf8')) as { version: string }).version;
const minChars = 2000, mentionWindow = 20_000, maxRedirects = 5;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const discard = (response: Response) => response.body?.cancel().catch(() => undefined);

/**
 * Fetches public annual reports from company sites into `web_documents`. Each URL is checked against the allow-list,
 * robots.txt and the company names before anything is stored, and a URL that fails a check is reported with a reason
 * instead of stopping the rest. A report is evidence from the UTC day it was first fetched in that version.
 */
export function createWebReportsProvider(options: {
  /** Needed unless `store` is given. */
  db?: PostgresJsDatabase; userAgent: string;
  /** A host matches a domain when it equals it or is a subdomain of it. */
  allowedDomains?: string[];
  /** Replaces the domain allow-list with a policy of its own, checked at every hop like the allow-list. */
  hostAllowed?: (url: URL) => boolean;
  store?: WebPageStore;
  fetch?: typeof fetch; now?: () => Date;
  /** Least time between the starts of two requests to one host. Default 2000. */
  minDelayMs?: number;
  /** Default 80 MB. */
  maxBytes?: number;
}): DataProvider<WebReportsSyncInput, WebReportsSyncReport> {
  const userAgent = options.userAgent.trim();
  const domains = (options.allowedDomains ?? []).map(d => d.trim().toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean);
  if (!userAgent) throw new Error('A user agent is required');
  if (domains.length === 0 && !options.hostAllowed) throw new Error('At least one allowed domain is required');
  const db = options.db;
  const store: WebPageStore = options.store ?? (db ? {
    previous: async url => (await db.select({ etag: webDocuments.etag, lastModified: webDocuments.lastModified }).from(webDocuments).where(eq(webDocuments.url, url)).orderBy(desc(webDocuments.fetchedAt)).limit(1))[0],
    save: async page => (await db.insert(webDocuments).values(page).onConflictDoNothing().returning({ id: webDocuments.id }))[0]?.id ?? null,
  } : (() => { throw new Error('A database or a store is required'); })());
  const agentToken = (userAgent.split(/[\s/]/)[0] ?? userAgent).toLowerCase();
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const minDelayMs = options.minDelayMs ?? 2000;
  const maxBytes = options.maxBytes ?? 80 * 1024 * 1024;
  const nextStart = new Map<string, number>();
  const robots = new Map<string, Promise<Rule[] | 'unreachable'>>();

  const allowedHost = (url: URL) => {
    if (options.hostAllowed) return options.hostAllowed(url);
    const host = url.hostname.replace(/\.$/, '');
    return domains.some(d => host === d || host.endsWith(`.${d}`));
  };

  async function request(url: URL, init: { headers?: Record<string, string>; redirect: RequestRedirect; timeoutMs: number }) {
    const at = performance.now();
    const start = Math.max(at, nextStart.get(url.hostname) ?? 0);
    nextStart.set(url.hostname, start + minDelayMs);
    if (start > at) await sleep(start - at);
    return fetcher(url, { headers: { 'user-agent': userAgent, ...init.headers }, redirect: init.redirect, signal: AbortSignal.timeout(init.timeoutMs) });
  }

  function robotsFor(url: URL) {
    let rules = robots.get(url.origin);
    if (!rules) { rules = loadRobots(url); robots.set(url.origin, rules); }
    return rules;
  }
  async function loadRobots(url: URL): Promise<Rule[] | 'unreachable'> {
    try {
      const response = await request(new URL('/robots.txt', url.origin), { redirect: 'follow', timeoutMs: 30_000 });
      if (response.ok) return robotsRules(await response.text(), agentToken);
      // RFC 9309: a 4xx means there are no rules, and a server error means everything is disallowed.
      return response.status >= 400 && response.status < 500 && response.status !== 429 ? [] : 'unreachable';
    } catch { return 'unreachable'; }
  }

  /** Follows redirects by hand, so every hop passes the same checks as the first URL. */
  async function fetchDocument(first: URL, headers: Record<string, string>): Promise<{ response: Response; finalUrl: URL } | Rejected> {
    let url = first;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:') return { reason: 'not_https' };
      if (!allowedHost(url)) return { reason: hop === 0 ? 'not_allowed_domain' : 'redirected_off_allow_list' };
      const rules = await robotsFor(url);
      if (rules === 'unreachable' || !robotsAllow(rules, url.pathname + url.search)) return { reason: 'robots_disallowed' };
      let response: Response;
      try { response = await request(url, { headers, redirect: 'manual', timeoutMs: 600_000 }); }
      catch { return { reason: 'fetch_failed' }; }
      const location = response.headers.get('location');
      if (!redirects.has(response.status) || !location) return { response, finalUrl: url };
      await discard(response);
      if (hop === maxRedirects) return { reason: 'too_many_redirects' };
      try { url = new URL(location, url); } catch { return { reason: 'invalid_url' }; }
      url.hash = '';
    }
  }

  async function syncUrl(raw: string, input: Input): Promise<WebReportsSyncReport['stored'][number] | 'unchanged' | Rejected> {
    let url: URL;
    try { url = new URL(raw); } catch { return { reason: 'invalid_url' }; }
    url.hash = '';
    const previous = await store.previous(url.href);
    const conditional: Record<string, string> = {};
    if (previous?.etag) conditional['if-none-match'] = previous.etag;
    if (previous?.lastModified) conditional['if-modified-since'] = previous.lastModified;
    const fetched = await fetchDocument(url, conditional);
    if ('reason' in fetched) return fetched;
    const { response, finalUrl } = fetched;
    if (response.status === 304 && previous) return 'unchanged';
    const reject = async (reason: WebReportRejection): Promise<Rejected> => { await discard(response); return { reason }; };
    if (response.status === 401 || response.status === 403) return reject('login_required');
    if (!response.ok) return reject(`http_${response.status}`);
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const kind = kinds.get(contentType);
    if (!kind) return reject('unsupported_content_type');
    if (Number(response.headers.get('content-length')) > maxBytes) return reject('too_large');

    let bytes: Uint8Array | 'too_large';
    try { bytes = await readBody(response, maxBytes); } catch { return { reason: 'fetch_failed' }; }
    if (bytes === 'too_large') return { reason: 'too_large' };
    const byteSize = bytes.byteLength;
    const rawSha256 = createHash('sha256').update(bytes).digest('hex');
    let extracted: { text: string; headings: Heading[]; pages: number | null };
    try { extracted = kind === 'pdf' ? await pdfText(bytes) : { ...htmlToText(new TextDecoder().decode(bytes).replaceAll('\u0000', '')), pages: null }; }
    catch { return { reason: 'extract_failed' }; }
    const { text, headings, pages } = extracted;
    if (text.length < minChars) return { reason: 'too_little_text' };
    const head = text.slice(0, mentionWindow).toLowerCase();
    if (!input.mustMention.some(name => head.includes(name.toLowerCase()))) return { reason: 'wrong_company' };

    const fetchedAt = now();
    const id = await store.save({
      url: url.href, finalUrl: finalUrl.href, contentType, byteSize, rawSha256,
      etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
      text, headings, extractor: kind === 'pdf' ? `unpdf@${unpdfVersion}` : 'core-html',
      issuerKey: input.issuerKey, entityName: input.entityName, periodEnd: input.periodEnd ?? null,
      fetchedAt, availableOn: fetchedAt.toISOString().slice(0, 10), attemptId: input.attemptId ?? null,
    });
    return id ? { url: raw, id, pages, chars: text.length } : 'unchanged';
  }

  return {
    id: 'web_reports', capabilities: ['filings'] as const,
    async sync(input) {
      const parsed = inputSchema.parse(input);
      const report: WebReportsSyncReport = { stored: [], unchanged: [], rejected: [] };
      for (const url of parsed.urls) {
        const outcome = await syncUrl(url, parsed);
        if (outcome === 'unchanged') report.unchanged.push(url);
        else if ('reason' in outcome) report.rejected.push({ url, reason: outcome.reason });
        else report.stored.push(outcome);
      }
      return report;
    },
  };
}

/** Rules from the groups that name our agent token, or from the `*` groups when none does (RFC 9309). */
function robotsRules(body: string, token: string): Rule[] {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let group: { agents: string[]; rules: Rule[] } | undefined;
  let inRules = false;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const match = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(line.replace(/#.*/, ''));
    const key = match?.[1]?.toLowerCase(), value = match?.[2] ?? '';
    if (key === 'user-agent') {
      if (!group || inRules) { group = { agents: [], rules: [] }; groups.push(group); inRules = false; }
      group.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && group) {
      inRules = true;
      if (value) group.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const own = groups.filter(g => g.agents.includes(token));
  return (own.length > 0 ? own : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
}

/** The longest matching rule wins, and Allow wins a tie. A path no rule matches is allowed. */
function robotsAllow(rules: Rule[], path: string) {
  let best: Rule | undefined;
  for (const rule of rules) {
    const anchored = rule.pattern.endsWith('$');
    const body = (anchored ? rule.pattern.slice(0, -1) : rule.pattern).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (!new RegExp(`^${body}${anchored ? '$' : ''}`).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}

/** Reads into a new buffer of its own, because PDF.js detaches the buffer it is given. */
async function readBody(response: Response, maxBytes: number): Promise<Uint8Array | 'too_large'> {
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); return 'too_large'; }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  return bytes;
}

/** Joins the pages with a blank line and marks the start of each page with a `Page N` heading. */
async function pdfText(bytes: Uint8Array) {
  const { totalPages, text: pages } = await extractText(bytes, { mergePages: false });
  const headings: Heading[] = [];
  let text = '';
  pages.forEach((page, i) => {
    if (i > 0) text += '\n\n';
    headings.push({ offset: text.length, level: 1, title: `Page ${i + 1}` });
    text += page.replaceAll('\u0000', '').trim();
  });
  return { text, headings, pages: totalPages };
}
