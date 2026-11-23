import { z } from 'zod';
import { reviewerInputSchema, reviewFromOutput, reviewOutputSchema, type Review } from '@open-foresight/core';
import type { ReviewerRecord } from './manifest.js';
import { buildMetricsReport } from './metrics.js';

/** The Reviewer's answer for one record, or why there is none. A record with no outcome at all is missing. */
export type ReviewerOutcome = { ok: true; review: Review; provider?: string | null } | { ok: false; error: string };

/** Recorded Reviewer calls for the offline `reviewer-fixture` mode: a reviewer manifest, and per record the input sent and the message content the model returned. */
export const reviewerFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.string().min(1),
  manifest: z.unknown(),
  calls: z.record(z.string(), z.object({ input: reviewerInputSchema, response: z.string() }).strict()),
}).strict();
export type ReviewerFixture = z.infer<typeof reviewerFixtureSchema>;

/** Parses each recorded answer as the gateway does, JSON then the Reviewer's output schema. An answer that fails either is an invalid output and gives no verdict. */
export function replayReviewerFixture(fixture: ReviewerFixture, records: readonly ReviewerRecord[]): Record<string, ReviewerOutcome> {
  const outcomes: Record<string, ReviewerOutcome> = {};
  for (const r of records) {
    if (!Object.hasOwn(fixture.calls, r.id)) continue;
    let json: unknown;
    try { json = JSON.parse(fixture.calls[r.id]!.response); } catch { outcomes[r.id] = { ok: false, error: 'invalid output: not JSON' }; continue; }
    const parsed = reviewOutputSchema.safeParse(json);
    outcomes[r.id] = parsed.success ? { ok: true, review: reviewFromOutput(parsed.data) } : { ok: false, error: `invalid output: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` };
  }
  return outcomes;
}

const share = (k: number, n: number) => (n === 0 ? 'undefined' : (k / n).toFixed(3));
const tally = (values: readonly string[]) => Object.entries(values.reduce<Record<string, number>>((t, v) => ({ ...t, [v]: (t[v] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

/**
 * Scores the Reviewer against the labels. A retry or escalate flags the score. A record with no verdict counts as missing, so the gate is incomplete.
 * With `strict` the exit code is nonzero unless the catch gate passes.
 */
export function reviewerResult(provenance: string, records: readonly ReviewerRecord[], outcomes: Readonly<Record<string, ReviewerOutcome>>, options: { strict: boolean }) {
  const verdicts: Record<string, { flagged: boolean }> = {};
  const reviewsGiven: Review[] = [];
  const providers: string[] = [];
  const failures: string[] = [];
  for (const r of records) {
    const o = Object.hasOwn(outcomes, r.id) ? outcomes[r.id]! : { ok: false as const, error: 'no answer recorded' };
    if (!o.ok) { failures.push(`${r.id}: ${o.error}`); continue; }
    verdicts[r.id] = { flagged: o.review.verdict !== 'accept' };
    reviewsGiven.push(o.review);
    if (o.provider) providers.push(o.provider);
  }
  const report = buildMetricsReport({ schemaVersion: 1, provenance, reviewer: { records: [...records], verdicts } });
  const m = report.reviewer!, gate = report.gates.reviewerCatch!;
  const flawedAnswered = m.flawed.n - m.flawed.missing, cleanAnswered = m.clean.n - m.clean.missing;
  const lines = [
    `Reviewer evaluation: ${provenance}`,
    `  catch:       ${m.flawed.caught} / ${flawedAnswered} flawed scores with a verdict = ${share(m.flawed.caught, flawedAnswered)} (${m.flawed.n} flawed, ${m.flawed.missing} without a verdict)`,
    `  false alarm: ${m.clean.falseAlarms} / ${cleanAnswered} clean scores with a verdict = ${share(m.clean.falseAlarms, cleanAnswered)} (${m.clean.n} clean, ${m.clean.missing} without a verdict)`,
    `  verdicts:    ${tally(reviewsGiven.map(r => r.verdict))}`,
    `  issues:      ${tally(reviewsGiven.map(r => r.issue))}`,
    ...(providers.length ? [`  providers:   ${tally(providers)}`] : []),
    `  no verdict:  ${failures.length}${failures.map(f => `\n    ${f}`).join('')}`,
    `  gate:        ${gate.status}. ${gate.reason}`,
  ];
  return { code: options.strict && gate.status !== 'pass' ? 1 : 0, stdout: `${lines.join('\n')}\n${JSON.stringify(report, null, 2)}\n`, stderr: '' };
}
