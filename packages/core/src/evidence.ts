/** Where a cited passage can be read in its original form. */
export const esefIndexUrl = 'https://filings.xbrl.org';

/** The public link to an ESEF report. The index stores the path only. */
export const esefReportLink = (reportUrl: string) => (/^https?:\/\//.test(reportUrl) ? reportUrl : `${esefIndexUrl}${reportUrl.startsWith('/') ? '' : '/'}${reportUrl}`);

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** True when the quote the model gave is a verbatim part of the stored passage, ignoring whitespace and case. */
export const quoteInPassage = (quote: string, passage: string) => { const q = squash(quote); return q.length > 0 && squash(passage).includes(q); };

/** A score from 0 to 1 shown to three places. */
export const formatScore = (score: number) => (Number.isFinite(score) ? score.toFixed(3) : 'n/a');

/** A KPI level for display. `unknown` means the evidence did not support a score. */
export const levelText = (level: string) => (level === 'unknown' ? 'Unknown' : `Level ${level} of 4`);

export type BasketView = 'pending' | 'failed' | 'empty' | 'ready';
/** What the basket section of a run page should show. A finished basket with no members is empty, which is not the same as no basket yet. */
export function basketView(run: { status: string }, basket: { members: readonly unknown[] } | null): BasketView {
  if (run.status === 'failed') return 'failed';
  if (!basket) return 'pending';
  return basket.members.length === 0 ? 'empty' : 'ready';
}

export const reviewLimitation = 'Provisional basket. Phase 1 has no Reviewer and no final approval, so no analyst has checked these scores or sources against the filings. Read each quote in its source before relying on it.';
