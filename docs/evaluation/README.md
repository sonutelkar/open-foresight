# Phase 2 evaluation contracts

This folder holds the label manifests that the Phase 2 gates read, and the rules for them. The code is in `packages/evals`. The runner is `apps/worker/scripts/phase2-eval.ts`.

## Release data

`docs/evaluation/release/` must hold three manifests: `kpi.json` (200 or more stock by KPI pairs), `reviewer.json` (100 or more flawed scores and at least one clean control) and `relevance.json` (500 or more labels, relevant and not). It does not exist yet. `apps/worker/scripts/phase2-labels.ts` generates it, as the next section describes. Until the live generation runs, release validation fails.

A manifest is versioned and immutable. `contentHash` is the sha256 of the canonical JSON of its `records`. A changed record needs a new `version`, a new hash, and `supersedes` set to the manifest it replaces.

Each manifest records provenance, themes (three or more), labellers, the vendors of every scorer it will judge, sampling (seed, requested, pool), adjudication, the human spot check, and the missing policy. Each record carries its theme, symbol, snapshot ID, evidence IDs and labeller, and its web citations when it has any.

## Generating the release labels

`apps/worker/scripts/phase2-labels.ts` follows the 2026-11-23 decision. The `labeller` route in `config/models.ts` writes every label. It runs `google/gemini-3.1-pro-preview`, so its vendor differs from every scorer and from the Reviewer (anthropic, openai, deepseek and typesafe). Each label cites the web pages that the generator fetched and stored for it, when it could store any. A colleague then checks a seeded 10% sample of each manifest. The code is in `packages/evals/src/release-labels.ts` and `apps/worker/src/release-labels.ts`. The database half is `apps/worker/src/release-store.ts`. Every step writes into a work directory, `docs/evaluation/labelling/` by default. Keep that directory, because it holds each label's rationale, cited passages and stored sources.

Run these steps in order. Give one `--run` for each theme, and one `--snapshot` for each snapshot that those runs use. The theme ids are `smart-energy`, `cybersecurity` and `robotics-ai`. Apply migration `0028_label_sources` first.

1. Copy stored scores into flawed scores and clean controls. This step writes rows to the database and makes no model call.

	```
	bun apps/worker/scripts/phase2-labels.ts build-flawed --snapshot "$S1" --snapshot "$S2" --snapshot "$S3" \
		--run smart-energy="$RUN_SE" --run cybersecurity="$RUN_CY" --run robotics-ai="$RUN_RA" --flawed 110 --clean 100 --yes-write
	```

2. Collect the web sources of each manifest kind. Each command prints its search and fetch count before it starts.

	```
	bun apps/worker/scripts/phase2-labels.ts collect-sources --manifest-kind reviewer --yes-spend
	bun apps/worker/scripts/phase2-labels.ts collect-sources --manifest-kind kpi --snapshot ... --run ... --yes-spend
	bun apps/worker/scripts/phase2-labels.ts collect-sources --manifest-kind relevance --snapshot ... --run ... --yes-spend
	```

3. Label the three manifests. Use the same `--seed` and `--count` as in step 2. Each command prints its call count before it calls the model.

	```
	bun apps/worker/scripts/phase2-labels.ts label --manifest-kind reviewer --yes-spend
	bun apps/worker/scripts/phase2-labels.ts label --manifest-kind kpi --snapshot ... --run ... --yes-spend
	bun apps/worker/scripts/phase2-labels.ts label --manifest-kind relevance --snapshot ... --run ... --yes-spend
	```

4. Draw the spot check sample.

	```
	bun apps/worker/scripts/phase2-labels.ts sample-human --seed 20261123
	```

5. Send `check-<kind>.csv` to the colleague, with `check-<kind>.json` for the passage texts. The colleague writes `yes` or `no` in the `agree` column of each row. Record each returned sheet.

	```
	bun apps/worker/scripts/phase2-labels.ts record-human-check --kind kpi --sheet returned-kpi.csv --reviewer "Name"
	```

6. Assemble the manifests and validate them.

	```
	bun apps/worker/scripts/phase2-labels.ts assemble --out docs/evaluation/release
	bun apps/worker/scripts/phase2-eval.ts --mode validate --data docs/evaluation/release
	```

`build-flawed` reads the latest valid score per run, security and KPI on a KPI with a rubric. A seed chooses the scores and splits them evenly over the themes, and then over the three flaws within each theme. `wrong_issuer` replaces the cited passages with passages that another issuer's score on the same KPI cites. `stale_evidence` uses passages of the same issuer from before the KPI lookback. `talk_without_numbers` uses passages of the same issuer in the window that hold no figure, at level 2 or above. A copy is kept only when core's `validateScore` and the figure check find exactly the intended flaw. Clean controls are unchanged copies. A theme and flaw that the snapshot cannot fill stops the step, and the step writes nothing. Stale flaws need filings older than the lookback, which is 730 days for most KPIs, so ingest older annual reports first. Build about 10% more flawed scores than 100, because the labeller drops the flaws that it contradicts.

Each copy is a `kpi_scores` row, so the Reviewer's `loadReviewerInput` loads it. The row belongs to a fixture run of its source run. That run has `model_profile` set to `reviewer-flawed-fixture`, and the step inserts and cancels it in one transaction. A cancelled run can never change status, so no worker scores it and no basket includes it. The labeller calls are audited under one more cancelled run with `model_profile` set to `release-labels`. A repeat of the same build finds its rows and writes nothing.

`collect-sources` follows the Phase 1 report discovery pattern. For each label subject, the discovery model `anthropic/claude-haiku-5.5` with OpenRouter web search proposes up to three URLs. It never fetches a page or writes a label. The request asks for zero data retention. When no provider serves it that way, the call repeats without ZDR, prints a warning and records `zdr: false`. Code then applies the label-source URL policy in `packages/core/src/report-sources.ts`, because no per-company allow-list covers general web pages. A URL must use https on the default port, carry no user name, and name a public host. An IP address, a single-label host and a host under `localhost`, `local`, `internal`, `intranet`, `lan` or `home.arpa` are rejected. The policy does not resolve names, so a public name that points at a private address passes it. The report fetcher then checks the policy again at every redirect, obeys robots.txt, spaces requests to one host, and accepts only HTML or PDF of at most 10 MB, with at least 2,000 characters that name the company. Each page is stored in `label_sources` with its URL, final URL, fetch time and the sha256 of the fetched bytes. Every search is recorded in `label_source_attempts`, with the model call, the proposed URLs and the reason for each rejection. Neither table is in a snapshot, chunked or indexed, so no agent and no scoring run ever reads a label source. A subject with no issuer key gets no search. A rerun retries only the searches that failed.

`label` reads only the local store, the stored pages and the work files. It makes no web search and fetches nothing. The labeller sees the store passages and up to two passages of each stored page, labelled `w1`, `w2` and so on, with the page's URL and fetch time. A live run first checks that each stored copy still has the same hash and passage text. A label that names a passage it was not shown, or names no web passage when it was shown one, is rejected. The command prints the count and reason of each rejection, and a rejected record never enters a manifest. A subject with no stored page is labelled from the store alone, kept, and counted as no web source with the reason. The labeller calls go through the gateway with the cache off. A rerun labels only the records that are left, and it retries the failed calls.

The reviewer labeller checks each record without the injected flaw in view. A record whose answer differs from its flaw is dropped, and the command prints the count and the reason for each drop. KPI pairs use the `labeller-kpi` prompt on the passages that the Analyst was shown, plus the web passages. Relevance labels use up to four passages from each company's own filings or reports, ranked by a full-text match on the theme, plus the web passages. The relevance sample takes half its names from the companies that a frozen reference fund holds, where the pool allows. A fund holding shapes the candidate pool only. It is never the label.

Each manifest record that cites a page has `webCitations`. Each citation holds the passage id, the stored page id, the page URL, the fetch time and the sha256 of the fetched bytes. `evidenceIds` keep their meaning: the store passages shown, and for a reviewer record the chunks that the score cites. The check sheet lists each citation as the URL, the fetch time and the hash, so the colleague can compare the stored copy with the page.

`sample-human` refuses labels with failed records. `record-human-check` refuses a sheet with a blank, missing or extra row. `assemble` writes `ai-generated-human-sampled` only for a kind with a recorded spot check of exactly its records. Otherwise the manifest stays `provisional-ai`. The step writes nothing unless the whole set passes `validateReleaseSet`. It also refuses an output directory that already holds manifests. It prints how many records of each kind have no web citation.

Live commands are BLOCKED until `DATABASE_URL`, the snapshots and a run for each theme are given. Commands for the reviewer kind take their snapshots from `flawed.json` instead. `collect-sources` and `label` also need `OPENROUTER_API_KEY` and `--yes-spend`, and `build-flawed` also needs `--yes-write`. A BLOCKED command loads no database, gateway or search code, and makes no model call, search or fetch. Bun reads `.env` from the current directory, so the credentials there count as given.

### Caveats

- The labels are AI generated and sample-verified by a person. Kappa against them measures agreement with AI labels, not ground truth. This deviates from the spec's independent human labels.
- A web citation is a stored copy of a page as it was fetched on the recorded date, not a live link. The page may have changed or gone since. The hash identifies the bytes that were fetched.
- The pages are fetched after the as-of dates of the theme runs. A label can rest on information published between the as-of date and the fetch date.
- The search model is from anthropic, the Designer's vendor. It only proposes URLs. The labeller, from google, reads the stored pages and writes the label.
- A record with no stored page has no `webCitations`. It rests on the store passages alone, and the label file lists it under `noWebSource` with the reason. A name with no store evidence and no stored page rests on the company name alone, and its rationale starts with "No passages."
- The reviewer flaws are injected by code and confirmed by the AI labeller. They are not flaws found in the wild.

### Offline fixture path

This path checks the tooling with recorded searches, pages and labeller answers. It uses no database, no model and no network, and its manifests carry `fixture: true`. The fetcher runs on the recorded pages, so the URL policy and the fetch checks run as they do live.

```
W=$(mktemp -d); I="$W/inputs"
bun apps/worker/scripts/phase2-labels.ts fixture --out "$I"
bun apps/worker/scripts/phase2-labels.ts build-flawed --work "$W" --from "$I/extract.json" --flawed 110
for k in reviewer kpi relevance; do
	from=$([ $k = reviewer ] || echo "--from $I/extract.json")
	bun apps/worker/scripts/phase2-labels.ts collect-sources --manifest-kind $k --work "$W" $from --searches "$I/searches.json" --pages "$I/pages.json"
	bun apps/worker/scripts/phase2-labels.ts label --manifest-kind $k --work "$W" $from --responses "$I/responses.json"
done
bun apps/worker/scripts/phase2-labels.ts sample-human --work "$W" --seed 7
for k in kpi reviewer relevance; do sed -e '2,$ s/,,$/,yes,/' "$W/check-$k.csv" > "$W/returned-$k.csv"; bun apps/worker/scripts/phase2-labels.ts record-human-check --work "$W" --kind $k --sheet "$W/returned-$k.csv" --reviewer "Fixture colleague"; done
bun apps/worker/scripts/phase2-labels.ts assemble --work "$W" --out "$W/release" --allow-fixture
bun apps/worker/scripts/phase2-eval.ts --mode validate --data "$W/release" --allow-fixture
```

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
bun apps/worker/scripts/phase2-eval.ts --mode reviewer --data docs/evaluation/release --cache off
bun apps/worker/scripts/phase2-eval.ts --mode reviewer-fixture --data packages/evals/fixtures/reviewer-100.json [--strict]
bun apps/worker/scripts/phase2-fixture.ts   # regenerates the fixtures from the seeded builder
```

The `reviewer` mode calls the configured Reviewer through the gateway and needs `DATABASE_URL` and `OPENROUTER_API_KEY`. Each reviewer record's `id` is the `kpi_scores` id of the score to review in that database, and its `evidenceIds` are the chunks the score cites. A record whose score cites other chunks gets no verdict. A missing release directory or credential is BLOCKED before any call. The `reviewer-fixture` answers are written by a builder, not by a model.

`apps/worker` reads `@open-foresight/evals` from its build, so run `bun run build` in `packages/evals` after changing it. The `prescreen` mode belongs to PR 24.
