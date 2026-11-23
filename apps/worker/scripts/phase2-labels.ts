// Release label generator for docs/evaluation/release (decision of 2026-11-23: AI labels from a vendor apart from every scorer and the Reviewer,
// citing web sources, and a person spot-checks a seeded 10%). Every intermediate file goes to the work directory (default docs/evaluation/labelling):
//   build-flawed     copies stored scores of a snapshot into cancelled fixture runs, injecting wrong_issuer, stale_evidence or talk_without_numbers
//   collect-sources  per label subject, report discovery's search model proposes URLs, code applies the label-source URL policy, fetches and
//                    stores each page in label_sources, and records every attempt in label_source_attempts
//   label            labels from the store and the stored pages with the `labeller` route, cache off. A label must cite a stored page when shown one.
//   sample-human     draws the seeded 10% check sheet per manifest; record-human-check reads the sheet the colleague returns
//   assemble         writes kpi.json, reviewer.json and relevance.json only when the set passes release validation
// Live commands are BLOCKED, with no database, gateway, search or fetch, until DATABASE_URL, the snapshots and theme runs are given, and for
// collect-sources and label OPENROUTER_API_KEY and --yes-spend; build-flawed also needs --yes-write. --from, --searches, --pages and --responses
// run the offline fixture path. Usage: bun apps/worker/scripts/phase2-labels.ts <command> ... (run with no command for the full usage)
import { fileURLToPath } from 'node:url';
import { runPhase2Labels } from '../src/release-labels.js';
import { decisionModels, models } from '../../../config/models.js';

const labeller = models.find(m => m.role === 'labeller');
if (!labeller) throw new Error('config/models.ts has no labeller role');
const { code, stdout, stderr } = await runPhase2Labels(process.argv.slice(2), process.env, {
  routes: { labeller, others: [...models, ...decisionModels].filter(m => m.role !== 'labeller') },
  referenceDir: fileURLToPath(new URL('../../../docs/reference/', import.meta.url)),
  async open({ databaseUrl, apiKey, use }) {
    // Loaded only here, after every gate passed, so the offline commands and a BLOCKED run never load the database, gateway or search code.
    const [{ drizzle }, { default: postgres }, store, { createDiscoverer, createGateway }] = await Promise.all([
      import('drizzle-orm/postgres-js'), import('postgres'), import('../src/release-store.js'), import('@open-foresight/llm'),
    ]);
    const sql = postgres(databaseUrl, { max: 6 });
    const db = drizzle(sql);
    try {
      return {
        extract: input => store.loadExtract(db, input),
        saveFlawed: file => store.saveFlawed(db, file),
        labelRun: snapshotIds => store.labelRun(db, snapshotIds),
        // The labeller route keeps zdr=true. The search model is report discovery's: it asks for ZDR, warns and records zdr=false when no provider serves it.
        generator: use === 'label' && apiKey ? await createGateway({ apiKey, models: [labeller], db, concurrency: 4 }) : null,
        discoverer: use === 'search' && apiKey ? createDiscoverer({ apiKey, warn: m => console.warn(`WARNING ${m}`) }) : null,
        pages: store.labelPageStore(db),
        recordAttempt: attempt => store.recordSourceAttempt(db, attempt),
        storedSources: ids => store.storedSources(db, ids),
        fetch,
        close: () => sql.end(),
      };
    } catch (error) {
      await sql.end();
      throw error;
    }
  },
});
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = code;
