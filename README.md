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
