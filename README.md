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
