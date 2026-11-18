import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function run(fixture: unknown, baseline: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'foresight-eval-'));
  directories.push(directory);
  const fixturePath = join(directory, 'fixture.json');
  const baselinePath = join(directory, 'baseline.json');
  const outputPath = join(directory, 'result.json');
  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(baselinePath, JSON.stringify(baseline));
  const process = spawnSync('bun', [resolve('src/cli.ts'), fixturePath, baselinePath, outputPath], { encoding: 'utf8' });
  return { process, outputPath };
}

const fixture = {
  schemaVersion: 1, suiteId: 'pilot',
  cases: [{ id: 'a', expected: 'yes', actual: 'yes' }, { id: 'b', expected: 'no', actual: 'yes' }],
};
const baseline = { schemaVersion: 1, suiteId: 'pilot', metric: 'exact_match_rate', value: 0.5, minimum: 0.5, maxDrop: 0 };

it('writes versioned case results and exits successfully when checks pass', () => {
  const { process, outputPath } = run(fixture, baseline);
  expect(process.status).toBe(0);
  expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
    schemaVersion: 1, suiteId: 'pilot', metric: 'exact_match_rate', value: 0.5,
    passedCases: 1, totalCases: 2, passed: true,
    cases: [{ id: 'a', passed: true }, { id: 'b', passed: false }],
  });
});

it('writes failed results and exits nonzero when minimum or baseline regression fails', () => {
  for (const failing of [{ ...baseline, minimum: 0.6 }, { ...baseline, value: 0.6 }]) {
    const { process, outputPath } = run(fixture, failing);
    expect(process.status).toBe(1);
    expect(JSON.parse(readFileSync(outputPath, 'utf8')).passed).toBe(false);
  }
});

it('rejects missing thresholds, empty cases, duplicate IDs and mismatched suites', () => {
  const checks = [
    [fixture, { schemaVersion: 1, suiteId: 'pilot', metric: 'exact_match_rate', value: 0.5 }],
    [{ ...fixture, cases: [] }, baseline],
    [{ ...fixture, cases: [fixture.cases[0], fixture.cases[0]] }, baseline],
    [fixture, { ...baseline, suiteId: 'other' }],
  ];
  for (const [input, comparison] of checks) {
    const { process } = run(input, comparison);
    expect(process.status).toBe(1);
    expect(process.stderr).toContain('Eval failed');
  }
});

it('fails when an input file is missing and preserves an existing output', () => {
  const { outputPath } = run(fixture, baseline);
  const original = readFileSync(outputPath, 'utf8');
  const directory = resolve(outputPath, '..');
  const command = [resolve('src/cli.ts'), join(directory, 'fixture.json'), join(directory, 'baseline.json'), outputPath];
  const existing = spawnSync('bun', command, { encoding: 'utf8' });
  expect(existing.status).toBe(1);
  expect(readFileSync(outputPath, 'utf8')).toBe(original);
  const missing = spawnSync('bun', [resolve('src/cli.ts'), join(directory, 'missing.json'), command[2], join(directory, 'new.json')], { encoding: 'utf8' });
  expect(missing.status).toBe(1);
});

it('accepts an exact regression boundary and rejects a stricter one', () => {
  const tenCases = Array.from({ length: 10 }, (_, index) => ({
    id: String(index), expected: 'yes', actual: index < 7 ? 'yes' : 'no',
  }));
  const input = { ...fixture, cases: tenCases };
  const atBoundary = run(input, { ...baseline, value: 0.8, maxDrop: 0.1, minimum: 0.7 });
  expect(atBoundary.process.status).toBe(0);
  expect(JSON.parse(readFileSync(atBoundary.outputPath, 'utf8')).checks).toEqual({
    minimumPassed: true, regressionPassed: true,
  });
  const belowBoundary = run(input, { ...baseline, value: 0.8, maxDrop: 0.09999999999999999, minimum: 0.7 });
  expect(belowBoundary.process.status).toBe(1);
  expect(JSON.parse(readFileSync(belowBoundary.outputPath, 'utf8')).checks.regressionPassed).toBe(false);
});
