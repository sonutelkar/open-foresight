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

`@open-foresight/data` provides `createSecSecurityProvider`. Supply a Drizzle database and an SEC user agent with contact details, then call `sync()`. It fetches the SEC ticker and exchange list and OpenFIGI mappings. The provider stores SEC listings separately from FIGI candidates, creates stable security IDs for unambiguous matches, and leaves conflicting issuer or FIGI mappings unresolved. The sync report counts prior links that were changed to unresolved in `reclassified`. The provider collects and validates responses before writing and commits each sync in one transaction. Concurrent writers acquire the same PostgreSQL advisory transaction lock. It respects OpenFIGI batch limits and retries rate limits. An OpenFIGI API key is optional.

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

ADV is the mean of close times volume over the last `advWindow` bars that have a volume, at least `minAdvBars` of them. Market cap is shares outstanding times the last close. Shares come from the SEC `EntityCommonStockSharesOutstanding` fact filed most recently on or before the as-of date, so only listings with a `cik` that SEC facts cover can have a market cap. Every other listing is excluded as `market_cap_unavailable`. The EODHD fundamentals endpoint returns 403 on the EOD plan, so European, UK and Swiss names stay excluded until a shares source is added. Thresholds are in USD. Build `fxToUsd` for the rules with `fxToUsdAsOf` from the ECB rates below. A currency with no recent rate gets `fx_unavailable`. London quotes are in pence and are scaled by 0.01.

`packages/data/fixtures/eodhd/eod-bars.json` holds real EODHD responses for 50 symbols, recorded by `scripts/record-eodhd-fixtures.ts`. In `universe-50.json`, the shares and CIKs are constructed. FX comes from the recorded ECB file. Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/data test` against a disposable migrated database. Turbo does not pass the variable through, so `bun run test` skips the database tests. The test serves the recorded responses from a loopback server, ingests them twice, and prints the include or exclude decision and reasons for all 50 names. The perf test filters 3,000 generated securities with 30 bars each through the full Postgres path. Three warm runs took about 0.2 seconds each against a 10 second ceiling, and trunk has no equivalent operation. Universe membership is returned, not stored. Storing it with a run belongs to the orchestration ticket.

## FX rates

`createEcbFxProvider` in `@open-foresight/data` ingests ECB euro reference rates into `fx_rates`. It is free and needs no key. Call `sync({ currencies, from, to })` with codes such as `USD`, `GBP`, `CHF`, `DKK`, `SEK` and `NOK`. Rates are units of currency per euro. The ECB publishes on business days only. Each rate is stored as a version, so a revised rate adds a row and never overwrites the original.

`fxToUsdAsOf({ db, snapshotId, asOf, currencies })` returns USD per unit of each currency. It takes the latest rate on or before `asOf` that the snapshot saw, and ignores rates older than `maxStaleDays` (default 5). A weekend date uses Friday's rate. It returns nothing when the USD rate is missing. Pass the result as `fxToUsd` in the universe rules.

Run `TEST_DATABASE_URL=postgres://... bun run --cwd packages/data test` for the fixture tests. The fixture `fixtures/ecb/exr-2024-11.csv` is a real ECB response. To check the live service, run `TEST_DATABASE_URL=postgres://... bun packages/data/scripts/ecb-live.ts` from the repository root. It loads the last 14 days twice and prints the conversion. The second load inserts nothing.
