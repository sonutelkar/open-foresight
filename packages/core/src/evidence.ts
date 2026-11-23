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

/** The method names a person reads. The ids stay internal. */
export const methodNames: Record<string, string> = { quant: 'Quant', extract_then_quant: 'Extract then quant', judgement: 'Judgement' };
export const methodName = (method: string) => methodNames[method] ?? method.replaceAll('_', ' ');

/** What each term on a basket means, in one sentence each. The numbers match packages/core/src/basket.ts and score.ts. */
export const glossary = {
  score: 'The theme score, 0 to 1: each KPI level divided by 4, times that KPI\'s weight, added up. It measures exposure to the theme, not expected return.',
  confidence: 'How well the evidence backs the score, 0 to 1, weighted like the score. It is computed from the quotes, not asked of the model: more quotes, more documents and recent passages raise it, and conflicts lower it.',
  level: 'How strongly one KPI shows in a company, from 0 (no sign of it) to 4 (central to the business). Each KPI\'s rubric says what each level means.',
  unknown: 'The evidence did not support a level. A strict run counts it as level 0. A broad run leaves it out and rescales the other weights, and caps the score at 0.8 when more than half the weight is unknown.',
  quant: 'Computed in code from stored numbers, with no model involved.',
  extract_then_quant: 'The model reads one number out of a filing and quotes it, then code turns that number into a level using the KPI\'s thresholds.',
  judgement: 'The model picks a level against the KPI\'s rubric and quotes the passages it relied on.',
  mustPass: 'A KPI a name must score above level 0 on to stay in the basket. A name with no evidence on it is dropped too.',
} as const;

/** The status a person reads on a run. The raw status stays in the API. */
export const statusNames: Record<string, string> = { draft: 'Starting', universe_built: 'Starting', designing: 'Designing', awaiting_kpi_approval: 'Awaiting your approval', prescreening: 'Scoring', analysing: 'Scoring', packaging: 'Building the basket', done: 'Basket ready', failed: 'Failed' };

/** A stage as a person reads it, such as `awaiting_kpi_approval` as "KPI approval". */
export const stageName = (stage: string) => {
  const s = stage.replace(/^awaiting_/, '').replaceAll('_', ' ');
  return /^kpi\b/.test(s) ? `KPI${s.slice(3)}` : s.replace(/^./, c => c.toUpperCase());
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-11-23` as "23 Nov 2026". Anything that is not a plain date comes back unchanged. */
export function formatDay(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}

/** One line that tells two runs of one theme apart. Parts that are not known yet are left out. */
export function runContextLine(input: { exposureStyle?: string; asOf?: string; names?: number; capPercent?: number; started?: string }) {
  const style = input.exposureStyle === 'strict' ? 'Strict' : input.exposureStyle === 'broad' ? 'Broad' : undefined;
  return [
    style,
    input.asOf ? `as of ${formatDay(input.asOf)}` : undefined,
    input.names !== undefined ? `${input.names} ${input.names === 1 ? 'name' : 'names'}` : undefined,
    input.capPercent !== undefined && Number.isFinite(input.capPercent) ? `cap ${input.capPercent}%` : undefined,
    input.started ? `started ${input.started}` : undefined,
  ].filter(Boolean).join(', ');
}

/** The decision line on an approved framework: "Approved at KPI approval by Ada Analyst". */
export function decisionText(d: { userId: string; action: string; stage: string; reason?: string | null }) {
  const verb = d.action === 'approve' ? 'Approved' : d.action === 'reject' ? 'Rejected' : d.action.replace(/^./, c => c.toUpperCase());
  return `${verb} at ${stageName(d.stage)} by ${d.userId}${d.reason ? ` · ${d.reason}` : ''}`;
}
