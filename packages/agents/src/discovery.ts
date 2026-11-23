import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { onAllowList, type ReportSource } from '@open-foresight/core';
import { reportDiscoveryAttempts, webDocuments } from '@open-foresight/db';
import type { DiscoveryResult } from '@open-foresight/llm';

export const discoveryPromptVersion = 'report-discovery@v1';

/** The part of `createDiscoverer` the discovery step uses. */
export type ReportDiscoverer = { model: string; discover(prompt: string): Promise<DiscoveryResult> };
/** The part of `createWebReportsProvider` the discovery step uses. */
export type ReportFetcher = {
  sync(input: { issuerKey: string; entityName: string; mustMention: string[]; urls: string[]; attemptId?: string }): Promise<unknown>;
};
type FetchReport = { stored: Array<{ url: string }>; unchanged: string[]; rejected: Array<{ url: string; reason: string }> };

const candidates = z.object({ candidates: z.array(z.object({ url: z.string().url(), kind: z.string().optional(), period_end: z.string().optional() }).passthrough()).max(8) }).passthrough();

/** The question for one company. The model only proposes URLs. It does not read the page or judge it. */
export const discoveryPrompt = (s: ReportSource) => `Find the official URL of the latest annual report of ${s.entityName} as a PDF or an ESEF XHTML package. Only use pages on ${s.domains.join(' or ')}. Do not use a login, a paywall or a third party site. Answer with JSON only, with up to 3 candidates, newest report first: {"candidates":[{"url":"https://...","kind":"pdf|esef","period_end":"YYYY-MM-DD"}]}`;

/** Reads the JSON object a model answered with, even when it is wrapped in a code fence or a sentence. */
export function parseCandidates(text: string): { urls: string[] } | { error: string } {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'The answer has no JSON object' };
  try {
    const parsed = candidates.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? { urls: [...new Set(parsed.data.candidates.map(c => c.url))] } : { error: `The JSON does not match: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  } catch { return { error: 'The answer is not valid JSON' }; }
}

export type DiscoveryOutcome = 'stored' | 'no_candidates' | 'all_rejected' | 'error' | 'already_stored' | 'cooling_down';

/**
 * Finds a report for one company and stores it, or says why not. It never throws for a model, network or page failure, so a batch continues.
 * A company that already has a stored report is skipped, and so is one whose last attempt was less than `cooldownDays` ago and did not store a report.
 * Every other attempt is recorded in `report_discovery_attempts` with the model call, whatever the outcome.
 * The model's URLs are filtered to the company's allow-list here, and the fetcher checks them again, because the model is not trusted.
 */
export async function discoverReport(input: { db: PostgresJsDatabase; discoverer: ReportDiscoverer; fetcher: ReportFetcher; source: ReportSource; cooldownDays?: number; now?: () => Date }): Promise<{ outcome: DiscoveryOutcome; stored: number; detail?: string }> {
  const { db, source } = input;
  const now = input.now ?? (() => new Date());
  const have = await db.select({ id: webDocuments.id }).from(webDocuments).where(eq(webDocuments.issuerKey, source.issuerKey)).limit(1);
  if (have.length > 0) return { outcome: 'already_stored', stored: 0 };
  const [last] = await db.select({ at: reportDiscoveryAttempts.createdAt }).from(reportDiscoveryAttempts).where(eq(reportDiscoveryAttempts.issuerKey, source.issuerKey)).orderBy(desc(reportDiscoveryAttempts.createdAt)).limit(1);
  const cooldownMs = (input.cooldownDays ?? 7) * 86_400_000;
  if (last && now().getTime() - last.at.getTime() < cooldownMs) return { outcome: 'cooling_down', stored: 0 };

  const id = randomUUID();
  const record = (outcome: DiscoveryOutcome, extra: { candidates?: string[]; rejected?: unknown[]; result?: DiscoveryResult; error?: string }) => db.insert(reportDiscoveryAttempts).values({
    id, issuerKey: source.issuerKey, entityName: source.entityName, outcome, candidates: extra.candidates ?? [], rejected: extra.rejected ?? [],
    promptVersion: discoveryPromptVersion, model: extra.result?.model ?? input.discoverer.model, provider: extra.result?.provider ?? null, zdr: extra.result?.zdr ?? null,
    params: extra.result?.params ?? null, response: extra.result ? { text: extra.result.text, citedUrls: extra.result.citedUrls } : null, error: extra.error ?? null,
    tokens: extra.result?.usage ?? null, cost: extra.result?.cost == null ? null : String(extra.result.cost), latencyMs: extra.result?.latencyMs ?? null, createdAt: now(),
  });

  let result: DiscoveryResult;
  try { result = await input.discoverer.discover(discoveryPrompt(source)); }
  catch (error) { const message = error instanceof Error ? error.message : 'unknown'; await record('error', { error: message }); return { outcome: 'error', stored: 0, detail: message }; }
  const parsed = parseCandidates(result.text);
  if ('error' in parsed) { await record('error', { result, error: parsed.error }); return { outcome: 'error', stored: 0, detail: parsed.error }; }
  if (parsed.urls.length === 0) { await record('no_candidates', { result }); return { outcome: 'no_candidates', stored: 0 }; }

  const rejected: Array<{ url: string; reason: string }> = [];
  const urls = parsed.urls.filter(u => onAllowList(u, source.domains) || (rejected.push({ url: u, reason: 'not_allowed_domain' }), false));
  let fetched: FetchReport = { stored: [], unchanged: [], rejected: [] };
  if (urls.length > 0) {
    try { fetched = await input.fetcher.sync({ issuerKey: source.issuerKey, entityName: source.entityName, mustMention: [...source.mustMention], urls, attemptId: id }) as FetchReport; }
    catch (error) { const message = error instanceof Error ? error.message : 'unknown'; await record('error', { candidates: parsed.urls, rejected, result, error: message }); return { outcome: 'error', stored: 0, detail: message }; }
  }
  const all = [...rejected, ...fetched.rejected];
  const stored = fetched.stored.length + fetched.unchanged.length;
  const outcome: DiscoveryOutcome = stored > 0 ? 'stored' : 'all_rejected';
  await record(outcome, { candidates: parsed.urls, rejected: all, result });
  return { outcome, stored: fetched.stored.length, detail: all.map(r => `${r.url} ${r.reason}`).join('; ') || undefined };
}

