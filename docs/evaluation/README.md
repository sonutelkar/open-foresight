# Phase 2 evaluation contracts

This folder holds the label manifests that the Phase 2 gates read, and the rules for them. The code is in `packages/evals`. The runner is `apps/worker/scripts/phase2-eval.ts`.

## Release data

`docs/evaluation/release/` must hold three manifests: `kpi.json` (200 or more stock by KPI pairs), `reviewer.json` (100 or more flawed scores and at least one clean control) and `relevance.json` (500 or more labels, relevant and not). It does not exist yet. The label decisions in `docs/PHASE-2-PLAN.md` block it, so release validation fails until it does.

A manifest is versioned and immutable. `contentHash` is the sha256 of the canonical JSON of its `records`. A changed record needs a new `version`, a new hash, and `supersedes` set to the manifest it replaces.

Each manifest records provenance, themes (three or more), labellers, the vendors of every scorer it will judge, sampling (seed, requested, pool), adjudication, the human spot check, and the missing policy. Each record carries its theme, symbol, snapshot ID, evidence IDs and labeller.

## What release validation rejects

- A missing manifest, a second manifest of one kind, or a file that is not JSON.
- A schema error, a duplicate record ID, or a `contentHash` that does not match the records.
- `provisional-ai` provenance. The PR 17 labelled set is wrapped by `provisionalKpiManifest` and is accepted as a manifest, never as release data.
- `fixture: true`. Checked-in fixtures verify the tooling. `--allow-fixture` lets them through for that purpose only.
- An AI labeller from a vendor listed in `scorerVendors`, or with no vendor.
- `ai-generated-human-sampled` data with no human spot check, a reviewer-less one, or one under 10% of the records. The spec asked for independent human labels. The 2026-11-23 decision replaced that with AI labels sampled by a person. Reports must say so, and that kappa measures agreement with AI labels, not ground truth.
- `human` data with a non-human labeller, or two or more labellers and no adjudicator.
- Fewer than three themes, a theme with no records, or `sampling.pool` below the record count.

## Frozen policies

These are frozen before any live scoring. Changing one is a new manifest version.

- **Unknown.** A pair where either side says `unknown` leaves the kappa and exact agreement. It is counted under `excluded` and in the unknown rates. Stability counts `unknown` as a level, so unknown twice is identical.
- **Missing.** A record with no answer is counted, never dropped. A gate with any missing record is `incomplete`.
- **Masked-level change.** A change between two levels 0 to 4 is `changed`, and `large` at two levels or more. A change to or from `unknown` is `toUnknown` or `fromUnknown` and is never `large`. A pair only one run answered is counted apart and left out. A large change signals possible reliance on memory. It is not proof.
- **Pre-screen.** A name the screen is unsure about, or has no evidence for, counts as kept. Recall is over relevant names with a decision. Precision is relevant names kept over all names kept.
- **Gates.** A gate is `pass` only with a defined value, no missing record, and a value at or above the threshold: kappa 0.6, stability 0.95, Reviewer catch 0.8, pre-screen recall 0.95. An empty denominator is `incomplete`, never a pass.

## Probes

The leakage probe lists numbers and capitalised entities in a rationale that no cited passage holds. The mask check lists names or tickers still present in text meant to be masked. Both are signals to look at a pair, not proof of leakage.

## Commands

```
bun apps/worker/scripts/phase2-eval.ts --mode validate --data docs/evaluation/release
bun apps/worker/scripts/phase2-eval.ts --mode validate --data packages/evals/fixtures/phase2-release --allow-fixture
bun apps/worker/scripts/phase2-eval.ts --mode metrics --data packages/evals/fixtures/phase2-1000.json [--strict]
bun apps/worker/scripts/phase2-fixture.ts   # regenerates both fixtures from the seeded builder
```

`apps/worker` reads `@open-foresight/evals` from its build, so run `bun run build` in `packages/evals` after changing it. The `reviewer` and `prescreen` modes belong to PR 19 and PR 24.
