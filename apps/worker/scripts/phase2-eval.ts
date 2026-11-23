// Phase 2 evaluation runner (PR 18 and PR 19).
//   --mode validate --data <dir> [--allow-fixture]   checks the label manifests of a release directory. Exits nonzero for missing, provisional,
//                                                    incomplete, duplicate or non-independent data. --allow-fixture only lets a checked-in fixture through, to test the CLI.
//   --mode metrics  --data <file.json> [--strict]     computes kappa, agreement, stability, Reviewer catch and false alarm, pre-screen recall and precision,
//                                                    name masking and leakage probes, with denominators. --strict exits nonzero unless every gate present passes.
//   --mode reviewer --data <dir> [--cache on|off] [--allow-fixture]
//                                                    live: reviews every flawed and clean score of the release reviewer manifest with the configured Reviewer,
//                                                    through the gateway, and saves each review. Each record id is a kpi_scores id in DATABASE_URL, and its
//                                                    evidenceIds are the chunks that score cites. Needs DATABASE_URL and OPENROUTER_API_KEY. Prints catch and
//                                                    false-alarm denominators and exits nonzero below 80% catch or on any record without a verdict.
//                                                    A missing release directory or credential is BLOCKED before any network or database call.
//   --mode reviewer-fixture --data <file.json> [--strict]
//                                                    offline: replays recorded Reviewer answers through the Reviewer's output schema and reports the same
//                                                    metrics. --strict exits nonzero unless the catch gate passes.
// The prescreen mode arrives with PR 24.
import { planReviewerRun, reviewerResult, runPhase2, type Phase2Result, type ReviewerOutcome } from '@open-foresight/evals';

async function runReviewer(args: string[]): Promise<Phase2Result> {
  const planned = planReviewerRun(args, process.env);
  if (!planned.ok) return planned.result;
  const { plan } = planned;
  // Loaded only here, so the offline modes start as fast as before and a BLOCKED run never loads the database or gateway code.
  const [{ drizzle }, { default: postgres }, { loadReviewerInput, reviewerRoute, reviewScore }, { createGateway }, { decisionModels, models }] = await Promise.all([
    import('drizzle-orm/postgres-js'), import('postgres'), import('@open-foresight/agents'), import('@open-foresight/llm'), import('../../../config/models.js'),
  ]);
  const route = reviewerRoute([...models, ...decisionModels]);
  const sql = postgres(plan.databaseUrl, { max: 4 });
  try {
    const db = drizzle(sql);
    const gateway = await createGateway({ apiKey: plan.apiKey, models: [route], db });
    const outcomes: Record<string, ReviewerOutcome> = {};
    await Promise.all(plan.records.map(async record => {
      try {
        const { runId, input } = await loadReviewerInput(db, record.id);
        const cited = input.passages.map(p => p.chunkId).sort().join(', '), labelled = [...record.evidenceIds].sort().join(', ');
        if (cited !== labelled) throw new Error(`the score cites ${cited || 'nothing'}, the manifest lists ${labelled}`);
        const { review, provider } = await reviewScore({ db, gateway, runId, cache: plan.cache }, record.id, input);
        outcomes[record.id] = { ok: true, review, provider };
      } catch (error) {
        outcomes[record.id] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return reviewerResult(`${plan.provenance}, ${route.model}, cache ${plan.cache ? 'on' : 'off'}`, plan.records, outcomes, { strict: true });
  } finally {
    await sql.end();
  }
}

const args = process.argv.slice(2);
const { code, stdout, stderr } = args[args.indexOf('--mode') + 1] === 'reviewer' ? await runReviewer(args) : runPhase2(args);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
process.exitCode = code;
