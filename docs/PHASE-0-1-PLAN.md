# Phase 0 and 1 plan

Build the foundation and a US, EU, UK, and Switzerland pilot that takes a brief through KPI approval to a 50-stock basket, subject to sufficient data coverage. Each numbered item is one PR. Stop after each check. This plan is not approval to implement.

## Decisions and open questions

- **Scope.** Target the US, EU, UK, and Switzerland where sufficient data is available. Report coverage gaps. SEC and OpenFIGI alone do not establish a complete European universe.
- **Prices and liquidity.** Decided on 2026-11-22. Prices and volume come from the EODHD EOD plan at 19.99 EUR a month. FX comes from free ECB reference rates. Market cap comes from SEC share counts for US names where a filing exists. For other names it comes from share counts and market caps observed through Yahoo Finance, read with the Python yfinance package run by uv. Apify is an optional second reader. Observed values are snapshots of their fetch day, so they serve runs for today and not backtests. The EODHD Fundamentals plan was not bought. The free FMP and Finnhub tiers returned no non-US data and are not used. Known gaps: EODHD has no Italian exchange, so ENEL.MI has no prices. TPIC.US and ROG.SW returned no bars or Yahoo data.
- **Non-commercial use.** The EODHD personal plan and Yahoo Finance are for personal, educational use. Yahoo's terms bar automated collection. This project is educational and not commercial. Before any commercial use, replace both with licensed sources, and treat that as a blocker for the PR 17 live gate if the pilot is shown outside the project.
- **EODHD timing.** Add its adapter early in phase 1. It must remain disabled without `EODHD_API_KEY`; the open-data path must work without it.
- **Pilot theme and reference.** Use Smart Energy, with Robeco Smart Energy as a dated comparison. Its global portfolio and limited published holdings constrain comparison with our regional universe. The ETF reference is the First Trust NASDAQ Clean Edge Smart Grid Infrastructure Index Fund (GRID), frozen at its 2026-11-20 holdings in `docs/reference/grid-holdings-2026-11-20.csv`. Its public holdings page is accessible, and the iShares Global Clean Energy file was not retrievable. About 85 percent of its weight is in US, FR, CH, DE, IT, UK and ES. Italy is 6.5 percent and has no EODHD prices. About 14 percent is in BR, JP, CA, KR, TW and HK, outside our regions. GRID is narrower than Smart Energy because it centers on grid infrastructure, so report recall against the part of GRID inside our universe.
- **Model, provider, and spending.** The two configured models passed a live structured-output check. The monthly OpenRouter cap is 50 USD. The gateway does not enforce a monetary cap, so check usage in the OpenRouter console. Choose the per-run budget after further testing, and confirm account privacy settings before the live pilot.
- **Embeddings.** Decided on 2026-11-22. Embed with `openai/text-embedding-3-small` through OpenRouter and `packages/llm`, pinned to the `azure` provider with `zdr` and `data_collection: deny`. A live call returned 1536 dimensions at 0.02 USD per million tokens. OpenAI's own endpoint is not ZDR eligible for this model and is excluded by those filters. This replaces the earlier plan for a pinned local model. Record the model and provider with the snapshot.
- **Evidence coverage.** Decided on 2026-11-22. Phase 1 evidence covers SEC filings and ESEF filings from the free filings.xbrl.org index, which has filings for FR, NL, GB, ES, IT, SE and DK. The index had none for DE or CH, so those names are reported as having no evidence. A tested sample found a usable share count in 4 of 9 ESEF filings, so ESEF is for text evidence and not for shares. ESEF entities use LEIs, so PR 08b must verify a free ISIN to LEI mapping.
- **Deployment and approval.** An analyst can review and approve KPIs. Record that an analyst approved the framework; a sign-in page is not required for the local pilot. Choose a host before the live gate. Data residency is not currently a selection priority.
- **Gate 2 and scope.** Label the phase 1 basket provisional. Reviewer and final approval remain later work.
- **Orchestration.** Decided on 2026-11-22. A worker in `apps/worker` runs the stages on pg-boss, one `exclusive` job per run, so a run is never driven by two workers. The API only queues jobs. The Designer runs as a stage, not in the API. A job drives a run to the next gate or its end and resumes from saved state after a crash or an outage. Phase 1 has no Reviewer, so a migration lets `analysing` go straight to `packaging`. The `reviewing` and `awaiting_flag_review` stages and their gate remain for phase 2. Prescreening makes no model calls. It resolves each name's evidence and records its coverage. The universe is every listing with prices in the local store, so the store is ingested before a run starts. Agents never fetch.
- **Unknown KPIs and caps.** Decided on 2026-11-22. A pure play run (`strict` exposure) scores an unknown KPI as level 0. A broad run drops it and renormalises the other weights, and caps the score at 0.8 when more than half the KPI weight is unknown. An unknown gate KPI fails the gate in both modes. When fewer names qualify than the weight cap needs to reach 100 percent, the cap is raised to the smallest feasible value, 100 over the name count, and the basket records that. Phase 1 omits the sector and region caps, the days-to-trade report and the factor tilt summary from the spec's basket construction. Each needs data or a decision that phase 1 does not have, and the basket does not claim them.
- **Open: ranking on thin evidence.** Raised on 2026-11-22 by the live run. The spec's lenient rule renormalises over the known KPIs and then caps the score at 0.8, so a name with one perfect KPI and 90 percent of the weight unknown ties at 0.8 and ranked first and second in the pilot basket, above names with more evidence. The Analyst also answers `unknown` on the gate KPI for clearly unrelated names such as Apple, so 18 of 32 scored names left at `gate_unknown` and none at `gate_failed`. Decide before PR 17 whether to scale a lenient score by the known weight, require a minimum known weight, or have the Designer's gate rubric use level 0 for a name with no exposure. The code follows the spec as written.
- **Evaluation.** AI may produce initial labels and an analyst will skim them. Treat results as provisional. The full kappa release gate still needs an independent labelled set. Agree a provisional pilot threshold separately; the existing full release threshold remains unchanged.
- **Reproducibility.** Freeze snapshot membership and the evidence versions available when the snapshot is created. Preserve original filing dates and versions, including late arrivals and restatements. Phase 2 owns full replay; phase 1 must not claim identical uncached model results.

## Landing order and dependencies

PR 01 starts on trunk. PRs 02, 03, and 04 depend on 01. PR 05 depends on 02 and 03. PR 05b depends on 05. PR 06 depends on 03 and 05. PR 07 depends on 02 and 03. PR 08 depends on 07. PR 08b depends on 07 and 09. PR 09 depends on 07 and 08. PR 10 depends on 07 and the price-source decision. PR 11 depends on 08, 08b and 09. PR 11b depends on 05b and 11. PR 12 depends on 05, 06, and 07. PR 13 depends on 09, 11, and 12. PR 13b depends on 05b and 13. PR 13c depends on 05b, 09, 11, and 13. PR 14 depends on 03, 07, and 12. PR 15 depends on 10, 13, and 14. PR 16 depends on 14 and 15. PR 17 depends on 04 and 16 plus the pilot and live-gate decisions. The later-phase Jev items depend on 05b and their respective base features. Dependencies may branch independently from the indicated landed PRs. Land in numeric order unless the dependencies and shared files are reconciled.

PRs 14 and 16 change human interactions and require operator review before merge. PR 17 requires the operator's review of the pilot result. No PR requires paid API calls in automated tests.

## Check protocol

Each PR has unit, live, and performance checks. Unit checks use fixtures and no paid API. Live means exercising the actual local CLI, service, database, or browser, with recorded upstream responses where appropriate. Save commands, fixtures, results, and environment with the PR. A mock-only run does not prove provider or production performance.

For every performance check, measure the same command on trunk first, with the same machine and input, three warm runs, and record the median. If trunk lacks the capability, record "not applicable: capability absent" and use the stated absolute ceiling as the first baseline. Fail on an absolute ceiling breach or a median regression greater than 25% when trunk implements the same operation. These provisional per-PR ceilings catch gross failures, not the spec's 30-minute live goal. Do not compare fixture timings to the live goal.

## Phase 0

### PR 01. Workspace and CI

- [x] Depends on trunk. Files: root package and workspace configuration, CI workflow, minimal package entry points.
- [x] Establish Node 22, Bun, Turborepo, strict TypeScript, Vitest, and CI.
- [x] Unit: a deliberately invalid fixture fails type checking; a sample test passes.
- [x] Live: clean checkout installs and runs the documented build and test commands locally.
- [x] Perf: measure clean build wall time; fail above 120 seconds.

### PR 02. Local services

- [x] Depends on 01. Files: `docker-compose.yml`, environment examples, local service documentation.
- [x] Start Postgres 16 with pgvector, MinIO, and self-hosted Langfuse with persistent volumes.
- [x] Unit: validate Compose configuration without credentials in source.
- [x] Live: start services, check health, create a vector and a test object, then restart and read both.
- [x] Perf: measure first healthy startup on an already-pulled image set; fail above 180 seconds.

### PR 03. Runs and audit storage

- [x] Depends on 01. Files: `packages/db`, `packages/core`, migration configuration.
- [x] Add Drizzle migrations for runs, status history, LLM and tool calls, human decisions, and cache; enforce append-only audit records and valid state transitions.
- [x] Unit: reject invalid transitions and audit edits; confirm gates cannot advance without their approval action.
- [x] Live: migrate a clean database, create a run, append an audit event, and read both back.
- [x] Perf: time 1,000 audit inserts in a local transaction; fail above 10 seconds.

### PR 04. Eval runner skeleton

- [x] Depends on 01. Files: `packages/evals`, CI workflow.
- [x] Add fixture-based eval execution, versioned result output, and baseline comparison that fails when required data is missing rather than reports a pass.
- [x] Unit: known metric and threshold failures produce nonzero exit codes.
- [x] Live: run a small checked-in fixture through the CLI and inspect its result file.
- [x] Perf: time 100 fixture cases; fail above 30 seconds.

### PR 05. OpenRouter gateway

- [x] Depends on 02 and 03. Files: `packages/llm`, `config/models.ts`, `packages/db`.
- [x] Add pinned provider routing, privacy flags, structured output validation and one repair retry, startup capability checks, and durable call audit. Record actual served model, provider, usage, and failures.
- [x] Unit: fixture server verifies request flags, schema failure, repair, unsupported configuration, and audit fields.
- [x] Live: after model and budget decisions, make a structured call to each of two configured models with fallbacks off; inspect both `llm_calls` rows. A missing credential or provider capability blocks this check.
- [x] Perf: measure gateway overhead with a local fixed-response server over 100 calls; fail above 5 seconds total, excluding database startup.

### PR 05b. Jev decision gateway

- [x] Depends on 05. Files: `packages/llm`, `config/models.ts`, `docs/jev-contract.md`.
- [x] Add typed Noul, Choice, and Score decisions through OpenRouter's Decisions API. Pin the eligible provider and enforce ZDR and data-collection denial. Record every attempt in the shared audit trail. Do not cache Jev calls.
- [x] Unit: recorded fixtures cover each answer type, invalid answers, bounded retry, routing, privacy, and audit fields.
- [x] Live: run two synthetic decisions and inspect their audit rows. Confirm account privacy and the current provider catalog before sending project evidence. EU in-region routing is currently unavailable.
- [x] Perf: run 100 fixture decisions with audit writes; fail above 5 seconds. Record trunk as not applicable if the capability is absent.

### PR 06. Cache, limits, and agent loop

- [x] Depends on 03 and 05. Files: `packages/llm`, `packages/db`.
- [x] Add full-request cache keys for generation, concurrency limits, bounded retry, and a typed tool loop with turn and budget limits. Do not cache Jev calls.
- [x] Unit: prove changed inputs miss cache, hits make no request, and tool, turn, concurrency, and budget limits stop correctly.
- [x] Live: call the local fixture endpoint twice and inspect identical outputs, one upstream request, and recorded tool calls.
- [x] Perf: time 100 cache hits with a local database; fail above 5 seconds.

## Phase 1

### PR 07. Data contracts and security master

- [x] Depends on 02 and 03. Files: `packages/data`, `packages/db`, `packages/core`.
- [x] Define provider contracts and timestamped records; ingest SEC ticker and CIK data and map OpenFIGI identifiers to stable security IDs. Preserve ambiguous mappings for resolution. Identify and report European coverage gaps.
- [x] Unit: recorded SEC and OpenFIGI fixtures cover mappings, duplicates, retries, and repeat sync.
- [x] Live: ingest a small fixture into Postgres twice and inspect stable IDs and unchanged row counts.
- [x] Perf: time fixture ingestion for 1,000 records; fail above 30 seconds.

### PR 08. SEC filings and facts

- [x] Depends on 07. Files: `packages/data/providers/sec-edgar`, `packages/db`.
- [x] Ingest recorded submissions, filing text, and XBRL company facts with filing dates, raw source references, and restatements.
- [x] Unit: fixture contracts cover amendments, missing dates, rate limits, and repeat sync.
- [x] Live: ingest a recorded filing and amended fact, then query their dates and raw references.
- [x] Perf: ingest a fixed 50-company fixture; fail above 120 seconds.

### PR 08b. ESEF filings

- [x] Depends on 07 and 09. Files: `packages/data/providers/esef`, `packages/db`.
- [x] Ingest filings and their report text from the filings.xbrl.org index for FR, NL, GB, ES, IT, SE and DK. Keep the index `published` date as the point-in-time date, the entity LEI, and the raw source reference. Map LEIs to security IDs through ISINs, after verifying a free ISIN to LEI source. Report DE and CH as having no evidence.
- [x] Unit: recorded index and filing fixtures cover a missing published date, an unmapped LEI, repeat sync, and late additions.
- [x] Live: ingest one recorded filing for each covered country, then query its dates, LEI and security ID.
- [x] Perf: ingest a fixed 50-filing fixture; fail above 120 seconds.

### PR 09. Point-in-time snapshots

- [x] Depends on 07, 08, and snapshot decision. Files: `packages/db`, `packages/data`, `packages/core`.
- [x] Freeze snapshot membership and provide as-of reads for documents and facts, including late ingestion and restatements according to the agreed policy.
- [x] Unit: future-dated documents never appear; test date boundaries, late arrivals, and last filed fact before the cutoff.
- [x] Live: load past, future, and amended records; query two dates against a frozen snapshot and inspect exact returned IDs.
- [x] Perf: query a fixed 10,000-record local dataset 100 times; fail above 10 seconds.

### PR 10. Prices and universe

- [x] Depends on 07 and the price-source decision. Files: `packages/data/providers`, `packages/db`, `packages/core`.
- [x] Ingest selected US, EU, UK, and Swiss EOD prices where coverage is sufficient and calculate point-in-time market cap and ADV with explicit missing-data handling. Apply region, cap, liquidity, and exclusion filters.
- [x] Unit: recorded source fixtures cover dates, missing values, filters, and repeat ingestion.
- [x] Live: load a 50-stock fixture and inspect each inclusion and exclusion reason.
- [x] Perf: filter 3,000 fixture securities; fail above 10 seconds.

### PR 11. Evidence retrieval

- [x] Depends on 08, 08b and 09. Files: `packages/retrieval`, `packages/db`, `packages/llm`.
- [x] Chunk SEC and ESEF filings by section, retain source offsets, embed with the pinned OpenRouter model from the embeddings decision, and combine text and vector results by reciprocal rank. Audit each embedding batch.
- [x] Unit: check chunk boundaries, fusion, security isolation, snapshot membership, and as-of filtering.
- [x] Live: index a recorded filing, retrieve a known quote for its security, and confirm a future filing is absent.
- [x] Perf: time 100 searches over a fixed 10,000-chunk local index with recorded query vectors; fail above 60 seconds. Exclude provider latency, and record the embedding model and provider.

### PR 11b. Jev passage relevance

- [ ] Depends on 05b and 11. Files: `packages/retrieval`, `packages/evals`.
- [ ] Add an optional Noul relevance filter or reranker over retrieved passages. Preserve company and point-in-time filtering in code.
- [ ] Unit: recorded decisions cover relevant, irrelevant, wrong-company, and future-dated passages.
- [ ] Live: run a recorded retrieval set and compare recall, ranking, and latency with PR 11. Inspect evidence IDs.
- [ ] Perf: run 100 fixture searches against the same corpus as PR 11; fail above 60 seconds or on a median regression above 25% against the measured trunk baseline.
- [ ] Enable for product use only after labelled evaluation and privacy requirements are satisfied. Record the decision and baseline.

### PR 12. Designer and framework

- [x] Depends on 05, 06, and 07. Files: `packages/agents`, `packages/prompts`, `packages/core`, `packages/db`.
- [x] Generate a validated framework with allowed sources, 3–8 KPIs, complete rubrics, weights, and at most one gate; preserve prompt version and model call records.
- [x] Unit: golden responses cover invalid weights, incomplete rubrics, unavailable sources, and invalid gate count.
- [x] Live: run a recorded gateway response for a sample brief and inspect the saved draft and audit row.
- [x] Perf: process 100 recorded drafts; fail above 30 seconds excluding model latency.

### PR 13. Analyst scoring

- [x] Depends on 09, 11, and 12. Files: `packages/agents`, `packages/prompts`, `packages/core`, `packages/db`.
- [x] Score each stock and approved KPI with retrieved local evidence. Quant functions and threshold bucketing run in code. Phase 1 has no Analyst tool loop.
- [x] Unit: cover unknowns, lookback, quantitative thresholds, wrong-security evidence, missing IDs, and non-verbatim quotes.
- [x] Live: score recorded evidence for one stock and inspect the persisted attempt and traceable citations.
- [x] Perf: validate 1,000 recorded scores; fail above 30 seconds excluding model latency.

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

- [x] Depends on 03, 07, 12, and identity decision. Files: `apps/web`, `apps/api`, `packages/core`, `packages/db`.
- [x] Add brief entry, validation, editable KPI rubric and weights, and authenticated approval that freezes a framework version and appends an attributable decision.
- [x] Unit: reject future dates, short briefs, infeasible weight caps, incomplete rubrics, and weights not summing to one.
- [x] Live: use the browser to submit a valid brief, edit a rubric, approve it, and inspect the frozen version and decision. Confirm invalid submissions remain blocked.
- [x] Perf: measure 100 local brief validation and approval requests; fail above 30 seconds excluding browser startup.
- [x] Obtain operator review of the interaction before merge.

### PR 15. Packaging and orchestration

- [x] Depends on 10, 13, 14, and the provisional-basket decision. Files: `packages/core`, `apps/worker`, `packages/db`, `apps/api`.
- [x] Advance idempotent jobs through the phase 1 stages, pause at gate 1, compute scores and contributions, apply gate and basket rules, caps, and weighting. Label output provisional until gate 2 exists.
- [x] Scope: the pure `packageBasket` in `packages/core` (gate, theme score, ranking, top N, weighting, cap redistribution); migration 0017 for the `analysing` to `packaging` path, `run_universe`, `baskets` and `basket_members` (a saved basket never changes); the pg-boss worker with the stages universe, Designer, prescreening, scoring and packaging; the API queues jobs and returns the basket and funnel; the run page shows progress and the provisional basket. The full basket UI and evidence are PR 16.
- [x] Unit: cover unknown modes, tie breaks, infeasible caps, failure and retry, gate enforcement, and repeat jobs.
- [x] Live: run a recorded 50-stock job through approval to a provisional basket; inspect funnel counts, weights, contributions, and restart behavior. The live job uses the real worker, API and browser, real SEC and ESEF evidence in a store ingested by `apps/worker/scripts/seed-pilot.ts`, real embeddings and the real Analyst model. Kill the worker during scoring and confirm the restarted worker finishes without repeating saved model calls.
- [x] Perf: time packaging 3,000 recorded securities; fail above 30 seconds excluding model calls. Replay the recorded scores of the live run, and time the pure function and the packaging stage on Postgres.

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
