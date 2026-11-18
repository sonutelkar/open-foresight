# Phase 0 and 1 plan

Build the foundation and a US pilot that takes a brief through KPI approval to a 50-stock basket. Each numbered item is one PR. Stop after each check. This plan is not approval to implement.

## Decisions that block work

- **US scope.** The roadmap says US only, while the open questions ask US or US plus Europe. Use US as the planning assumption. A different choice changes PRs 7, 8, and 10.
- **Prices and liquidity.** Select an EOD source with acceptable terms, US coverage, historical prices, volume, and a defensible market-cap input. Stooq and exchange files are candidates, not confirmed solutions. PR 10 and the live phase gate wait for this decision and a coverage probe.
- **EODHD timing.** The data section says phase 1, while the roadmap says phase 3. Decide before scheduling an adapter. This plan does not silently include it in phase 1. Open data remains the default either way.
- **Pilot theme and reference.** Choose at least one of the three pilot themes and its reference ETF. PR 17's live gate cannot be evaluated without it. The remaining themes and 200 labels are needed for later evals, not the phase 1 basket.
- **Model, provider, and spending.** Choose accessible structured-output models and pinned providers, an OpenRouter run budget and monthly cap. PR 5's paid live check and PR 17's live gate wait for credentials, ZDR account settings, and these choices. Fixture tests do not establish live compatibility.
- **Deployment and identity.** Choose where the pilot runs, any data-residency rules, and who may approve KPIs. PR 14 needs an identity choice for attributable decisions. The phase 1 live gate needs an agreed host.
- **Gate 2 and scope.** Phase 1 excludes Reviewer and gate 2, but the product workflow requires both before finalisation. Confirm whether a phase 1 basket is explicitly provisional, with no claim of final approval. PRs 15–17 wait for that product decision. Two-person sign-off is a later decision if gate 2 remains in phase 2.
- **Eval thresholds.** The release gate requires a baseline and labelled sets from phase 1, but the 200-pair set is scheduled in phase 2. Agree who labels it and whether the phase 1 pilot uses a smaller explicitly provisional baseline. PR 17 cannot claim the full kappa release gate without the labelled set.
- **Reproducibility.** Cache replay promises byte-identical output, while uncached LLM calls can vary. Confirm snapshot membership and evidence versioning semantics before PR 9, including how late-ingested records and restatements are handled. Phase 2 owns full replay; phase 1 must not claim identical uncached model results.

## Landing order and dependencies

PR 01 starts on trunk. PRs 02, 03, and 04 depend on 01. PR 05 depends on 02 and 03. PR 05b depends on 05. PR 06 depends on 03 and 05. PR 07 depends on 02 and 03. PR 08 depends on 07. PR 09 depends on 07 and 08. PR 10 depends on 07 and the price-source decision. PR 11 depends on 08 and 09. PR 11b depends on 05b and 11. PR 12 depends on 05, 06, and 07. PR 13 depends on 09, 11, and 12. PR 13b depends on 05b and 13. PR 13c depends on 05b, 09, 11, and 13. PR 14 depends on 03, 07, and 12. PR 15 depends on 10, 13, and 14. PR 16 depends on 14 and 15. PR 17 depends on 04 and 16 plus the pilot and live-gate decisions. The later-phase Jev items depend on 05b and their respective base features. Dependencies may branch independently from the indicated landed PRs. Land in numeric order unless the dependencies and shared files are reconciled.

PRs 14 and 16 change human interactions and require operator review before merge. PR 17 requires the operator's review of the pilot result. No PR requires paid API calls in automated tests.

## Check protocol

Each PR has unit, live, and performance checks. Unit checks use fixtures and no paid API. Live means exercising the actual local CLI, service, database, or browser, with recorded upstream responses where appropriate. Save commands, fixtures, results, and environment with the PR. A mock-only run does not prove provider or production performance.

For every performance check, measure the same command on trunk first, with the same machine and input, three warm runs, and record the median. If trunk lacks the capability, record "not applicable: capability absent" and use the stated absolute ceiling as the first baseline. Fail on an absolute ceiling breach or a median regression greater than 25% when trunk implements the same operation. These provisional per-PR ceilings catch gross failures, not the spec's 30-minute live goal. Do not compare fixture timings to the live goal.

## Phase 0

### PR 01. Workspace and CI

- [ ] Depends on trunk. Files: root package and workspace configuration, CI workflow, minimal package entry points.
- [ ] Establish Node 22, Bun, Turborepo, strict TypeScript, Vitest, and CI.
- [ ] Unit: a deliberately invalid fixture fails type checking; a sample test passes.
- [ ] Live: clean checkout installs and runs the documented build and test commands locally.
- [ ] Perf: measure clean build wall time; fail above 120 seconds.

### PR 02. Local services

- [ ] Depends on 01. Files: `docker-compose.yml`, environment examples, local service documentation.
- [ ] Start Postgres 16 with pgvector, MinIO, and self-hosted Langfuse with persistent volumes.
- [ ] Unit: validate Compose configuration without credentials in source.
- [ ] Live: start services, check health, create a vector and a test object, then restart and read both.
- [ ] Perf: measure first healthy startup on an already-pulled image set; fail above 180 seconds.

### PR 03. Runs and audit storage

- [ ] Depends on 01. Files: `packages/db`, `packages/core`, migration configuration.
- [ ] Add Drizzle migrations for runs, status history, LLM and tool calls, human decisions, and cache; enforce append-only audit records and valid state transitions.
- [ ] Unit: reject invalid transitions and audit edits; confirm gates cannot advance without their approval action.
- [ ] Live: migrate a clean database, create a run, append an audit event, and read both back.
- [ ] Perf: time 1,000 audit inserts in a local transaction; fail above 10 seconds.

### PR 04. Eval runner skeleton

- [ ] Depends on 01. Files: `packages/evals`, CI workflow.
- [ ] Add fixture-based eval execution, versioned result output, and baseline comparison that fails when required data is missing rather than reports a pass.
- [ ] Unit: known metric and threshold failures produce nonzero exit codes.
- [ ] Live: run a small checked-in fixture through the CLI and inspect its result file.
- [ ] Perf: time 100 fixture cases; fail above 30 seconds.

### PR 05. OpenRouter gateway

- [ ] Depends on 02 and 03. Files: `packages/llm`, `config/models.ts`, `packages/db`.
- [ ] Add pinned provider routing, privacy flags, structured output validation and one repair retry, startup capability checks, and durable call audit. Record actual served model, provider, usage, and failures.
- [ ] Unit: fixture server verifies request flags, schema failure, repair, unsupported configuration, and audit fields.
- [ ] Live: after model and budget decisions, make a structured call to each of two configured models with fallbacks off; inspect both `llm_calls` rows. A missing credential or provider capability blocks this check.
- [ ] Perf: measure gateway overhead with a local fixed-response server over 100 calls; fail above 5 seconds total, excluding database startup.

### PR 05b. Jev decision gateway

- [ ] Depends on 05. Files: `packages/llm`, `config/models.ts`, `docs/jev-contract.md`.
- [ ] Add typed Noul, Choice, and Score decisions through OpenRouter's Decisions API. Pin the eligible provider and enforce ZDR and data-collection denial. Record every attempt in the shared audit trail. Do not cache Jev calls.
- [ ] Unit: recorded fixtures cover each answer type, invalid answers, bounded retry, routing, privacy, and audit fields.
- [ ] Live: run two synthetic decisions and inspect their audit rows. Confirm account privacy and the current provider catalog before sending project evidence. EU in-region routing is currently unavailable.
- [ ] Perf: run 100 fixture decisions with audit writes; fail above 5 seconds. Record trunk as not applicable if the capability is absent.

### PR 06. Cache, limits, and agent loop

- [ ] Depends on 03 and 05. Files: `packages/llm`, `packages/db`.
- [ ] Add full-request cache keys for generation, concurrency limits, bounded retry, and a typed tool loop with turn and budget limits. Do not cache Jev calls.
- [ ] Unit: prove changed inputs miss cache, hits make no request, and tool, turn, concurrency, and budget limits stop correctly.
- [ ] Live: call the local fixture endpoint twice and inspect identical outputs, one upstream request, and recorded tool calls.
- [ ] Perf: time 100 cache hits with a local database; fail above 5 seconds.

## Phase 1

### PR 07. Data contracts and security master

- [ ] Depends on 02 and 03. Files: `packages/data`, `packages/db`, `packages/core`.
- [ ] Define provider contracts and timestamped records; ingest SEC ticker and CIK data and map OpenFIGI identifiers to stable security IDs. Preserve ambiguous mappings for resolution.
- [ ] Unit: recorded SEC and OpenFIGI fixtures cover mappings, duplicates, retries, and repeat sync.
- [ ] Live: ingest a small fixture into Postgres twice and inspect stable IDs and unchanged row counts.
- [ ] Perf: time fixture ingestion for 1,000 records; fail above 30 seconds.

### PR 08. SEC filings and facts

- [ ] Depends on 07. Files: `packages/data/providers/sec-edgar`, `packages/db`.
- [ ] Ingest recorded submissions, filing text, and XBRL company facts with filing dates, raw source references, and restatements.
- [ ] Unit: fixture contracts cover amendments, missing dates, rate limits, and repeat sync.
- [ ] Live: ingest a recorded filing and amended fact, then query their dates and raw references.
- [ ] Perf: ingest a fixed 50-company fixture; fail above 120 seconds.

### PR 09. Point-in-time snapshots

- [ ] Depends on 07, 08, and snapshot decision. Files: `packages/db`, `packages/data`, `packages/core`.
- [ ] Freeze snapshot membership and provide as-of reads for documents and facts, including late ingestion and restatements according to the agreed policy.
- [ ] Unit: future-dated documents never appear; test date boundaries, late arrivals, and last filed fact before the cutoff.
- [ ] Live: load past, future, and amended records; query two dates against a frozen snapshot and inspect exact returned IDs.
- [ ] Perf: query a fixed 10,000-record local dataset 100 times; fail above 10 seconds.

### PR 10. Prices and universe

- [ ] Depends on 07 and the price-source decision. Files: `packages/data/providers`, `packages/db`, `packages/core`.
- [ ] Ingest selected US EOD prices and calculate point-in-time market cap and ADV with explicit missing-data handling. Apply region, cap, liquidity, and exclusion filters.
- [ ] Unit: recorded source fixtures cover dates, missing values, filters, and repeat ingestion.
- [ ] Live: load a 50-stock fixture and inspect each inclusion and exclusion reason.
- [ ] Perf: filter 3,000 fixture securities; fail above 10 seconds.

### PR 11. Evidence retrieval

- [ ] Depends on 08 and 09. Files: `packages/retrieval`, `packages/db`, local embedding service config.
- [ ] Chunk filings by section, retain source offsets, embed with a pinned local model, and combine text and vector results by reciprocal rank.
- [ ] Unit: check chunk boundaries, fusion, security isolation, snapshot membership, and as-of filtering.
- [ ] Live: index a recorded filing, retrieve a known quote for its security, and confirm a future filing is absent.
- [ ] Perf: time 100 searches over a fixed 10,000-chunk local index; fail above 60 seconds. Record embedding hardware and model.

### PR 11b. Jev passage relevance

- [ ] Depends on 05b and 11. Files: `packages/retrieval`, `packages/evals`.
- [ ] Add an optional Noul relevance filter or reranker over retrieved passages. Preserve company and point-in-time filtering in code.
- [ ] Unit: recorded decisions cover relevant, irrelevant, wrong-company, and future-dated passages.
- [ ] Live: run a recorded retrieval set and compare recall, ranking, and latency with PR 11. Inspect evidence IDs.
- [ ] Perf: run 100 fixture searches against the same corpus as PR 11; fail above 60 seconds or on a median regression above 25% against the measured trunk baseline.
- [ ] Enable for product use only after labelled evaluation and privacy requirements are satisfied. Record the decision and baseline.

### PR 12. Designer and framework

- [ ] Depends on 05, 06, and 07. Files: `packages/agents`, `packages/prompts`, `packages/core`, `packages/db`.
- [ ] Generate a validated framework with allowed sources, 3–8 KPIs, complete rubrics, weights, and at most one gate; preserve prompt version and model call records.
- [ ] Unit: golden responses cover invalid weights, incomplete rubrics, unavailable sources, and invalid gate count.
- [ ] Live: run a recorded gateway response for a sample brief and inspect the saved draft and audit row.
- [ ] Perf: process 100 recorded drafts; fail above 30 seconds excluding model latency.

### PR 13. Analyst scoring

- [ ] Depends on 09, 11, and 12. Files: `packages/agents`, `packages/prompts`, `packages/core`, `packages/db`.
- [ ] Score each stock and approved KPI with retrieved local evidence. Quant functions and threshold bucketing run in code. Phase 1 has no Analyst tool loop.
- [ ] Unit: cover unknowns, lookback, quantitative thresholds, wrong-security evidence, missing IDs, and non-verbatim quotes.
- [ ] Live: score recorded evidence for one stock and inspect the persisted attempt and traceable citations.
- [ ] Perf: validate 1,000 recorded scores; fail above 30 seconds excluding model latency.

### PR 13b. Jev KPI scoring and bake-off

- [ ] Depends on 05b and 13. Files: `packages/agents`, `packages/evals`, `packages/core`.
- [ ] Add optional Score questions against approved 0–4 rubrics. Keep weights and the theme score in code. Define and record the mapping from weighted scores to discrete levels and unknowns.
- [ ] Unit: fixtures cover all levels, ambiguous evidence, unknowns, and confidence signals.
- [ ] Live: compare Jev and the frontier Analyst on the same labelled KPI pairs and evidence. Report weighted kappa, stability, calibration, cost, and unknown rates.
- [ ] Perf: score 100 fixture cases; fail above 30 seconds or on a median regression above 25% against the measured trunk baseline. Exclude live provider latency.
- [ ] Enable for product use only when the existing kappa ≥ 0.6 and stability ≥ 95% gates pass and the evidence is reviewed. The 200 labelled pairs and their owner remain open dependencies.

### PR 13c. Stored-span citation verification

- [ ] Depends on 05b, 09, 11, and 13. Files: `packages/retrieval`, `packages/agents`, `packages/evals`.
- [ ] Add an optional path where code selects an exact stored span and Jev judges whether it supports the claim. Preserve source and snapshot references.
- [ ] Unit: reject nonexistent IDs, altered spans, wrong-company sources, and future evidence.
- [ ] Live: compare citation validity, verbatim rate, and human-rated claim support with the existing extraction path on labelled examples.
- [ ] Perf: validate 1,000 fixture citations; fail above 30 seconds or on a median regression above 25% against the measured trunk baseline.
- [ ] Enable only after meeting the existing 100% evidence-ID and 98% verbatim gates and reviewing claim support.

### PR 14. Brief and KPI approval

- [ ] Depends on 03, 07, 12, and identity decision. Files: `apps/web`, `apps/api`, `packages/core`, `packages/db`.
- [ ] Add brief entry, validation, editable KPI rubric and weights, and authenticated approval that freezes a framework version and appends an attributable decision.
- [ ] Unit: reject future dates, short briefs, infeasible weight caps, incomplete rubrics, and weights not summing to one.
- [ ] Live: use the browser to submit a valid brief, edit a rubric, approve it, and inspect the frozen version and decision. Confirm invalid submissions remain blocked.
- [ ] Perf: measure 100 local brief validation and approval requests; fail above 30 seconds excluding browser startup.
- [ ] Obtain operator review of the interaction before merge.

### PR 15. Packaging and orchestration

- [ ] Depends on 10, 13, 14, and the provisional-basket decision. Files: `packages/core`, `apps/worker`, `packages/db`, `apps/api`.
- [ ] Advance idempotent jobs through the phase 1 stages, pause at gate 1, compute scores and contributions, apply gate and basket rules, caps, and weighting. Label output provisional until gate 2 exists.
- [ ] Unit: cover unknown modes, tie breaks, infeasible caps, failure and retry, gate enforcement, and repeat jobs.
- [ ] Live: run a recorded 50-stock job through approval to a provisional basket; inspect funnel counts, weights, contributions, and restart behavior.
- [ ] Perf: time packaging 3,000 recorded securities; fail above 30 seconds excluding model calls.

### PR 16. Basket UI and evidence

- [ ] Depends on 14 and 15. Files: `apps/web`, `apps/api`, `packages/core`.
- [ ] Display the provisional basket, scores, weights, and per-name KPI evidence with source links and the phase 1 review limitation.
- [ ] Unit: cover empty and failed runs, score rendering, and evidence links.
- [ ] Live: open the recorded 50-stock basket in a browser and trace a displayed quote to the stored source.
- [ ] Perf: measure local API response for a 50-name basket over 100 requests; fail above 10 seconds total.
- [ ] Obtain operator review of the interaction before merge.

### PR 17. Pilot and phase gate

- [ ] Depends on 04 and 16 and the pilot, hosting, model, budget, and eval decisions. Files: `packages/evals`, pilot fixtures and run documentation.
- [ ] Add a reproducible 50-stock pilot procedure and citation evaluator. Record source snapshot, model/provider, cost, approval, timestamps, and measured results. Report provisional labelled-set metrics separately from full release gates.
- [ ] Unit: a missing citation ID or altered quote fails the citation evaluator; a future document fails the point-in-time check.
- [ ] Live: on the agreed host, run the selected real theme through the UI using approved live sources and models. Require elapsed time under 30 minutes, 100% existing citation IDs, and at least 98% verbatim quotes. Record failures and the full denominator. Paid calls require the agreed budget.
- [ ] Perf: repeat the same pilot procedure against the recorded 50-stock fixture on trunk first and the PR, excluding external provider latency. Fail if median time rises more than 25%; fail above 30 minutes. The separate live run must independently meet the 30-minute goal.
- [ ] Obtain operator review of the provisional basket and gate evidence before merge.

The phase 0 gate requires the two live model calls and a no-network cache hit. The phase 1 gate requires PR 17's live measurements and PR 09's point-in-time tests. Reviewer, gate 2, pre-screen, full-scale processing, full replay, and discovery remain later-phase work. A fixture run does not satisfy either live gate.

## Later-phase Jev product features

### Phase 2. Jev Reviewer second opinion

- [ ] Depends on 05b, the phase 2 Reviewer, and a labelled flawed-score set. Files: `packages/agents`, `packages/evals`.
- [ ] Add an optional structured second opinion from a different vendor. Keep explanation writing and escalation policy in code and the generative Reviewer.
- [ ] Unit: recorded decisions cover disagreement, unsupported evidence, and escalation.
- [ ] Live: compare catch rate and false alarms on the flawed-score set against the existing Reviewer. Meet the existing ≥ 80% catch-rate gate before enabling.
- [ ] Perf: evaluate 100 fixture scores; fail above 30 seconds or on a median regression above 25% against the measured trunk baseline.

### Phase 2. Jev pre-screen

- [ ] Depends on 05b, the phase 2 pre-screen, and labelled relevance data. Files: `packages/agents`, `packages/evals`.
- [ ] Add an optional Noul or Choice classification step for the approximately 3,000-stock universe.
- [ ] Unit: cover relevant, irrelevant, uncertain, and missing-evidence fixtures.
- [ ] Live: compare recall, precision, cost, and latency with the existing pre-screen on labelled data. Meet the existing ≥ 95% recall target before enabling.
- [ ] Perf: evaluate 100 fixture cases; fail above 30 seconds or on a median regression above 25% against the measured trunk baseline.

### Phase 4. Jev discovery guardrails

- [ ] Depends on 05b, the discovery tool loop, and a labelled action set. Files: `packages/agents`, `packages/evals`.
- [ ] Add an optional decision check for proposed discovery tool calls and returned evidence. Code retains final authority over actions.
- [ ] Unit: recorded cases cover allowed, disallowed, and ambiguous calls and results.
- [ ] Live: replay labelled discovery actions and review false approvals, unnecessary blocks, and audit records before enabling.
- [ ] Perf: evaluate 100 fixture actions; fail above 30 seconds or on a median regression above 25% against the measured trunk baseline.

All Jev product uses require a verified privacy and hosting decision. Jev is not scheduled to generate Designer text, extract quotes, or write its own questions. See [the evaluation note](jev-evaluation.md).
