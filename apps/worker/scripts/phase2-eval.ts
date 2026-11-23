// Phase 2 evaluation runner (PR 18). Two modes, both local and offline:
//   --mode validate --data <dir> [--allow-fixture]   checks the label manifests of a release directory. Exits nonzero for missing, provisional,
//                                                    incomplete, duplicate or non-independent data. --allow-fixture only lets a checked-in fixture through, to test the CLI.
//   --mode metrics  --data <file.json> [--strict]     computes kappa, agreement, stability, Reviewer catch and false alarm, pre-screen recall and precision,
//                                                    name masking and leakage probes, with denominators. --strict exits nonzero unless every gate present passes.
// The reviewer and prescreen modes arrive with PR 19 and PR 24.
import { runPhase2 } from '@open-foresight/evals';

const { code, stdout, stderr } = runPhase2(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
process.exitCode = code;
