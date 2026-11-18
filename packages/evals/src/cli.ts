import { readFile, writeFile } from 'node:fs/promises';
import { baselineSchema, evaluate, fixtureSchema } from './eval.js';

async function main(args: string[]): Promise<number> {
  if (args.length !== 3) throw new Error('Usage: node dist/cli.js <fixture.json> <baseline.json> <result.json>');
  const [fixturePath, baselinePath, outputPath] = args;
  if (!fixturePath || !baselinePath || !outputPath) throw new Error('All paths are required');
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(fixturePath, 'utf8')));
  const baseline = baselineSchema.parse(JSON.parse(await readFile(baselinePath, 'utf8')));
  const result = evaluate(fixture, baseline);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.metric}: ${result.value} (${result.passedCases}/${result.totalCases})\n`);
  return result.passed ? 0 : 1;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch((error: unknown) => {
  process.stderr.write(`Eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
