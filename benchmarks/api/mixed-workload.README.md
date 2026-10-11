# Mixed board hydration workload

This opt-in benchmark measures the compact board-open projection under concurrent reads, writes
and cross-process realtime. It creates its own fixture and never accepts a remote target URL.

Run from the repository root with development Postgres (`kanera-postgres`, port 5433) available:

```bash
MIXED_OUTPUT=/tmp/kanera-mixed-run node benchmarks/api/mixed-workload.mjs
node benchmarks/api/mixed-workload-summary.mjs /tmp/kanera-mixed-run
```

To distinguish capacity gains from latency at the same offered load, run a separate paced comparison:

```bash
MIXED_BOARD_RPS=20 MIXED_OUTPUT=/tmp/kanera-mixed-paced node benchmarks/api/mixed-workload.mjs
node benchmarks/api/mixed-workload-summary.mjs /tmp/kanera-mixed-paced
```

Paced readers stagger their starts across the requested rate, retaining the same maximum reader
concurrency. Results include expected/actual starts, scheduling lag and latency from the intended
start time as well as HTTP latency. Check those counts before claiming matched traffic. A capped
run whose starts fall behind does not establish latency at the requested offered rate.

Requirements: Linux with cgroup v2, Docker host networking, repository dependencies, and locally
available `nginx:1.30.4-alpine` and `valkey/valkey:9.1.2-alpine` images. The runner does not pull
images or add dependencies. Do not run alongside another performance benchmark or compiler.
Use a fresh output directory each time. A short functional smoke run is:

```bash
MIXED_ROUNDS=1 MIXED_DURATION_MS=2000 MIXED_READERS=2 MIXED_OBSERVERS=2 \
  MIXED_OUTPUT=/tmp/kanera-mixed-smoke node benchmarks/api/mixed-workload.mjs
```

## Isolation and topology

The runner creates `kanera_mixed_<pid>` in the local Postgres container and seeds 3,000 primary-board
cards, six workspaces and 40 members. It uses PostgreSQL `work_mem=16MB`, production Node mode and
self-hosted product mode. It starts a dedicated Valkey container because Redis pub/sub channels
are shared across numbered databases: selecting a different database is insufficient to isolate
realtime from the development stack. SMTP and analytics are disabled.

Two app API processes (pool 10 each), a public API (pool 5) and a worker (pool 5) run from temporary
source copies. Both variants have total pool capacity 30. An isolated nginx container uses the
actual web nginx configuration with only local ports/upstreams changed and a single worker.
API JSON is gzip-compressed at the configured level 5; Socket.IO uses WebSocket without deflate.

Ports must be free: API 3100/3101, public API 3120, worker 3121, nginx 3180, measurement controls
3196–3199, and private Valkey 56389. All listen on loopback. Database contents, containers, source
copies and temporary credentials are removed on normal completion or handled failure. A hard kill
may require cleanup of the run-specific resources recorded in `environment.json`.

## Workload and correctness

Defaults are three alternating runs each of `p1` (JSON ID arrays, full custom-field objects and
unused cover columns) and `baseline` (current product projection). Each run warms both API replicas
and then generates:

- 25 concurrent, closed-loop complete-board readers through nginx.
- One app title writer, one public API title writer and one public watch/unwatch writer, each at
  a target of one operation per second. Each lane has at most one operation in flight and waits
  for every observer to receive its correlated event before starting the next mutation. Start lag
  and achieved counts are reported, so delivery congestion is not silently discarded.
- Card-detail reads at a target of two per second and app health probes at one per second.
- Eight authenticated WebSocket observers joined to the board, receiving both app/public title
  updates and worker-dispatched, user-scoped watch changes.

Public writes use a real personal API key minted through the app API. The harness verifies each
expected payload and records request-to-delivery latency for every observer. HTTP response latency
is reported separately from the mutation cycle, which also includes the all-observer wait.
Missing delivery, a disconnect, a non-2xx response, bad payload, or persisted-state mismatch fails
the run. It also checks that both durable realtime outboxes have drained.

Every covered card has its own private media reference. Before timing, all 1,500 selected thumbnail
URLs are checked for the expected tenant/path, valid expiry and exact HMAC signature. Signing is
included in every board read. The benchmark does not download image bytes or measure object storage.
Gzip is asserted on every board response; wire bytes are measured before decompression. Initial and
final board snapshots must contain all 3,000 cards and the final persisted edited titles.

Control variables: `MIXED_ROUNDS` (default 3), `MIXED_DURATION_MS` (20000), `MIXED_READERS` (25),
`MIXED_OBSERVERS` (8), `MIXED_BOARD_RPS` (0 for uncapped), `MIXED_VARIANTS` (`p1,baseline`) and `MIXED_OUTPUT`. Variants restore only the
query projection; current access predicates, bindings and application logic remain in place. Titles
and watch state reset between runs; activity/outbox history remains, and alternating order helps
expose order effects. Each sample records actual elapsed time including requests draining after
the scheduled deadline. Never compare a two-reader smoke run against a 25-reader measured run.

## Metrics and limits

The generator runs in a separate Node process and consumes timed board bodies without parsing
JSON. Each app replica, the public API and worker report CPU, event-loop utilization/delay and RSS.
Nginx and Valkey report cgroup CPU deltas; these bracket reset/snapshot calls and include small
measurement overhead. PostgreSQL CPU is not attributed. Summary CPU per board read amortizes all
mixed operations over board reads; it is not an isolated board cost. ELU at saturation can remain
near 100% while useful throughput improves.

Raw round files retain counts, latency distributions, scheduler lag, delivery counts, wire bytes,
process measurements and client CPU. Summary percentiles are medians of per-run percentiles, not
pooled percentiles. Service logs, nginx configuration, image IDs, source patch and harness snapshots
are saved beside them. This models a local HTTP/1.1 deployment: it does not establish production
capacity, WAN/TLS/HTTP2 behavior, hosted billing performance, browser rendering or notification-email
throughput. Real browser and webhook behavior is covered separately by `pnpm test:e2e --
board.spec.ts reconnect.spec.ts shared-fields.spec.ts guest-access.spec.ts live-card-edits.spec.ts
public-api.spec.ts`.
