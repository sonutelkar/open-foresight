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
