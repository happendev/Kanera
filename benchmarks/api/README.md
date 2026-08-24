# API load test

An opt-in concurrent load test for the read paths that dominate server cost. It does not run in CI,
does not modify application code, and every scenario is a read — nothing is written.

The web benchmark in `../web` drives one browser doing one thing at a time, so it cannot see the
costs that only appear under connection pressure: Postgres pool contention (`PG_POOL_MAX` defaults to
10), fire-and-forget background work competing with foreground requests, and per-request query
fan-out. Backend performance changes need a concurrent client to be measurable at all.

## Fixture

Uses the same fixture as the web benchmark:

```bash
pnpm perf:web:seed
```

For load testing, widen it — `loadAccessibleBoards` fan-out and multi-page work cursors are only
interesting with several workspaces and a real membership:

```bash
PERF_CARD_COUNT=3000 PERF_WORKSPACE_COUNT=6 PERF_MEMBER_COUNT=40 pnpm perf:web:seed
```

The defaults (1,000 cards, 40 boards, 4 workspaces, 20 members) reproduce the historical card and
board counts exactly, so previously captured `../web/results` runs stay comparable.

## Run

Start the local database and the development stack, then:

```bash
pnpm perf:api
```

Useful options:

```bash
PERF_LABEL=before pnpm perf:api
PERF_CONNECTIONS=25 PERF_DURATION_MS=20000 pnpm perf:api
PERF_SCENARIOS=board-open,card-detail pnpm perf:api
PERF_API_URL=http://localhost:3000 pnpm perf:api
PERF_OUTPUT=/tmp/kanera-api-before.json pnpm perf:api
```

The harness refuses non-local base URLs unless `PERF_ALLOW_REMOTE=1` is set.

Every run writes its complete JSON result to `benchmarks/api/results/<timestamp>-<label>.json`,
prints a table, and emits one machine-readable `KANERA_API_PERF_RESULT=...` line. It exits non-zero
if any scenario saw a non-2xx or network error, so a broken stack cannot be mistaken for a fast one.

## Scenarios

| Scenario | Request | Why |
|---|---|---|
| `board-open` | `POST /boards/:id/open` | the hottest interactive read: nine parallel queries plus per-card payload compaction |
| `work-cards-query` | `POST /work/cards/query` (`my`) | `loadAccessibleBoards` fan-out then the keyset card query |
| `work-cards-query-team` | `POST /work/cards/query` (`team`) | widest accessible-board scope, so the fan-out worst case |
| `card-detail` | `GET /cards/:id/detail` | where the internal-link repair and link joins run |
| `work-catalog` | `GET /work/catalog` | cross-workspace catalog breadth |

## Reading the results alongside Postgres

Concurrency shifts cost into the database, so pair each run with the statement view:

```bash
docker exec -i kanera-postgres psql -U kanera -d kanera -c "select calls, round(total_exec_time) total_ms, round(mean_exec_time, 2) mean_ms, rows, left(query, 120) from pg_stat_statements order by total_exec_time desc limit 20;"
```

Reset between runs with `select pg_stat_statements_reset();`. This requires
`shared_preload_libraries=pg_stat_statements`, which `docker-compose.dev.yml` now sets; on a cluster
created before that change, run `pnpm dev:db:reset` or `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`
once by hand.

Compare runs on the same machine, commit, and dev-stack state. Absolute development-build numbers
matter less than the before/after delta.
