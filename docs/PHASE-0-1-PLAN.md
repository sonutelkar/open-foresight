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
- **Unknown KPIs and caps.** Decided on 2026-11-22. A pure play run, which is the `strict` exposure style, scores an unknown KPI as level 0. A broad run drops it and renormalises the other weights. It caps the score at 0.8 when more than half the KPI weight is unknown. An unknown gate KPI fails the gate in both modes. When fewer names qualify than the weight cap needs to reach 100 percent, the cap is raised to the smallest feasible value, 100 over the name count, and the basket records that. Phase 1 omits the sector and region caps, the days-to-trade report and the factor tilt summary from the spec's basket construction. Each needs data or a decision that phase 1 does not have, and the basket does not claim them.
- **Thin evidence and over-credit.** Decided on 2026-11-23, after the PR 15 live run and the PR 16 trace of a Shoals quote to its filing. The quotes were verbatim, but the Analyst gave Shoals level 4 on a revenue share that the filing does not split by the KPI's offerings, and a lenient score on one KPI with 90 percent of the weight unknown tied at 0.8 and ranked first. Three layers fix it. PR 16b adds, in code, a known-weight floor of 40 percent for lenient runs and a cap at level 2 on a level 3 or 4 whose cited quotes name nothing from the KPI definition, and shows the lowered level in the evidence panel. PR 13c adds a Jev check of each cited span that can only lower a level. PR 16c adds a Jev exposure check that separates "not in this theme" from "no evidence". Each Jev layer is optional and code keeps final authority.
- **Gate method.** Decided on 2026-11-23, after the first PR 17 pilot run selected no names. The Designer made the gate KPI an extracted revenue share, which almost no company discloses, so 29 of 30 names scored unknown and the unknown gate removed all of them. A gate KPI must now be a judgement KPI, which validation enforces and the Designer prompt v3 states. A gate asks whether a company has any named offering in the theme, and only a judgement KPI can answer that and be settled by the Jev exposure check.
- **Jev privacy.** Decided on 2026-11-23. The operator considers the privacy sign-off for Jev product use satisfied. The requests still pin the provider, deny fallbacks, require ZDR and deny data collection. EU in-region routing remains unavailable, and the labelled evaluation and kappa gates below still decide whether each Jev feature is enabled by default.
- **Pilot decisions.** Decided on 2026-11-23. The pilot runs locally, so no host is chosen. The per-run budget is set later, and the 50 USD monthly OpenRouter cap stays the only limit. The operator confirmed the OpenRouter account privacy settings. The EODHD and Yahoo sources stay in use for this personal educational project, and the PR 17 live gate is not blocked by their terms. The first 200 labelled pairs are generated by AI and skimmed by the analyst, as the evaluation decision below says.
- **Jev default.** Decided on 2026-11-23. The Jev span check and the Jev exposure check are on by default. `JEV_SPAN_CHECK=0` and `JEV_EXPOSURE_CHECK=0` turn them off. Their thresholds stay provisional until the labelled pairs measure them, and the pilot reports each check's effect separately.
- **Evaluation.** AI may produce initial labels and an analyst will skim them. Treat results as provisional. The full kappa release gate still needs an independent labelled set. Agree a provisional pilot threshold separately; the existing full release threshold remains unchanged.
- **Reproducibility.** Freeze snapshot membership and the evidence versions available when the snapshot is created. Preserve original filing dates and versions, including late arrivals and restatements. Phase 2 owns full replay; phase 1 must not claim identical uncached model results.

## Landing order and dependencies

PR 01 starts on trunk. PRs 02, 03, and 04 depend on 01. PR 05 depends on 02 and 03. PR 05b depends on 05. PR 06 depends on 03 and 05. PR 07 depends on 02 and 03. PR 08 depends on 07. PR 08b depends on 07 and 09. PR 09 depends on 07 and 08. PR 10 depends on 07 and the price-source decision. PR 11 depends on 08, 08b and 09. PR 11b depends on 05b and 11. PR 12 depends on 05, 06, and 07. PR 13 depends on 09, 11, and 12. PR 13b depends on 05b and 13. PR 13c depends on 05b, 09, 11, and 13. PR 14 depends on 03, 07, and 12. PR 15 depends on 10, 13, and 14. PR 16 depends on 14 and 15. PR 16b depends on 15 and 16. PR 16c depends on 05b, 13 and 16b. PR 17 depends on 04, 16 and 16b plus the pilot and live-gate decisions. The later-phase Jev items depend on 05b and their respective base features. Dependencies may branch independently from the indicated landed PRs. Land in numeric order unless the dependencies and shared files are reconciled.

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

- [x] Depends on 05b and 11. Files: `packages/retrieval`, `packages/evals`. The work landed in `packages/retrieval` and `apps/worker/scripts`. The live script computes its own recall and rank, so `packages/evals` did not change.
- [x] Add an optional Noul relevance filter or reranker over retrieved passages. Preserve company and point-in-time filtering in code. `filterByRelevance` in `packages/retrieval/src/relevance.ts` first drops, in code, every passage from another issuer or dated after the as-of date, so Jev never sees it. Jev then answers one Noul per remaining passage, five passages to a call, and code keeps the passages at 0.5 or more in retrieval order. A failed call keeps every eligible passage and records the failure. It filters and does not rerank, because Jev's probabilities move between calls and the retrieval order is deterministic. Nothing in the Analyst or the worker calls it, so it is off. The 0.5 threshold is provisional.
- [x] Unit: recorded decisions cover relevant, irrelevant, wrong-company, and future-dated passages. `relevance.test.ts` replays real Jev decisions on 20 passages from Apple's 10-K, recorded in `packages/retrieval/fixtures/jev-relevance.json`. The test judge answers yes for any passage it has no recording for, so a wrong-company or future passage would be kept if code let it reach Jev. The tests also cover a failed call and a set with no eligible passage.
- [x] Live: run a recorded retrieval set and compare recall, ranking, and latency with PR 11. Inspect evidence IDs. `apps/worker/scripts/jev-relevance-check.ts` ran real Jev on a copy of the PR 17 store, over 12 scores of pilot run 3cc9c80f that cite passages. PR 11 returned the same evidence IDs the Analyst was offered in all 12. The labels are the 13 passages the Analyst cited. They come from the PR 11 top 10, so PR 11 keeps all 13 by construction.
  - The filter kept 11 of 13 cited passages and cut the passages offered from 120 to 65. A kept cited passage ranked 2.6 on average, against 4.6 in PR 11. 19 kept passages came from ranks 11 to 20.
  - It dropped the cited passages for Alstom at 0.49 and Alphabet at 0.18. Both backed a level 1 or unknown score, where the passage shows what the company does not report. Apple's cited passage scored 0.50 and Amazon's 0.51.
  - A first run of the same set kept 10 of 13. Between the two runs, 9 of 240 keep or drop decisions changed. The median probability change was 0.01 and the largest was 0.10.
  - The median search took 462 ms in PR 11 and 953 ms with the filter, of which Jev took 396 ms. The 48 calls cost 0.0082 USD, about 0.0007 USD a search, with no errors. The results are in `docs/pilot/jev-relevance-3cc9c80f-e6d0-4a3f-a34e-6c3fb562d152.json`. No human has labelled passage relevance.
- [x] Perf: run 100 fixture searches against the same corpus as PR 11; fail above 60 seconds or on a median regression above 25% against the measured trunk baseline. On trunk at 6d011ce, the 100 searches of the PR 11 perf test had a median of 1,293 ms over three warm runs, with a range of 1,052 to 1,629 ms, and 11 ms a search. The same perf test now also runs the 100 searches through the filter with a recorded judge, alternating with the plain search. That took a median of 1,117 ms, with a range of 1,039 to 1,297 ms, and 10.9 ms a search, against 10.7 ms for the plain search in the same runs. The test fails above 60 seconds or when the filtered median is 25 percent above the plain median. Provider latency is excluded.
- [ ] Enable for product use only after labelled evaluation and privacy requirements are satisfied. Record the decision and baseline. Open. The filter is off and nothing calls it. Enabling it needs a human-labelled passage relevance set that shows it keeps the evidence the Analyst needs, a threshold set from that set, and the privacy requirements confirmed for this use. The live run is a warning for that evaluation, because both cited passages it dropped were evidence for a low score. The baseline is PR 11 retrieval as measured above.

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

- [x] Depends on 05b, 09, 11, and 13. Files: `packages/retrieval`, `packages/agents`, `packages/evals`. The work landed in `packages/core`, `packages/agents` and `apps/worker`, because the check sits in the Analyst and needs no retrieval or evals change.
- [x] Add an optional path where code selects an exact stored span and Jev judges whether it supports the claim. Preserve source and snapshot references. `loadStoredSpans` reads each cited chunk back from Postgres and keeps it only when the chunk exists, matches its document, belongs to an issuer of the security, was available by the as-of date, and holds the quote verbatim. `verifyClaim` then asks Jev one Noul per span for the claimed level and steps down while the span does not support it, to a floor of level 1. Probabilities of at least 0.6 support a level, 0.4 to 0.6 keeps it with a recorded doubt, and a lower level needs at least 0.4. It can only lower a level, an outage keeps the level and records that the check did not run, and the original level stays in `raw`. It is on by default, and `JEV_SPAN_CHECK=0` turns it off. The thresholds are provisional.
- [x] Unit: reject nonexistent IDs, altered spans, wrong-company sources, and future evidence. `verifier.test.ts` covers each rejection, the step-down, the borderline note, an outage, and levels that are not checked, with a recorded judge. The existing validation tests keep covering the model's own citations.
- [ ] Live: compare citation validity, verbatim rate, and human-rated claim support with the existing extraction path on labelled examples. The labelled examples do not exist yet. `scripts/jev-span-check.ts` ran real Jev on the five level 3 and 4 judgement scores of the PR 15 run: 18 calls, 0.0007 USD, at most 305 ms. Two were lowered, AES from 3 to 1 and SU.PA from 3 to 2. Three were kept. Two of those were borderline, including Shoals at 0.54. Repeat calls moved a probability by about 0.1, so the 0.6 line is not stable on its own. No human has rated these verdicts.
- [x] Perf: validate 1,000 fixture citations. The stored-span read took a median of 17 ms against the 30 second ceiling. The trunk has no stored-span path, so there is no baseline. Provider latency is excluded.
- [x] Enable by default. The operator chose this on 2026-11-23. The 100% evidence-ID and 98% verbatim gates and the review of claim support are measured in PR 17.

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
- [x] Scope. Add the pure `packageBasket` in `packages/core`, covering the gate, theme score, ranking, top N, weighting and cap redistribution. Add migration 0017 for the path from `analysing` to `packaging` and for `run_universe`, `baskets` and `basket_members`. A saved basket never changes. Add the pg-boss worker with the stages universe, Designer, prescreening, scoring and packaging. The API queues jobs and returns the basket and funnel. The run page shows progress and the provisional basket. The full basket UI and evidence are PR 16.
- [x] Unit: cover unknown modes, tie breaks, infeasible caps, failure and retry, gate enforcement, and repeat jobs.
- [x] Live: run a recorded 50-stock job through approval to a provisional basket; inspect funnel counts, weights, contributions, and restart behavior. The live job uses the real worker, API and browser, real SEC and ESEF evidence in a store ingested by `apps/worker/scripts/seed-pilot.ts`, real embeddings and the real Analyst model. Kill the worker during scoring and confirm the restarted worker finishes without repeating saved model calls.
- [x] Perf: time packaging 3,000 recorded securities; fail above 30 seconds excluding model calls. Replay the recorded scores of the live run, and time the pure function and the packaging stage on Postgres.

### PR 16. Basket UI and evidence

- [x] Depends on 14 and 15. Files: `apps/web`, `apps/api`, `packages/core`.
- [x] Display the provisional basket, scores, weights, and per-name KPI evidence with source links and the phase 1 review limitation.
- [x] Scope. Add `GET /api/runs/:id/members/:symbol/evidence`, which returns each KPI's latest valid score with its rationale and cited quotes. Each quote carries a link to its SEC or ESEF source and a flag for whether it appears verbatim in the stored passage. The pure helpers `basketView`, `formatScore`, `quoteInPassage` and `esefReportLink` are in `packages/core/src/evidence.ts`. The run page lists the basket with the review limitation, and a name opens its KPI evidence on click. No migration and no new stored data.
- [x] Unit: cover empty and failed runs, score rendering, and evidence links. `packages/core/src/evidence.test.ts` covers the helpers and `apps/api/src/basket.test.ts` covers the endpoint on Postgres, including a quote that is not in its passage, an empty basket, and unknown names and run ids. The web app has no component test harness, so rendering is checked in the live step.
- [x] Live: open the recorded 50-stock basket in a browser and trace a displayed quote to the stored source. `apps/web/scripts/browser-live-basket.ts` opened the stored PR 15 run in Chromium, expanded the top name, and matched its displayed quote to the cited chunk text and its link to the stored filing URL. That run has a 14-name basket, because the PR 15 live run produced 14 selections. Screenshots are `docs/screenshots/pr16-1-basket.png` and `pr16-2-evidence.png`. It did not open the linked SEC page, which is a live external site.
- [x] Perf: measure local API response for a 50-name basket over 100 requests; fail above 10 seconds total. The basket and evidence endpoints took 810 ms for 100 requests each, a median of 4 ms each.
- [x] Obtain operator review of the interaction before merge. The operator reviewed the basket and evidence screens on 2026-11-23 and approved them.

### PR 16b. Evidence guards

- [x] Depends on 15 and 16. Files: `packages/core`, `packages/agents`, `packages/db`, `apps/worker`, `apps/api`, `apps/web`.
- [x] Lower a judgement score at level 3 or 4 to level 2 when no cited quote shares a term with the KPI definition. Drop a lenient name from the ranking when less than 40 percent of its KPI weight is known. Keep the model's original level in the audit row and show the change in the evidence panel.
- [x] Scope. Add `capUnsupportedLevel` in `packages/core/src/support.ts`, the `minKnownWeight` basket rule with the `thin_evidence` exclusion and funnel count, migration 0018 for `kpi_scores.adjustments`, and the replay script `apps/worker/scripts/replay-guards.ts`. A saved basket never changes, so the PR 15 basket is replayed read-only and not rewritten. The 40 percent floor is provisional.
- [x] Unit: cover each level, a quote that names an offering, a quote that does not, extraction KPIs, a name below, at and above the floor, and strict runs. The existing stub quotes now name the offerings they cite.
- [x] Live: replay the stored scores of the PR 15 run. Three KPI levels were lowered, including Shoals from 4 to 2 and Engie from 3 to 2. Shoals, Engie, Alstom and Plug dropped for thin evidence, and 10 of the 14 names remain with the cap relaxed to 10 percent.
- [x] Perf: the packaging perf tests on 3,000 recorded securities still pass with the floor on.

### PR 16c. Jev exposure check

- [x] Depends on 05b, 13 and 16b. Files: `packages/core`, `packages/agents`, `apps/worker`.
- [x] Settle a gate KPI at level 0 for a name that is outside the theme, so it fails the gate as a known non-match and not as a name with no evidence. Code selects up to four stored passages that describe the business, restricted to the security's own issuers and to evidence available by the as-of date. Jev answers one Choice with the options `core`, `partial`, `none` and `cannot_tell`, with the brief as the theme. Only `none` at 0.95 or more saves a valid level 0 score for a judgement gate KPI, with the Jev answer in `raw`, and the Analyst reuses it without a model call. Every other answer, a missing answer and a failed call save nothing, and the Analyst scores the name as usual. It never throws on a provider failure. It is on by default, and `JEV_EXPOSURE_CHECK=0` turns it off. The 0.95 threshold is provisional.
- [x] Unit: `exposure.test.ts` covers the thresholds. `analyst.test.ts` covers a confident none and the Analyst reusing it, core, partial, a doubtful none, cannot_tell and a failed call, no passages, another issuer's passages, future evidence, a name that already has a gate score, and a gate that is not a judgement. `stages.test.ts` drives a run through the real stage and checks the funnel and that the gate call was spared.
- [ ] Live: compare the check with labelled examples. There are none yet. `scripts/jev-exposure-check.ts` ran real Jev read-only on the 32 scored names of the PR 15 run: 26 calls, 0.004 USD, a median of 206 ms and at most 365 ms. At the 0.95 threshold 10 of the 12 `none` answers hold. They are Apple, Amazon, Alphabet, Johnson & Johnson, JPMorgan, Coca-Cola, LVMH, Microsoft and Procter & Gamble, plus ASML, which the Analyst had given gate level 1 and which sits in the PR 15 basket. First Solar at 0.90 and Nvidia at 0.93 stay unknown. Alstom at 0.88, Vestas at 0.78 and Plug at 0.67 stay unknown, and Bloom Energy was `partial`. Six names have no filing passages in the store, so the check does not run for them. No human has rated these verdicts. At the 0.9 line First Solar would have been settled as no exposure, which is why the line is 0.95.
- [x] Perf: one Jev call per name. The live calls had a median of 206 ms, and the worker scores names in parallel with the Analyst. Provider latency is excluded from the ceiling, and the trunk has no exposure path, so there is no baseline.
- [x] Enable by default. The operator chose this on 2026-11-23, before any labelled evaluation. The false-none rate on labelled pairs is still to be measured and reported in PR 17.

### PR 17a. Coverage gaps

- [x] Depends on 08, 08b and 15. Files: `packages/core`, `packages/db`, `packages/retrieval`, `apps/worker/scripts`.
- [x] Give three pilot names filing evidence. Exxon Mobil mapped to the new holding company, CIK 2115436, which has filed no 10-K, so it is linked to Exxon Mobil Corp, CIK 34088. SAP and Nokia file English 20-F reports with the SEC and have no usable ESEF route, because the filings index has no German reports and GLEIF lists no ISIN for Nokia's LEI. The seed script now takes the newest 10-K, 20-F or 40-F.
- [x] Scope. Add `issuerAliases` and `annualForms` in `packages/core`, migration 0019 for `security_issuers`, `linkIssuerAliases` in `packages/retrieval`, and `issuerKeysForSecurity` now adds the linked issuers. Add `scripts/check-coverage.ts`. The seed script gates each part on its own phase, because a rerun of `sec` ingested a new version of every filing and embedded it again for 0.065 USD. Nokia's Finnish ESEF report is not ingested, because the 20-F is in English. The 20-F facts use the IFRS taxonomy, so the US GAAP quant functions return unknown for them.
- [x] Unit: `issuer-aliases.test.ts` checks the keys, and `issuers.integration.test.ts` checks that a link is added once, keeps existing issuers, and reports symbols with no resolved security.
- [x] Live: on a copy of the PR 15 store, the three filings were ingested and indexed, with 199 chunks for Exxon, 365 for SAP and 319 for Nokia. The Jev exposure check then read their business passages. SAP is `none` at 0.97, Exxon is `none` at 0.91 and Nokia is `none` at 0.94, so the last two stay unknown under the 0.95 line. Siemens, E.ON and RWE still have no passages.
- [x] Perf: n/a. This changes ingestion and one lookup, not the run path.

### PR 17b. Report discovery

- [x] Depends on 17a and 05b. Files: `packages/core`, `packages/db`, `packages/data`, `packages/llm`, `packages/retrieval`, `packages/agents`, `apps/api`, `apps/worker/scripts`. The operator asked for this on 2026-11-23, for companies with no annual report in the store, such as Siemens, E.ON and RWE.
- [x] A cheap model with the OpenRouter web search tool proposes URLs. It never fetches or scores. `createDiscoverer` uses `anthropic/claude-haiku-5.5`, asks for ZDR and no data collection, and if no provider can serve that way it warns once, repeats without ZDR, and records `zdr: false`. `discoverReport` filters the URLs to the company's allow-list in `reportSources`, hands them to the fetcher, and records every attempt in `report_discovery_attempts`, with the model call audited there because discovery has no run. A company with a stored report is skipped, and so is one tried in the last 7 days.
- [x] The fetcher is `createWebReportsProvider`. For each URL it requires https, an allow-listed host at every redirect hop, robots.txt, and a delay between requests to one host. It sends `If-None-Match` and `If-Modified-Since`, rejects 401 and 403 as `login_required`, extracts PDF pages with `unpdf` or HTML with the core extractor, and requires the company name in the first 20,000 characters. A stored `web_documents` row has the extracted text, a heading at each page start, the ETag, and the first fetch time. `availableOn` is that day, so the report is evidence only for as-of dates on or after it. New bytes at one URL are a new row. The same bytes at a second URL, such as a mirror, are the same report, which a unique index on company and content hash enforces.
- [x] The new `web_report` document kind runs through indexing, search, snapshots, the Analyst and the evidence API, with migrations 0020 to 0024. Web reports are read under the `esef_filings` source, because the Designer only searches the sources a KPI names. The evidence panel links a quote to the fetched URL.
- [x] Scraping rules. Plain fetch with Readability for static pages and `unpdf` for PDFs, as the operator specified. Respect robots.txt and each site's terms, rate-limit per host, cache by URL and ETag, keep a domain allow-list per company, and never fetch paywalled or login-only content. Where a site requires contact details the command sends the generic client name `open-foresight-educational`.
- [ ] Option, not implemented. Crawlee with Playwright for investor sites that need JavaScript to show a report. No company in the current list needed it, so it is not built. E.ON's report site answered 401 or 403 to a plain request, which a headless browser might get past, but that would work around the site's block and needs the operator's decision before it is tried.
- [x] Unit: `discover.test.ts`, `discovery.test.ts`, `report-sources.test.ts`, the provider tests for every rejection reason, robots rules, redirects, rate limit, 304, repeat and mirrored bytes, and the retrieval, snapshot and API tests for the new kind.
- [x] Live: `scripts/discover-reports.ts` on a copy of the PR 15 store. Siemens was stored by the fetch check, RWE stored its English annual report and its German report, and E.ON's report site answered 401 or 403, so it was recorded as `login_required` and skipped. Indexing the three reports cost 0.018 USD in embeddings. Each discovery search cost about 0.0075 USD. The Jev exposure check then read the new passages. Siemens is `core` at 0.90 and RWE is `partial` at 0.71, where both had no evidence before. The first RWE run stored the same PDF twice under two URLs, which led to the unique index.
- [x] Perf: a generated 200-page PDF with 943,000 characters goes through `sync` in about 330 ms.
- [ ] Not built. A retry for a site that blocks automated requests, such as E.ON's report site, and a run of discovery at worker startup. Discovery is an explicit command, so a run is never delayed or changed by a web search. The Yahoo fallback below covers E.ON for the exposure check.

### PR 17c. Company profile fallback

- [x] Depends on 17a and 17b. Files: `packages/core`, `packages/db`, `packages/data`, `packages/retrieval`, `packages/agents`, `tools/yahoo`, `apps/worker/scripts`. The operator asked for a test of this on E.ON on 2026-11-23, and accepted no evidence if it failed.
- [x] Test first. Yahoo returned a 1,500 character business summary for E.ON, and real Jev read it as `core` exposure at 0.73. The same method on RWE's summary gave `partial` at 0.92, close to its filing-based `partial` at 0.71. So the fallback works, and it was built.
- [x] Scope. `tools/yahoo/profile.py` reads the name, sector, industry and summary through yfinance and uv. `createYahooProfileProvider` stores each summary of 200 characters or more as a `web_documents` row with the content type `text/x-company-profile`, dated by its fetch day. The indexer chunks it as a new `company_profile` kind, and migration 0025 allows that kind. Only the exposure check reads it, because the Analyst's sources never include the kind, so no KPI is scored from a Yahoo summary and no citation points to one. `scripts/fetch-profiles.ts` finds universe names with no passages and fetches only those.
- [x] Unit: `profile.test.ts` covers storing, repeat fetches, short summaries, errors, unsupported symbols, a rate limit and a failing reader. The retrieval test checks that a profile is returned only by a `company_profile` search and not by a report search.
- [x] Live: of the 32 names in the PR 15 run, only E.ON had no passages. The command stored its profile, indexing cost 0.000006 USD, and the exposure check through normal retrieval read E.ON as `core` at 0.75.
- [x] Perf: n/a. One Yahoo call per uncovered name, with a one second pause between names.
- [ ] Limits. Yahoo's terms bar automated collection, so this is for the personal educational pilot only, as the plan already records. A profile is a short third party description. It can settle exposure and nothing more.

### PR 17. Pilot and phase gate

- [x] Depends on 04, 16, 16b, 16c, 17a, 17b and 17c, and the pilot, hosting, model, budget and eval decisions, all made on 2026-11-23. Files: `packages/evals`, `packages/core`, `packages/prompts`, `config/models.ts`, `apps/worker/scripts`, `apps/web/scripts`, `docs/pilot/` and `packages/evals/fixtures/pilot-citations.json`.
- [x] Add a reproducible 50-stock pilot procedure and citation evaluator. `evaluateCitations` in `packages/evals` checks every citation four ways against the stored text, which are that the evidence ID was offered and its chunk exists, that the quote is word for word in the chunk, that the chunk was available by the as-of date, and that the chunk belongs to an issuer of the security. `scripts/pilot-report.ts` reads one run from Postgres without writing to it and writes a versioned report to `docs/pilot/` with the source snapshot, models and providers, cost, approval, timestamps and the measured results. It also repeats the citation checks on the basket members alone. `scripts/browser-live-run.ts` drives the run through the real UI.
- [x] Gates. The report passes only when the basket has at least one name, machine time is under 30 minutes, 100 percent of citation IDs exist, and at least 98 percent of quotes are verbatim. A pilot with no selected names fails, because passing the citation gates on an empty basket means nothing. Release gates are reported apart and are never shown as met on an AI-labelled set.
- [x] Unit: a missing citation ID, an altered quote, a future document and another company's document each fail, 49 of 50 verbatim passes and 48 of 50 fails, an empty denominator never passes, and the report schema rejects a hand edit that claims a pass. The same checks pass on the recorded real citations of the pilot, and fail once one quote is altered.
- [x] Live, on the local host, through the browser with the real Designer, Analyst, Jev checks and the 50-name store. All four runs finished in under 30 minutes with 100 percent valid citation IDs and 100 percent verbatim quotes. The denominators are in `docs/pilot/pilot-<run id>.json`.
  - Run 1 took 6.5 minutes and selected no names. That exposed the gate problem above, and its report fails.
  - After the fix, run 2 used the `broad` style. It selected 18 names in 6.5 minutes for 0.30 USD, with 136 of 136 citations valid and 119 of 119 for the basket members.
  - Run 3 repeated the same brief and replayed the gateway cache. It selected the same 18 names, matched 158 of 159 non-quant levels, and cost 0.0015 USD. It took 10.9 minutes because of a slow stretch of provider calls that was not explained.
  - Run 4 used the `strict` pure play style. It selected 10 names in 7.0 minutes for 0.32 USD, with 132 of 132 citations valid and 66 of 66 for its members. The real Designer chose a judgement gate.
- [x] Perf: the packaging stage on the recorded 50-name scores has a median of 161 ms on trunk and 168 ms on this branch over three runs each, a 4 percent change against the 25 percent limit. Citation evaluation of 1,088 recorded citations takes 25 ms. Both are well under 30 minutes, and external provider latency is excluded.
- [x] Labelled set, provisional. All 200 pairs are labelled by `google/gemini-3.1-pro-preview`, a third vendor different from the Analyst and the Designer, for 2.99 USD. The set is AI-generated and is not the full release gate. The pool is 215 judgement pairs across four runs, sampled by the Analyst's level. Weighted kappa is 0.585 over the 196 pairs that have a level on both sides, with a bootstrap 95 percent interval of 0.49 to 0.68, and 38 percent of resamples reach the 0.6 line. Exact agreement is 63 percent, and the labeller answered unknown on 4 pairs and the Analyst on none. Of the 73 disagreements, the labeller reads lower than the Analyst in 53, so the Analyst is the more generous reader of the rubric. The pool is skewed to low levels, with 100 of 200 at level 1 and one pair at level 4, so kappa says little about the top levels. The runs share the theme and the stocks, so the pairs are not independent draws. The full kappa gate of 0.6 and the stability gate of 95 percent need a human-labelled set and a rerun with caching off, and are not met. The set is in `docs/pilot/labels-9875a20c-19dd-4703-8b07-326f6ddb05e1.json`.
- [x] Obtain operator review of the provisional basket and gate evidence before merge. The operator reviewed the pilot basket and its evidence on 2026-11-23 and approved the merge.

The phase 0 gate requires the two live model calls and a no-network cache hit. The phase 1 gate requires PR 17's live measurements and PR 09's point-in-time tests. Reviewer, gate 2, pre-screen, full-scale processing, full replay, and discovery remain later-phase work. A fixture run does not satisfy either live gate.

**Phase 1 status.** Recorded on 2026-11-23. The phase 1 gate is met. PR 17 has the live measurements, with four pilot runs under 30 minutes, 100 percent valid citation IDs and 100 percent verbatim quotes, and PR 09's point-in-time tests pass. Phase 1 is complete, and the next steps are the operator's phase review and then phase 2.

Three things are not claimed. The full kappa gate of 0.6 and the stability gate of 95 percent are not met, because the labelled set is AI-generated and needs a human-labelled set and a cache-off rerun. The pilot ran on the local 50-name store and not the 3,000-stock universe, which belongs to the later phases. PR 11b and PR 13b are optional Jev bake-offs that were not started. The gate does not require them, so they move to phase 2 with the later-phase Jev items.

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
