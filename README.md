# Open Foresight

Use Node.js 22 and Bun 1.3.6. From the repository root, run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

The project scope is in [docs/SPEC.md](docs/SPEC.md).

## Local services

Install Docker Desktop or Docker Engine with Compose. Create a local `.env` file with unique development credentials:

```sh
(
  set -C
  {
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'MINIO_ROOT_USER=%s\n' "$(openssl rand -hex 12)"
  printf 'MINIO_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'CLICKHOUSE_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'LANGFUSE_SALT=%s\n' "$(openssl rand -hex 24)"
  printf 'LANGFUSE_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'LANGFUSE_NEXTAUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
  } > .env
)
```

Use hexadecimal values for these fields. The database password is embedded in a connection URL. Keep `.env` and the persistent volumes when restarting the stack.

```sh
docker compose up -d --wait
```

Langfuse is at <http://localhost:3000>, MinIO's S3 API is at <http://localhost:9090>, and its console is at <http://localhost:9091>. PostgreSQL listens on `localhost:5432` with user and database `foresight`. All exposed ports bind to localhost. Stop containers with `docker compose down`. This preserves named volumes. The Langfuse worker and web service also use ClickHouse and Redis internally.

## Database migrations and tests

After starting the local services, set `DATABASE_URL` to the Postgres connection URL for the `foresight` database. The password must be URL-encoded if it contains special characters. Apply migrations from the database package:

```sh
cd packages/db
bun run migrate
```

Run the database integration tests against a separate, disposable database. They insert persistent audit records and do not delete them. Set `TEST_DATABASE_URL` to the migrated test database, then run `bun run test` in `packages/db`. Without that variable, the database tests are skipped. CI runs them against a dedicated PostgreSQL service.

## Run the fixture evaluation

Build the evaluation package, then run the checked-in example with a new output path:

```sh
bun run --cwd packages/evals build
bun run --cwd packages/evals eval fixtures/example.json fixtures/baseline.json /tmp/open-foresight-eval-result.json
```

The fixture contains recorded expected and actual strings. The runner computes their exact-match rate and compares it with both the baseline minimum and the baseline value minus the allowed drop. The example thresholds demonstrate the format and are not product release thresholds. The JSON result records schema version 1, each case, the metric, and the two checks. A failed threshold still writes the result and returns a nonzero exit code. Missing or invalid inputs fail without a result. The runner refuses to overwrite an existing output file. This skeleton does not call a model or measure the other product metrics yet.

## OpenRouter gateway

The gateway in `packages/llm` accepts an OpenRouter API key, a Drizzle database, and a non-empty registry of roles and model slugs. The selected Designer and Analyst models are in `config/models.ts`. Edit that file to change them. Set `OPENROUTER_API_KEY` in the local `.env` file and pass it to `createGateway` as `apiKey`.

Call `createGateway` at startup. For each model, it selects the lowest estimated cost eligible ZDR provider that supports structured output and tools. It estimates cost for 1,000 input and 1,000 output tokens from the endpoint's per-token prompt and completion prices and its per-request fee when provided. The estimate assumes an omitted per-request fee is zero; this is not guaranteed by OpenRouter. It excludes other fees and does not guarantee the lowest actual total. Providers with missing, malformed, negative, or non-finite prompt or completion prices, or an invalid provided per-request fee, are excluded; explicit zero prices are eligible. Equal estimates are ordered by provider tag. The selected provider is pinned for the gateway's lifetime, and the request parameters record it. Startup fails if no eligible provider is found. Call `generate` with a run ID, role, prompt version, system and user text, Zod schema, and evidence IDs. Each request and any repair attempt is recorded in `llm_calls`. Requests pin the selected provider and disable fallbacks, require supported parameters, deny data collection, and require ZDR. The gateway sends `temperature: 0` only when the selected ZDR endpoint supports it. Otherwise it omits temperature, so temperature-zero reproducibility is not guaranteed. The audit parameters record what was sent. A database write failure fails the call. Configure OpenRouter account-level privacy settings as well. Set the agreed $50 monthly spending cap in your OpenRouter account. The gateway does not enforce that cap.

Gateway integration tests use a local fixture HTTP server and a disposable migrated PostgreSQL database. Build the workspace, set `TEST_DATABASE_URL`, and run `bun run --cwd packages/llm test`. Without the variable, these integration tests are skipped. The tests do not call OpenRouter.

To check both selected models against OpenRouter, configure `OPENROUTER_API_KEY` in `.env`, set `DATABASE_URL` for a migrated database, and run the following command from the project root. This makes paid requests and creates a run and audit rows. Each request is capped at 32 output tokens; an invalid output can trigger one repair request per model. Input tokens and model-specific prices also contribute to the charge. The account's $50 monthly cap must be configured in OpenRouter.

```sh
bun run packages/llm/scripts/live-smoke.ts --confirm-paid-live
```

The command checks provider capabilities before making model calls. It stops if an endpoint does not report support for the required settings.

## Jev decisions

The gateway exposes `decide()` for Noul, Choice, and Score questions. It uses the alpha Decisions API with a pinned TypeSafe provider, ZDR and data-collection denial. Each attempt is recorded in `llm_calls`. Jev requests are not cached. The gateway does not enforce the OpenRouter monthly budget. Long state over 32,000 UTF-8 bytes is flagged in the returned result. See [the contract](docs/jev-contract.md) and [evaluation note](docs/jev-evaluation.md).

### Cache and agent loop verification

Run `TEST_DATABASE_URL=postgres://... bun run --filter @open-foresight/llm test` against a migrated local PostgreSQL database. The fixture server tests two identical generation calls, one upstream request, and tool-call audit records. It also prints three timings for 100 persistent cache hits and checks the median against five seconds. The trunk baseline is not applicable because it has no cache-hit path.

`runAgent` budgets output tokens. Each turn reserves three times `maxOutputTokens` before calling the gateway, covering the initial request and the bounded repair and transport retry. The provider must honor the output cap. This is not a monetary or input-token limit. Tool implementations must read only the local PostgreSQL store. The API cannot prevent a caller from implementing a tool that accesses the network. Identical requests are deduplicated within one gateway instance; separate processes can issue simultaneous misses.

## Security master

`@open-foresight/data` provides `createSecSecurityProvider`. Supply a Drizzle database and an SEC user agent with contact details, then call `sync()`. It fetches the SEC ticker and exchange list and OpenFIGI mappings. The provider stores SEC listings separately from FIGI candidates, creates stable security IDs for unambiguous matches, and leaves conflicting issuer or FIGI mappings unresolved. The sync report counts prior links that were changed to unresolved in `reclassified`. The provider keys each security on the OpenFIGI `shareClassFIGI`, so every venue listing of one share class shares one security ID. A candidate with no `shareClassFIGI` is keyed by its listing FIGI. The provider collects and validates responses before writing and commits each sync in one transaction. Concurrent writers acquire the same PostgreSQL advisory transaction lock. It respects OpenFIGI batch limits and retries rate limits. An OpenFIGI API key is optional.

The SEC list is a current association file, not a point-in-time universe or a complete European security list. The stored observations and mapping candidates are updated on repeat sync; they do not yet preserve snapshot history. European coverage and point-in-time membership require additional sources and later snapshot work. The EODHD adapter is not implemented by this ticket.

To run the fixture checks against a disposable migrated database, set `TEST_DATABASE_URL` and run `bun run --cwd packages/data test`. The OpenFIGI fixture contains responses recorded on 2026-11-22 for AAPL, MSFT, and GOOG. The SEC example and ambiguous and error cases are constructed fixtures. Tests make no external requests. They check repeat sync, unresolved mappings, retries, and the 1,000-listing fixture ceiling.

To verify the local HTTP and PostgreSQL path separately, set `TEST_DATABASE_URL` and run `bun run --cwd packages/data test -- src/real-server.integration.test.ts`. The test starts a loopback fixture server, syncs twice, and checks stable IDs, row counts, and unresolved candidates.

## SEC filings and facts

`createSecEdgarProvider` fetches SEC submissions, selected filing documents, and company facts. Supply a Drizzle database and an SEC user agent with contact details. Call `sync({ cik, accessions })` with the SEC issuer CIK and the filing accession numbers to ingest. The provider follows historical submissions files when needed. It stores each response body, its canonical SEC URL, the actual transport URL, the source hash, and the fetch time. Different transport origins remain distinct even if their bytes match. Filing and fact records retain filing dates separately from period dates. Facts link to the source response and a JSON pointer. An amended filing has its own accession and does not overwrite the original.

The provider schedules SEC requests at least 150 ms apart within one process. It does not coordinate the limit with other processes or with the security-master provider. Coordinate those callers externally before running them together. The provider records the full body it receives; the checked-in filing fixtures are normalized excerpts, not full SEC documents. Tests fetch fixture data from a local HTTP server and record its transport URL alongside the canonical SEC URL. The SEC company-facts API does not contain every company disclosure or tagged segment. This provider covers SEC data, not a European filings universe.

Set `TEST_DATABASE_URL` to a disposable migrated PostgreSQL database and run `bun run --cwd packages/data test -- src/providers/sec-edgar/index.test.ts` to verify the loopback HTTP and database path. To run the 50-company fixture timing check, also set `SEC_50_COMPANY_PERF=1` and run `bun run --cwd packages/data test -- src/providers/sec-edgar/perf.test.ts`. That check constructs 50 CIKs from one recorded Apple fixture; it does not represent 50 independently recorded companies or live SEC latency.

## Point-in-time snapshots

`createSnapshot({ db })` in `@open-foresight/db` copies the IDs of SEC filings and facts ingested at or before a cutoff into append-only membership tables. The cutoff defaults to now. A record ingested later is not a member, including a late arrival with an old filing date. Create a new snapshot to include it.

`filingsAsOf` returns snapshot filings filed on or before an `asOf` date in `YYYY-MM-DD` form. The date is inclusive. `factsAsOf` returns, for each CIK, concept, unit and period, the fact filed most recently on or before `asOf`. A restatement filed after `asOf` is not returned. An earlier restatement replaces the original. Filing dates have no time, so same-day facts are ordered by accession number.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/db test` against a disposable migrated database. Turbo does not pass the variable through, so `bun run test` skips these tests. The test loads past, future, amended and late-arriving records, queries several dates against two snapshots, and asserts the exact record IDs. It also times 100 as-of query pairs over 10,000 local records against a 10 second ceiling. One local run took about 2 to 3 seconds. Trunk has no snapshot reads, so there is no trunk baseline. This covers SEC data only. Prices and European sources are later work.

## Prices and universe

`createEodhdProvider` in `@open-foresight/data` ingests EODHD end-of-day bars into `price_bars`. It returns `undefined` when `EODHD_API_KEY` is missing or blank, so nothing else depends on it. Call `sync({ symbols, from, to })` with EODHD codes such as `AAPL.US`, `VOD.LSE`, `SAP.XETRA` and `NESN.SW`. Each fetched bar is stored as a version keyed by a hash of its content. A corrected bar adds a row and never overwrites the original, so a snapshot keeps seeing what it saw. A 404 puts the symbol in the report's `unknown` list, and an empty answer puts it in `empty`. Both are coverage gaps, not errors. Errors name the symbol and never include the API key.

`buildUniverse` in `@open-foresight/data` reads bars through `pricesAsOf` in `@open-foresight/db`. It counts only bar versions ingested at or before the snapshot cutoff and only bars dated on or before the as-of date. `screenUniverse` and `deriveMetrics` in `@open-foresight/core` are pure. They return one decision per symbol with every reason that applies: `unsupported_exchange`, `region_not_allowed`, `excluded_by_rule`, `no_price`, `stale_price`, `fx_unavailable`, `market_cap_unavailable`, `below_min_market_cap`, `adv_unavailable` and `below_min_adv`.

ADV is the mean of close times volume over the last `advWindow` bars that have a volume, at least `minAdvBars` of them. Market cap is shares outstanding times the last close. Shares come from the SEC `EntityCommonStockSharesOutstanding` fact filed most recently on or before the as-of date, so only listings with a `cik` that SEC facts cover can have a market cap. A listing without shares falls back to a recent observed market cap (see Market cap observations). Every listing with neither is excluded as `market_cap_unavailable`. The EODHD fundamentals endpoint returns 403 on the EOD plan, and the free FMP and Finnhub tiers returned no non-US data when tested. Thresholds are in USD. Build `fxToUsd` for the rules with `fxToUsdAsOf` from the ECB rates below. A currency with no recent rate gets `fx_unavailable`. London quotes are in pence and are scaled by 0.01.

`packages/data/fixtures/eodhd/eod-bars.json` holds real EODHD responses for 50 symbols, recorded by `scripts/record-eodhd-fixtures.ts`. In `universe-50.json`, the shares and CIKs are constructed. FX comes from the recorded ECB file. Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/data test` against a disposable migrated database. Turbo does not pass the variable through, so `bun run test` skips the database tests. The test serves the recorded responses from a loopback server, ingests them twice, and prints the include or exclude decision and reasons for all 50 names. The perf test filters 3,000 generated securities with 30 bars each through the full Postgres path. Three warm runs took about 0.2 seconds each against a 10 second ceiling, and trunk has no equivalent operation. Universe membership is returned, not stored. Storing it with a run belongs to the orchestration ticket.

## FX rates

`createEcbFxProvider` in `@open-foresight/data` ingests ECB euro reference rates into `fx_rates`. It is free and needs no key. Call `sync({ currencies, from, to })` with codes such as `USD`, `GBP`, `CHF`, `DKK`, `SEK` and `NOK`. Rates are units of currency per euro. The ECB publishes on business days only. Each rate is stored as a version, so a revised rate adds a row and never overwrites the original.

`fxToUsdAsOf({ db, snapshotId, asOf, currencies })` returns USD per unit of each currency. It takes the latest rate on or before `asOf` that the snapshot saw, and ignores rates older than `maxStaleDays` (default 5). A weekend date uses Friday's rate. It returns nothing when the USD rate is missing. Pass the result as `fxToUsd` in the universe rules.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/data test` for the fixture tests. The fixture `fixtures/ecb/exr-2024-11.csv` is a real ECB response. To check the live service, run `TEST_DATABASE_URL=postgres://... bun packages/data/scripts/ecb-live.ts` from the repository root. It loads the last 14 days twice and prints the conversion. The second load inserts nothing.

## Exchange listings and share classes

`securities.share_class_figi` is the company-level identity. Migration 0010 backfills it from the stored OpenFIGI candidates and fails if two securities share a class, so resolve duplicates before migrating a database that already has data. `securities.figi` is now optional. It holds the first listing FIGI seen, and is null for a security first created from a share class.

`createEodhdListingsProvider` in `@open-foresight/data` links EODHD common-stock listings to securities. It returns `undefined` without `EODHD_API_KEY`. Call `sync({ exchanges, only? })` with EODHD exchange codes such as `US`, `XETRA`, `SW` and `LSE`. It reads each exchange symbol list (one EODHD call each), maps the ISINs through OpenFIGI, and writes one `exchange_listings` row per symbol. `status` is `resolved` when the ISIN names exactly one share class, `ambiguous` when it names several, `unmatched` when OpenFIGI finds none, and `no_isin` when EODHD has no valid ISIN. Only `resolved` rows get a `security_id`. Listings of the same ISIN on different venues share it. EODHD US listings join the SEC master through the same share class. Without an OpenFIGI key the limit is 10 jobs per request and about 25 requests a minute, so 1,500 ISINs take about 6 minutes.

EODHD reports London prices in pence, with currency `GBX`. The universe screen already scales the `LSE` exchange by 0.01.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/data test` for the fixture tests. The fixtures in `packages/data/fixtures/openfigi-isin` are real EODHD symbol rows and real OpenFIGI responses, trimmed to six venues each. The second SAP venue, the ETF, and the bad, ambiguous and unmatched ISINs are constructed. To check the live services, run `EODHD_API_KEY=... TEST_DATABASE_URL=postgres://... bun packages/data/scripts/listings-live.ts` from the repository root. It maps four real listings twice and prints each share class. The second run creates no new securities.

## Market cap observations

Two optional providers write current shares outstanding and market caps into `market_cap_observations`. Both read Yahoo Finance, whose terms bar automated collection. They are for personal, educational use, the project owner accepted that risk, and neither may be used commercially. Neither runs unless a caller constructs it.

`createYahooProvider` in `@open-foresight/data` runs `tools/yahoo/fetch.py` with `uv`, which installs the pinned `yfinance` package into `tools/yahoo/.venv`. Run `uv sync --project tools/yahoo` once, or let the first call do it. Call `sync({ symbols })` with EODHD style symbols. Each symbol maps to its Yahoo ticker (`SAP.XETRA` becomes `SAP.DE`). The script waits one second between symbols. It stops at the first rate limit, reports `rateLimited` and `notAttempted`, and never retries. It adds no proxies. It returns shares, market cap, price and currency. Yahoo quotes London in pence, and the provider converts those caps and prices to pounds. A symbol with an error or no value goes in `missing`, and one on an exchange without a Yahoo mapping goes in `unsupported`. Reading 1,500 names takes roughly an hour.

`createApifyMarketCapProvider` reads market caps through the Apify actor `architjn/yahoo-finance`. It returns `undefined` without `APIFY_TOKEN`, sends batches of 25 with a hard spend cap per batch (default $0.25), and charged $0.0009 per result when tested. The actor returns no share count, and it writes the string `N/A` for values Yahoo did not return, which the provider treats as missing.

An observation is a snapshot of its fetch day, so it never applies to an earlier date. `marketCapsAsOf` returns the latest observation on or before the as-of date and at most `maxAgeDays` calendar days earlier (default 7 in `buildUniverse`). For market cap, `buildUniverse` uses the first available of these, and each decision reports it as `marketCapSource`.

1. `shares_x_close`, from an SEC filing share count.
2. `observed_shares_x_close`, from observed shares times the as-of close.
3. `observed`, an observed market cap.

Observed values suit runs for today, not backtests.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/data test` for the fixture tests. `fixtures/yahoo/fetch-lines.jsonl` is real output of the Python script, and `fixtures/apify/yahoo-finance-12.json` is real actor output. The uv runner test starts the real script on an empty list and is skipped when `uv` is missing. To check the whole path against the live services, run `EODHD_API_KEY=... TEST_DATABASE_URL=postgres://... bun packages/data/scripts/universe-live.ts` from the repository root. It reads Yahoo through `uv` by default, or Apify with `CAPS=apify` and `APIFY_TOKEN`. It prints every decision for the 50 fixture names.

## ESEF filings

`createEsefProvider` in `@open-foresight/data` reads European annual reports from the free filings.xbrl.org index, and the ISINs GLEIF lists for each issuer. It needs no key and sends a generic User-Agent with no contact details. Call `sync({ isins })` or `sync({ leis, perLei })`. An ISIN is resolved to its issuer LEI through GLEIF. The provider then lists the LEI's ISINs into `lei_isins`, reads the newest `perLei` filings (default 1) from the index, and stores each raw XHTML report in `esef_documents`. Reports are 1.5 to 20 MB, and the provider skips any over 64 MB and lists them as `tooLarge`. The index holds filings for FR, NL, GB, ES, IT, SE and DK, and none for DE or CH. An issuer with no filing goes in `noFilings`.

A filing belongs to an issuer, so a filing carries a LEI and not a security. `securityIdsForLeis` finds the securities for a LEI by joining its GLEIF ISINs to listings already resolved by the EODHD listings provider. An issuer with several share classes has several securities. GLEIF lists debt ISINs too, and those match no listing.

The availability date is the index `published` date when present, else the date the index added the filing. The index leaves `published` empty for many filings, such as all the Danish and British ones I checked. A filing that is re-processed with a new package hash is stored as a new version. `createSnapshot` freezes ESEF filings along with SEC filings, and `esefFilingsAsOf` returns the snapshot's filings available on or before a date. Text is extracted from the raw report when it is chunked, so extracted offsets stay tied to a known extractor version.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/data test` for the fixture tests. The fixtures in `packages/data/fixtures/esef` are real index and GLEIF responses for A.P. Moller Maersk, plus a 206 KB excerpt of its real report, recorded by `scripts/record-esef-fixtures.ts`. The 50-filing timing test serves that excerpt for 50 constructed LEIs from memory, so it excludes network time. To check the whole chain against the live services, run `EODHD_API_KEY=... TEST_DATABASE_URL=postgres://... bun packages/data/scripts/esef-live.ts` from the repository root. It resolves six real listings, downloads five annual reports of about 160 MB in total, and prints each filing's availability date and visibility.

## Evidence retrieval

`@open-foresight/retrieval` indexes SEC and ESEF filings as passages and searches them for one security at a time.

**Extraction.** `htmlToText` in `@open-foresight/core` turns HTML, XHTML or inline XBRL into plain text. Inline elements join without a separator, because the real ESEF reports are PDF conversions that split words with empty spans. Block elements start a new line. The hidden XBRL header, scripts and styles are dropped. Section markers come from `h1` to `h6`, from outer ESEF `ix:nonNumeric` text blocks, and from SEC "Item" lines. A marker whose section is under 200 characters is dropped, which removes table of contents entries. A report with no real markers becomes one `document` section. `EXTRACTOR_VERSION` changes whenever the output could change.

**Chunking.** `chunkText` splits each section into windows of about 3,200 characters with 400 characters of overlap, preferring line, then sentence, then word breaks, and never exceeding 4,800 characters. Every chunk satisfies `text.slice(start, end) === chunk.text`, so a hit points to exact source offsets. Tests check this over 40 generated documents.

**Indexing.** `indexDocuments` finds filings with no chunks under the current index version, extracts, chunks, embeds and writes each document in one transaction. The index version is the extractor version, chunker version and embedding model together, so a change writes new rows and never edits old ones. Repeat calls do nothing. `document_chunks` and `embedding_batches` are append-only. Each chunk carries its issuer (`cik:...` or `lei:...`), its availability date and a generated full-text column.

**Embeddings.** `createEmbedder` in `@open-foresight/llm` calls `openai/text-embedding-3-small` through OpenRouter, pinned to the `azure` provider with fallbacks off, ZDR required and data collection denied. Startup fails unless that provider serves the model and is on OpenRouter's ZDR list. OpenAI's own endpoint for this model is not ZDR eligible. Every request, including failures, is recorded in `embedding_batches`, because index time embeddings have no run and cannot go in `llm_calls`. The model costs 0.02 USD per million tokens.

**Search.** `search` and `createRetriever` return only chunks that meet all four rules. The issuer must belong to the security, found through its SEC listing or its GLEIF ISINs. The document must be in the snapshot. It must have been available on or before the as-of date. The index version must match. Full-text and vector rankings are combined by reciprocal rank fusion with k of 60. Full-text search uses the `simple` configuration, so it does not stem and works across languages. Questions become OR queries from letters and digits only, so no input can inject query syntax. With no searchable terms the vector ranking runs alone.

**No vector index.** The schema has no HNSW index, which departs from the spec. Every search is scoped to one security, so Postgres scans that issuer's chunks exactly through the issuer index. That ranking is deterministic. In a test, an approximate index was never used for a per security query, and its use varied with table statistics. Add an HNSW index only if a search across securities is introduced.

**Evidence coverage.** Evidence exists for SEC filers and for the ESEF countries FR, NL, GB, ES, IT, SE and DK. A security with neither has no evidence, and Germany and Switzerland have none.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/retrieval test` for the tests. The performance test builds 10,000 chunks of 1536 dimension clustered vectors across ten issuers, runs 100 searches for one security, and compares the vector ranking for 20 queries with a JavaScript cosine oracle. It excludes embedding latency by using recorded query vectors. To check the live path, run `SEC_USER_AGENT=... OPENROUTER_API_KEY=... TEST_DATABASE_URL=postgres://... bun packages/retrieval/scripts/live.ts sec` from the repository root. It downloads two real Apple 10-K filings, indexes them with real embeddings, and checks a known quote, offsets, and the as-of rules. The `esef` argument runs the same checks on the real ESEF reports in the database. Index and search timings depend on the embedding provider, which is not measured here.

## Designer and KPI framework

The Designer turns a theme brief into a validated KPI framework for a run. It lives in three packages: framework types and validation in `@open-foresight/core`, the versioned prompt in `@open-foresight/prompts`, and the agent in `@open-foresight/agents`.

**Framework shape.** A framework has 2 to 5 sub-themes and 3 to 8 KPIs. A validated KPI is one of three kinds, and each carries exactly the fields its method needs.

- `quant` names a registered quant function and has exactly 4 strictly increasing thresholds. It has no rubric.
- `extract_then_quant` has a complete rubric and exactly 4 thresholds. A model extracts the number and code buckets it with `bucketLevel`, where the level is how many thresholds the value has reached.
- `judgement` has a complete rubric and no thresholds.

A complete rubric has levels 0 to 4 and an unknown rule. Each KPI also has sources, a lookback of 30 to 3650 days, a whole percent weight and a gate flag. Weights sum to exactly 100, which departs from the spec's fractions and matches the gate 1 screen. At most one KPI is a gate. KPIs that use the market factor functions (size, liquidity and momentum) may carry at most 20 percent of the weight together, because they describe a stock and not its exposure to a theme.

**Sources and quant functions.** `sourceCatalog` lists what a KPI may name. `enabledSources({ eodhd })` returns the ones enabled for a run, and `prices` needs the EODHD adapter. `quantCatalog` lists the quant functions. It is the contract for the Analyst ticket, which implements each function.

**Validation.** `validateFramework` returns every violation with a code, a path and a message. This lets one repair request name all of them. Codes cover shape, counts, ids, unknown and unavailable sources, missing quant sources, lookback, weights, the weight total, the market factor cap, gate count, rubrics and thresholds.

**Prompt.** `loadPrompt('designer', 'v1')` reads `packages/prompts/prompts/designer/v1.md`. Its `promptVersion` is the name, the version and 12 characters of the file hash, such as `designer@v1:7ca0679cc9a8`, so an edited prompt always shows. `render` fails on a missing or unused variable. Change a prompt by adding a new version file.

**Agent.** `runDesigner` renders the prompt with only the enabled sources and quant functions, and asks the gateway for strict structured output. The schema limits sources and quant functions to the enabled ones. An invalid draft is repaired once, and the second request lists every error. A run that already has a valid draft returns it without a model call unless `regenerate` is set. Each attempt is saved in the append-only `kpi_framework_drafts` table with the raw model output, the validation errors, the prompt version and the `llm_calls` row of its model call. The Designer does not move the run's status. Freezing a framework as a `kpi_framework_versions` row after PM approval belongs to the brief and approval ticket.

**Known limits.** The framework has no field for the unit of an extracted value. The prompt asks for fractions from 0 to 1 and dollars, and the definition names the number to extract, but code does not check it. The Analyst ticket should add a structured unit with its extraction contract. Quant functions are names until that ticket implements them.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/agents test` for the tests. They include a replay of recorded real completions through the real gateway code and a 100 draft timing check that excludes model latency. To run the real model, run `OPENROUTER_API_KEY=... TEST_DATABASE_URL=postgres://... bun packages/agents/scripts/live.ts --record` from the repository root. It uses the pinned designer model from `config/models.ts`, a Smart Energy brief and a sample universe that does not come from the pilot reference ETF, then prints the draft and its audit row. A run costs roughly 0.1 USD and takes under a minute.

Four real runs with the pinned designer model shaped the rules. The first put 30 percent of the weight on size, liquidity and momentum KPIs, so the prompt and the market factor cap were added. The second bucketed revenue shares in fractions where the first had used percents, so the prompt fixed the unit, and the structured `extraction` field with a unit check replaced that prompt-only rule. Every run returned a valid framework on its first attempt, in 33 to 49 seconds for 0.09 to 0.12 USD, served through Google on the cheapest ZDR provider the gateway pinned at startup. `fixtures/designer-real-completion.json` is the latest recording, made with prompt `designer@v2`.

## Analyst scoring

`scoreKpi` in `@open-foresight/agents` scores one security on one KPI of a framework. `scoreFramework` scores every KPI, a few at a time. The three scoring methods work differently.

- **`quant`.** `computeQuant` in `@open-foresight/data` runs the registered function in code, with no model call. The financial functions read annual US GAAP facts filed on or before the as-of date, and take the numerator and denominator from the same fiscal period. The market functions reuse the universe code. Each result lists its inputs, such as fact ids with accession and source pointer, or the price bars used. A missing value is `unknown` with a note. Financial functions work for US filers only.
- **`extract_then_quant`.** The model returns one number in the KPI's unit, and code sets the level from the thresholds with `bucketLevel`. A value out of range for its unit is rejected, so 26 instead of 0.26 for a fraction cannot reach the thresholds.
- **`judgement`.** The model chooses a level from the rubric.

**Evidence.** Retrieval returns the best passages for the KPI within its lookback window and source kinds, labelled `e1`, `e2` and so on. The model cites those labels, never a stored identifier. With no passage the score is `unknown` and no model is called. The prompts say that silence in the passages is not evidence of absence, so a silent passage gives `unknown` and not level 0.

**Validation.** `validateScore` in `@open-foresight/core` returns every violation. A citation pairs an evidence label with a quote. The label must have been offered. The evidence must belong to an issuer of the security, and must be available on or before the as-of date and inside the lookback window. The quote must be 8 to 300 characters and appear verbatim in the cited passage, ignoring only whitespace, so case and wording matter. A level of 1 to 4 and every extracted value need a citation. A rejected answer is repaired once by listing every error. Each attempt is saved in the append-only `kpi_scores` table with the offered passages, the prompt version, the `llm_calls` row and the validation errors. A score that never validates is saved as `unknown` with its errors. A KPI with a valid score for the run and security is returned without work.

**Confidence.** Code computes it from the result and the model is never asked. It is a v1 heuristic documented on `computeConfidence`. It starts at 0.4 for a level, adds 0.2 each for two citations, two documents and recent evidence, and takes 0.2 off for listed conflicts. A computed quant value gets 1 and an invalid score gets 0. The agreement check with a second sample from the spec is not built.

**Extraction contract.** An `extract_then_quant` KPI now carries `extraction`, a target and a unit of `fraction`, `usd` or `count`. Validation requires it, and checks that fraction thresholds lie between 0 and 1. This replaces the prompt-only unit rule from the Designer ticket, and the Designer prompt is now `designer@v2`.

**Limits.** The Analyst has no tool loop in phase 1. The sample agreement check and a second model sample are not built. Evidence for a text KPI exists only for SEC filers and the ESEF countries.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/agents test` for the tests. They replay the real evidence and model outputs recorded in `fixtures/analyst-real-scores.json` through the real validation and saving code, and time 1,000 recorded scores. To score a real company, run `OPENROUTER_API_KEY=... SEC_USER_AGENT=... EODHD_API_KEY=... TEST_DATABASE_URL=postgres://... bun packages/agents/scripts/analyst-live.ts --record` from the repository root. It runs the Designer, downloads Enphase Energy's two latest 10-K filings, indexes them, scores every KPI, computes every quant function and traces each citation back to its filing. It costs about 0.11 USD and takes a few minutes, mostly in the final citation check.

In that real run all five scores validated on the first attempt, and all five quotes were found verbatim in the stored source. The model answered `unknown` for the revenue share and grid automation KPIs because Enphase does not disclose a smart energy revenue split. The financial quant values for Enphase were R&D at 12.8 percent of revenue, gross margin 46.6 percent, capex 2.8 percent and revenue growth 10.7 percent for fiscal 2025.

## Brief and KPI approval

`apps/api` is a Hono API and `apps/web` is a Vite and React app. Together they cover the brief form and the gate 1 approval screen. Run the API with `DATABASE_URL=... APPROVAL_TOKEN=... bun apps/api/src/server.ts` and the worker with `DATABASE_URL=... OPENROUTER_API_KEY=... bun apps/worker/src/main.ts`, after `bun run build` has built the web app. The API only queues work. Nothing advances without the worker. The API listens on `127.0.0.1` only and serves the built web app from `apps/web/dist`. `APPROVAL_TOKEN` must be at least 16 characters. For development, run `bun run --cwd apps/web dev`, which proxies `/api` to the API on port 8787.

**Identity.** There is no sign-in page, as decided in the plan. Every change needs the approver token in the `x-approval-token` header and an analyst name in `x-analyst`. The web app has both fields in its header and keeps them in the browser's local storage. The analyst name is recorded as `created_by` on the run and as `user_id` on the decision. The token proves the request came from someone with local access. It does not identify a person.

**Brief.** `validateBrief` in `@open-foresight/core` checks the brief on the server and in the browser. The brief needs at least 20 words. The as-of date may be today or earlier. The weight cap times the basket size must reach 100 percent. Lists are trimmed and deduplicated. An invalid brief returns 422 with a field, a code and a message for each problem and creates no run.

**Run flow.** `POST /api/runs` creates a run in `draft` and queues it. The worker takes it through `universe_built` and `designing` to `awaiting_kpi_approval`. A queue that is down does not fail the request, because the worker finds runs that need work. See Packaging and orchestration below.

**Approval.** The gate 1 screen shows the drafted framework with an editable weight and gate flag for each KPI, a running weight total, and an editor for the selected KPI with its definition, rubric, extraction, thresholds, sources and lookback. A list of problems comes from the same `validateFramework` the server uses, through `frameworkToDraft`. "Approve and score" stays disabled until the framework is valid. `POST /api/runs/:id/approve` validates again on the server and returns 422 with every problem if the edited framework is invalid. A valid framework is frozen in `kpi_framework_versions` with the approver, an `edited` flag, the draft it came from and the exclusions. The decision, the version and the status change are written in one transaction through the `prepare` step of `approveGate`, so a rejected approval leaves nothing behind. The decision's target is the version id, and the run points at the version. A second approval returns 409. Versions and drafts are append-only.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd apps/api test` for the API tests. They run in process against Postgres and include a timing check of 100 submissions and 100 approvals that excludes browser startup. To check the whole thing in a real browser, start the API, then run `APPROVAL_TOKEN=... DB_NAME=... bun apps/web/scripts/browser-live.ts`. It drives Chromium through the invalid paths and the full flow with the real Designer, then checks the version, decision and status history directly in Postgres. It saves screenshots to `docs/screenshots`. Install the browser once with `bunx playwright install chromium` from `apps/web`.

**Design.** The layout follows the product mockups: one card per screen, hairline dividers, small muted labels, tinted status pills, and KPI cards with the weight on the right. The palette follows Axyon Foresight: a deep blue accent scale (`#3464a5` for actions, `#4a8feb` for fills), near black ink and warm neutrals, with small radii. The tokens are at the top of `apps/web/src/styles.css`, and a dark scheme follows the system setting. The text uses the system font stack, because Axyon's Denim typeface is proprietary. "Save draft" saves the form in the browser's local storage. The basket and review screen is built in a later ticket and can reuse the same tokens, pills and cards.

## Packaging and orchestration

`apps/worker` runs the stages on pg-boss. pg-boss keeps its queue in the same Postgres, in its own `pgboss` schema, and creates it on start. It needs Node 22.12 or newer. Bun runs the worker. Each run has at most one queued or active job, because the queue uses the `exclusive` policy. A job drives the run to its next gate or its end, then stops. The API queues a job when a run is created and when gate 1 is approved. Every 30 seconds the worker also queues every run that is mid-pipeline, so a lost job does not strand a run.

| Status | Work, with no external calls except the model | Next |
| --- | --- | --- |
| `draft` | Take a snapshot. Screen every listing that has prices in the store against the brief's regions, size, liquidity and named tickers. Save each decision in `run_universe`. | `universe_built` |
| `universe_built` | Nothing. | `designing` |
| `designing` | Draft the KPI framework. A run that has a valid draft reuses it. | `awaiting_kpi_approval` |
| `awaiting_kpi_approval` | Wait for a person. Only the approval in the API moves the run, and the database rejects any other change. | `prescreening` |
| `prescreening` | Resolve each name's issuers and record its evidence coverage as `sec`, `esef` or `none`. Names with no security are dropped with a reason. No model calls. | `analysing` |
| `analysing` | Score every KPI for every name. Saved scores are reused, so a retry only does what is left. | `packaging` |
| `packaging` | `packageBasket` turns the scores into a basket, written with its members in one transaction. | `done` |

A transient error retries the job up to three times, with a delay. After the last retry, or at once for an error a retry cannot fix, the run moves to `failed` with the reason in `settings.failure`. A job whose worker died is returned to the queue after about 30 seconds without a heartbeat. In the live check it resumed 80 seconds after the kill, and finished without repeating any saved model call.

`packageBasket` in `@open-foresight/core` is a pure function. A name must pass the gate KPI, meaning a known level above 0. An unknown gate KPI fails the gate. Ranking is by theme score, then confidence, then liquidity, then symbol, so input order never matters. The top N are weighted equally, by score, or by score times the square root of market cap. A per-name cap redistributes the excess until nobody is over it. If fewer names qualify than the cap needs to reach 100 percent, the cap is raised to 100 over the name count and the basket records the change. A `strict` run counts an unknown KPI as level 0. A `broad` run drops it and renormalises the other weights. It caps the score at 0.8 when more than half the weight is unknown. Each member stores its KPI contributions, and the contributions plus the cap adjustment add up to its score. `baskets` and `basket_members` are append-only and always `provisional`, because phase 1 has no Reviewer or final approval. The sector and region caps, the days-to-trade figure and the factor tilt are not built.

The universe is every listing with prices in the local store, because agents never fetch. `apps/worker/scripts/seed-pilot.ts` fills a store with real data for the 50 names in `packages/data/fixtures/eodhd/universe-50.json`: ECB FX, EODHD prices and symbol lists, OpenFIGI, Yahoo market caps, SEC 10-K filings, ESEF reports and real embeddings. It needs `EODHD_API_KEY`, `SEC_USER_AGENT` and `OPENROUTER_API_KEY`. The ESEF source rate limits, so it fetches a few ISINs at a time and waits. Its last real run took about 21 minutes and cost 0.16 USD in embeddings.

**Evidence guards and optional Jev checks.** A level 3 or 4 judgement score whose cited quotes name nothing from the KPI definition is lowered to level 2, and a lenient name with less than 40 percent of its KPI weight known is not ranked. Both are code, are always on, and keep the original level in the audit row. Two Jev checks are off unless the worker starts with the variable. `JEV_SPAN_CHECK=1` reads each cited span back from the store and asks Jev whether it supports a level 3 or 4, stepping the level down when it does not. `JEV_EXPOSURE_CHECK=1` asks Jev whether a name's business passages place it in the theme, and settles a judgement gate KPI at level 0 on a confident `none`. Each Jev check can only lower or settle a score, and a failed call leaves the Analyst's score as it is. `scripts/replay-guards.ts`, `scripts/jev-span-check.ts` and `scripts/jev-exposure-check.ts` try each on a finished run without writing scores.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd apps/worker test` for the worker tests. Each test file creates and drops its own migrated database, so the URL only needs to name a server where the user can create databases. The tests cover the stages, gate enforcement, repeat jobs, a model outage and resume, a Designer failure, and the real pg-boss queue. The performance test replays `fixtures/pilot-50-scores.json`, the real scores of the live run, as 3,000 securities. Record a new one with `scripts/record-pilot-scores.ts`. To check the whole thing in a real browser, start the API and the worker against a seeded store, then run `APPROVAL_TOKEN=... DB_NAME=... bun apps/web/scripts/browser-live-run.ts`. It submits a brief, approves gate 1 in the UI, waits for the basket, and checks the funnel, weights, contributions and audit trail in Postgres.
