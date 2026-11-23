import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewerRecord } from './manifest.js';
import { buildMetricsReport, metricsInputSchema } from './metrics.js';
import { replayReviewerFixture, reviewerFixtureSchema, reviewerResult } from './reviewer.js';
import { parseManifest, validateReleaseSet } from './validate.js';

export type Phase2Result = { code: number; stdout: string; stderr: string };
type Env = Readonly<Record<string, string | undefined>>;
const modes = ['validate', 'metrics', 'reviewer', 'reviewer-fixture'] as const;
const usage = 'Usage: phase2-eval.ts --mode validate --data <dir> [--allow-fixture] | --mode metrics --data <file.json> [--strict]'
  + ' | --mode reviewer --data <dir> [--cache on|off] [--allow-fixture] | --mode reviewer-fixture --data <file.json> [--strict]';

function parseArgs(args: readonly string[]): { mode?: string; data?: string; cache: 'on' | 'off'; flags: Set<string> } {
  const out: { mode?: string; data?: string; cache: 'on' | 'off'; flags: Set<string> } = { cache: 'on', flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--mode') out.mode = args[++i];
    else if (a === '--data') out.data = args[++i];
    else if (a === '--cache') {
      const v = args[++i];
      if (v !== 'on' && v !== 'off') throw new Error(`--cache takes on or off. ${usage}`);
      out.cache = v;
    } else if (a === '--allow-fixture' || a === '--strict') out.flags.add(a);
    else throw new Error(`Unknown argument ${a}. ${usage}`);
  }
  return out;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const issues = (error: { issues: Array<{ path: Array<string | number>; message: string }> }) => error.issues.map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');

/** Reads every manifest of a release directory and validates the set. `errors` includes files that are not JSON. */
function readRelease(dir: string, allowFixture: boolean) {
  const names = readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  const files = names.map(name => { try { return { name, raw: readJson(join(dir, name)) }; } catch (e) { return { name, raw: null as unknown, parseError: e instanceof Error ? e.message : String(e) }; } });
  const parsed = files.filter(f => !('parseError' in f));
  const result = validateReleaseSet(parsed, { allowFixture });
  return { names, raws: parsed.map(f => f.raw), errors: [...files.flatMap(f => ('parseError' in f ? [`${f.name}: not valid JSON: ${f.parseError}`] : [])), ...result.errors] };
}

export type ReviewerPlan = { provenance: string; records: ReviewerRecord[]; cache: boolean; databaseUrl: string; apiKey: string };

/**
 * Everything the live `reviewer` mode checks before it may touch the network or the database: the release directory, a valid release set,
 * the database credentials and the OpenRouter key. Anything missing is BLOCKED, invalid data is FAIL, and neither makes a call.
 */
export function planReviewerRun(args: readonly string[], env: Env): { ok: true; plan: ReviewerPlan } | { ok: false; result: Phase2Result } {
  const { data, cache, flags } = parseArgs(args);
  if (!data) return { ok: false, result: { code: 2, stdout: '', stderr: usage } };
  const blocked: string[] = [];
  const hasDir = existsSync(data) && statSync(data).isDirectory();
  if (!hasDir) blocked.push(`the release data directory ${data} does not exist, so there are no labelled flawed scores to review`);
  if (!env.DATABASE_URL?.trim()) blocked.push('DATABASE_URL is not set, so the scores and passages cannot be read');
  if (!env.OPENROUTER_API_KEY?.trim()) blocked.push('OPENROUTER_API_KEY is not set');
  const release = hasDir ? readRelease(data, flags.has('--allow-fixture')) : null;
  const problems = release?.errors.map(e => `  - ${e}`).join('\n') ?? '';
  if (blocked.length) return { ok: false, result: { code: 1, stdout: '', stderr: `BLOCKED: ${blocked.join('; ')}. No model call was made.\n${problems && `${problems}\n`}` } };
  if (release!.errors.length) return { ok: false, result: { code: 1, stdout: '', stderr: `FAIL ${release!.errors.length} problems in ${data}. No model call was made.\n${problems}\n` } };
  const manifest = release!.raws.map(raw => parseManifest(raw).manifest).find(m => m?.kind === 'reviewer');
  if (manifest?.kind !== 'reviewer') throw new Error('A valid release set has a reviewer manifest');
  return {
    ok: true,
    plan: { provenance: `${manifest.manifestId} v${manifest.version}, ${manifest.provenance}${manifest.fixture ? ', fixture' : ''}`, records: manifest.records, cache: cache === 'on', databaseUrl: env.DATABASE_URL!, apiKey: env.OPENROUTER_API_KEY! },
  };
}

/**
 * The Phase 2 eval CLI, except the network half of `reviewer`: that runs from apps/worker/scripts/phase2-eval.ts, which has the gateway and the database.
 * Here `reviewer` only runs the checks of `planReviewerRun`. The `prescreen` mode belongs to PR 24 and is refused.
 */
export function runPhase2(args: readonly string[], env: Env = process.env): Phase2Result {
  try {
    const { mode, data, flags } = parseArgs(args);
    if (!mode || !data) return { code: 2, stdout: '', stderr: usage };
    if (!(modes as readonly string[]).includes(mode)) return { code: 2, stdout: '', stderr: `Mode "${mode}" is not implemented. ${usage}` };
    if (mode === 'reviewer') {
      const planned = planReviewerRun(args, env);
      return planned.ok ? { code: 2, stdout: '', stderr: 'The live reviewer mode calls the model, so it runs only from apps/worker/scripts/phase2-eval.ts.' } : planned.result;
    }
    if (!existsSync(data)) return { code: 1, stdout: '', stderr: `FAIL: ${data} does not exist` };

    if (mode === 'validate') {
      if (!statSync(data).isDirectory()) return { code: 2, stdout: '', stderr: `--data must be a directory of manifests for validate. ${usage}` };
      const { names, errors } = readRelease(data, flags.has('--allow-fixture'));
      if (errors.length === 0) return { code: 0, stdout: `OK ${names.length} manifests valid in ${data}\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: `FAIL ${errors.length} problems in ${data}\n${errors.map(e => `  - ${e}`).join('\n')}\n` };
    }

    if (statSync(data).isDirectory()) return { code: 2, stdout: '', stderr: `--data must be a JSON file for ${mode}. ${usage}` };
    if (mode === 'reviewer-fixture') {
      const fixture = reviewerFixtureSchema.safeParse(readJson(data));
      if (!fixture.success) return { code: 1, stdout: '', stderr: `FAIL invalid reviewer fixture\n${issues(fixture.error)}\n` };
      const { manifest, errors } = parseManifest(fixture.data.manifest);
      if (manifest?.kind !== 'reviewer' || errors.length) return { code: 1, stdout: '', stderr: `FAIL the fixture's manifest is not a valid reviewer manifest\n${errors.map(e => `  - ${e}`).join('\n')}\n` };
      return reviewerResult(fixture.data.provenance, manifest.records, replayReviewerFixture(fixture.data, manifest.records), { strict: flags.has('--strict') });
    }

    const parsed = metricsInputSchema.safeParse(readJson(data));
    if (!parsed.success) return { code: 1, stdout: '', stderr: `FAIL invalid metrics input\n${issues(parsed.error)}\n` };
    const report = buildMetricsReport(parsed.data);
    const gates = Object.values(report.gates).filter(g => g !== null);
    const failing = gates.length === 0 || gates.some(g => g.status !== 'pass');
    return { code: flags.has('--strict') && failing ? 1 : 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
  } catch (e) {
    return { code: 1, stdout: '', stderr: `FAIL ${e instanceof Error ? e.message : String(e)}\n` };
  }
}
