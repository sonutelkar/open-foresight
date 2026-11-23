import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewerRecordSchema } from './manifest.js';
import { planReviewerRun, runPhase2 } from './phase2.js';
import { replayReviewerFixture, reviewerFixtureSchema, reviewerResult, type ReviewerOutcome } from './reviewer.js';
import { syntheticReviewerFixture } from './synthetic.js';

const fixturePath = new URL('../fixtures/reviewer-100.json', import.meta.url).pathname;
const releaseFixture = new URL('../fixtures/phase2-release', import.meta.url).pathname;
const env = { DATABASE_URL: 'postgres://localhost/unused', OPENROUTER_API_KEY: 'not-used' };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('reviewer-fixture mode', () => {
  it('replays 100 recorded answers and reports catch and false alarm over their own denominators', () => {
    const r = runPhase2(['--mode', 'reviewer-fixture', '--data', fixturePath]);
    expect(r.code).toBe(0);
    // By the builder's rule: 80 flawed, 4 invalid, 8 missed, so 68 of 76 caught; 20 clean, 1 invalid, 3 false alarms of 19.
    expect(r.stdout).toContain('catch:       68 / 76 flawed scores with a verdict = 0.895 (80 flawed, 4 without a verdict)');
    expect(r.stdout).toContain('false alarm: 3 / 19 clean scores with a verdict = 0.158 (20 clean, 1 without a verdict)');
    expect(r.stdout).toContain('no verdict:  5');
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(report.gates.reviewerCatch).toMatchObject({ status: 'incomplete', denominator: 76 });
    expect(runPhase2(['--mode', 'reviewer-fixture', '--data', fixturePath, '--strict']).code).toBe(1);
  });
  it('covers every verdict and issue, and counts invalid output as no verdict', () => {
    const fixture = reviewerFixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
    const records = reviewerRecordSchema.array().parse((fixture.manifest as { records: unknown }).records);
    const outcomes = Object.values(replayReviewerFixture(fixture, records));
    expect(outcomes).toHaveLength(100);
    const reviews = outcomes.flatMap(o => (o.ok ? [o.review] : []));
    expect(new Set(reviews.map(r => r.verdict))).toEqual(new Set(['accept', 'retry', 'escalate']));
    expect(new Set(reviews.map(r => r.issue))).toEqual(new Set(['none', 'unsupported_level', 'wrong_entity', 'stale_evidence', 'talk_not_numbers', 'conflict', 'other']));
    expect(outcomes.filter(o => !o.ok)).toHaveLength(5);
  });
  it('matches the seeded builder, so it cannot drift', () => {
    expect(JSON.parse(readFileSync(fixturePath, 'utf8'))).toEqual(JSON.parse(JSON.stringify(syntheticReviewerFixture())));
  });
});

describe('reviewer result', () => {
  const base = syntheticReviewerFixture().manifest.records[0]!;
  const all = Array.from({ length: 120 }, (_, i) => ({ ...base, id: `r${i}`, flaw: i < 100 ? 'wrong_issuer' as const : 'none' as const }));
  const outcomes = (caught: number): Record<string, ReviewerOutcome> => Object.fromEntries(all.map((r, i) => [r.id, {
    ok: true, review: r.flaw !== 'none' && i < caught ? { verdict: 'retry', issue: 'other', note: 'n' } : { verdict: 'accept', issue: 'none', note: 'n' },
  }]));
  it('passes at 80 of 100 caught and fails at 79', () => {
    expect(reviewerResult('t', all, outcomes(80), { strict: true }).code).toBe(0);
    const failed = reviewerResult('t', all, outcomes(79), { strict: true });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('catch:       79 / 100');
    expect(failed.stdout).toContain('gate:        fail');
  });
  it('fails a run where any record has no verdict, even with a high catch rate', () => {
    const o = outcomes(100);
    o[all[0]!.id] = { ok: false, error: 'Model call failed' };
    const r = reviewerResult('t', all, o, { strict: true });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('gate:        incomplete');
    expect(r.stdout).toContain(`${all[0]!.id}: Model call failed`);
  });
});

describe('live reviewer mode', () => {
  it('is BLOCKED without the release directory, before anything else', () => {
    const r = runPhase2(['--mode', 'reviewer', '--data', '/nonexistent/release', '--cache', 'off'], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^BLOCKED: the release data directory \/nonexistent\/release does not exist/);
    expect(r.stderr).toContain('No model call was made');
  });
  it('is BLOCKED without credentials or the OpenRouter key', () => {
    const r = runPhase2(['--mode', 'reviewer', '--data', releaseFixture, '--allow-fixture'], {});
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^BLOCKED: DATABASE_URL is not set.*; OPENROUTER_API_KEY is not set/);
    expect(runPhase2(['--mode', 'reviewer', '--data', releaseFixture, '--allow-fixture'], { DATABASE_URL: 'x' }).stderr).toMatch(/^BLOCKED: OPENROUTER_API_KEY is not set/);
  });
  it('refuses fixture or provisional release data unless allowed, and an empty directory', () => {
    expect(runPhase2(['--mode', 'reviewer', '--data', releaseFixture], env)).toMatchObject({ code: 1, stderr: expect.stringMatching(/^FAIL .*is a fixture/s) });
    const empty = mkdtempSync(join(tmpdir(), 'reviewer-')); dirs.push(empty);
    expect(runPhase2(['--mode', 'reviewer', '--data', empty], env).stderr).toContain('missing the reviewer manifest');
  });
  it('plans every flawed and clean record of a valid set, and leaves the model call to the worker script', () => {
    const planned = planReviewerRun(['--mode', 'reviewer', '--data', releaseFixture, '--allow-fixture', '--cache', 'off'], env);
    if (!planned.ok) throw new Error(planned.result.stderr);
    expect(planned.plan).toMatchObject({ cache: false, databaseUrl: env.DATABASE_URL, apiKey: env.OPENROUTER_API_KEY });
    expect(planned.plan.records.filter(r => r.flaw !== 'none')).toHaveLength(100);
    expect(planned.plan.records.filter(r => r.flaw === 'none')).toHaveLength(50);
    expect(runPhase2(['--mode', 'reviewer', '--data', releaseFixture, '--allow-fixture'], env).code).toBe(2);
    expect(runPhase2(['--mode', 'reviewer', '--data', releaseFixture, '--cache', 'maybe'], env).code).toBe(1);
  });
});
