// Regenerates the checked-in Phase 2 fixtures from the seeded builder: packages/evals/fixtures/phase2-1000.json (the perf input)
// and packages/evals/fixtures/phase2-release/ (fixture manifests that only verify the CLI). Usage: bun apps/worker/scripts/phase2-fixture.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { perfSizes, syntheticRelease } from '@open-foresight/evals';

const dir = fileURLToPath(new URL('../../../packages/evals/fixtures/', import.meta.url));
const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
write(`${dir}phase2-1000.json`, syntheticRelease(20261123, perfSizes).metricsInput);
mkdirSync(`${dir}phase2-release`, { recursive: true });
for (const [kind, manifest] of Object.entries(syntheticRelease().manifests)) write(`${dir}phase2-release/${kind}.json`, manifest);
