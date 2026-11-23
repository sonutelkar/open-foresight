import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildMetricsReport, metricsInputSchema } from './metrics.js';
import { validateReleaseSet } from './validate.js';

export type Phase2Result = { code: number; stdout: string; stderr: string };
const modes = ['validate', 'metrics'] as const;
const usage = 'Usage: phase2-eval.ts --mode validate --data <dir> [--allow-fixture] | --mode metrics --data <file.json> [--strict]';

function parseArgs(args: readonly string[]): { mode?: string; data?: string; flags: Set<string> } {
  const flags = new Set<string>();
  const out: { mode?: string; data?: string; flags: Set<string> } = { flags };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--mode') out.mode = args[++i];
    else if (a === '--data') out.data = args[++i];
    else if (a === '--allow-fixture' || a === '--strict') flags.add(a);
    else throw new Error(`Unknown argument ${a}. ${usage}`);
  }
  return out;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** The `validate` and `metrics` modes of the Phase 2 eval CLI. Later modes (`reviewer`, `prescreen`) belong to PR 19 and PR 24 and are refused here. */
export function runPhase2(args: readonly string[]): Phase2Result {
  try {
    const { mode, data, flags } = parseArgs(args);
    if (!mode || !data) return { code: 2, stdout: '', stderr: usage };
    if (!(modes as readonly string[]).includes(mode)) return { code: 2, stdout: '', stderr: `Mode "${mode}" is not implemented in this PR. ${usage}` };
    if (!existsSync(data)) return { code: 1, stdout: '', stderr: `FAIL: ${data} does not exist` };

    if (mode === 'validate') {
      if (!statSync(data).isDirectory()) return { code: 2, stdout: '', stderr: `--data must be a directory of manifests for validate. ${usage}` };
      const names = readdirSync(data).filter(n => n.endsWith('.json')).sort();
      const files = names.map(name => { try { return { name, raw: readJson(join(data, name)) }; } catch (e) { return { name, raw: null as unknown, parseError: e instanceof Error ? e.message : String(e) }; } });
      const result = validateReleaseSet(files.filter(f => !('parseError' in f)), { allowFixture: flags.has('--allow-fixture') });
      const errors = [...files.flatMap(f => ('parseError' in f ? [`${f.name}: not valid JSON: ${f.parseError}`] : [])), ...result.errors];
      if (errors.length === 0) return { code: 0, stdout: `OK ${names.length} manifests valid in ${data}\n`, stderr: '' };
      return { code: 1, stdout: '', stderr: `FAIL ${errors.length} problems in ${data}\n${errors.map(e => `  - ${e}`).join('\n')}\n` };
    }

    if (statSync(data).isDirectory()) return { code: 2, stdout: '', stderr: `--data must be a JSON file for metrics. ${usage}` };
    const parsed = metricsInputSchema.safeParse(readJson(data));
    if (!parsed.success) return { code: 1, stdout: '', stderr: `FAIL invalid metrics input\n${parsed.error.issues.map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}\n` };
    const report = buildMetricsReport(parsed.data);
    const gates = Object.values(report.gates).filter(g => g !== null);
    const failing = gates.length === 0 || gates.some(g => g.status !== 'pass');
    return { code: flags.has('--strict') && failing ? 1 : 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
  } catch (e) {
    return { code: 1, stdout: '', stderr: `FAIL ${e instanceof Error ? e.message : String(e)}\n` };
  }
}
