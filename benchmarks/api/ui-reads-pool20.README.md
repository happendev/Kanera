# Parallel UI reads: pool-size follow-up

Implementation follow-up: [smaller parallel query groups](ui-reads-staged.README.md) reduce the
contention measured here; that report compares the wide parallel code with the staged version.

The 20-connection cap held, but parallelizing reads increased the query queue and shifted latency
between endpoints. Aggregate p95 improved at every tested concurrency; throughput was essentially
flat or slightly lower under concurrent load, and workspace detail, notifications, members and
catalog became slower. These measurements do not support an unconditional claim that all UI
requests become faster when the server is busy.

## Results

Values are medians of six batch measurements, in milliseconds unless stated otherwise. Each batch
runs for five seconds, then drains outstanding requests; throughput includes that drain time.
Before/after batch order alternates AB/BA. These are descriptive results, not confidence intervals.

| Concurrent requests | p50 before → after | p95 before → after | p99 before → after | Successful requests/s before → after | Throughput change | Faster p95 rounds |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 9.16 → 7.63 | 14.53 → 12.04 | 16.60 → 13.36 | 110.91 → 135.70 | +22.3% | 6/6 |
| 10 | 28.94 → 29.49 | 52.33 → 48.15 | 66.21 → 62.85 | 327.23 → 326.51 | -0.2% | 4/6 |
| 20 | 60.99 → 64.68 | 107.17 → 94.75 | 147.82 → 122.82 | 310.82 → 297.25 | -4.4% | 4/6 |
| 50 | 100.05 → 109.07 | 182.74 → 144.60 | 212.34 → 154.82 | 459.96 → 451.58 | -1.8% | 6/6 |
| 100 | 198.01 → 206.93 | 364.19 → 280.96 | 413.38 → 308.00 | 470.03 → 467.69 | -0.5% | 6/6 |

All **98,859 measured requests succeeded**, with no network, HTTP, pool-acquisition or statement
timeout errors observed in the accepted runs. All metrics scrapes succeeded. The highest observed
HTTP duration across both versions was 567.17 ms. Complete JSON responses matched for all 21
account/endpoint combinations before each run.

## Pool pressure

Pool state was sampled through the existing authenticated `/metrics` endpoint approximately every
100 ms while each batch ran. Mean waiting values below are medians of the six batch means; peaks
are maxima across all observed samples. These are queued queries, not users, and sampling can miss
brief peaks. Both versions reached, but never exceeded, 20 sampled connections.

| Concurrent requests | Mean queued queries before → after | Peak queued queries before → after |
|---:|---:|---:|
| 1 | 0.00 → 0.00 | 0 → 0 |
| 10 | 0.00 → 0.73 | 2 → 15 |
| 20 | 2.77 → 14.50 | 16 → 27 |
| 50 | 41.26 → 80.67 | 55 → 118 |
| 100 | 108.48 → 189.86 | 168 → 254 |

At 100 concurrent requests, mean queue depth grew about 75%, from 108.48 to 189.86. The updated
API peaked at 254 queued queries while retaining the 20-connection cap. The pool bounds active
connections; it does not bound the number of queries awaiting a connection. The configured
connection-acquisition timeout remained five seconds.

## Endpoint trade-offs

Aggregate p95 hides regressions on less expensive endpoints. Under mixed traffic, one request’s
parallel queries compete with other requests for the same pool. At 100 concurrent requests:
workspace detail p95 increased 33.6%, notifications 23.9%, catalog 17.6%, and members 14.8%.
The sidebar improved 43.6%. This is consistent with increased query competition; this experiment
does not isolate which individual concurrency change causes each regression.

| Endpoint | p95 at 20 requests before → after | p95 at 100 requests before → after |
|---|---:|---:|
| home-boards | 139.53 → 84.51 | 419.90 → 236.80 |
| portfolio | 105.86 → 85.70 | 267.37 → 237.53 |
| workspace-members | 56.16 → 61.45 | 142.04 → 163.00 |
| notifications | 89.54 → 97.44 | 197.21 → 244.40 |
| search | 91.61 → 87.66 | 259.55 → 235.21 |
| work-catalog | 96.68 → 103.00 | 259.66 → 305.41 |
| workspace-detail | 80.72 → 102.51 | 228.49 → 305.23 |

Keep the configured pool size while evaluating narrower parallel groups or selectively restoring
sequential reads in the largest groups. Re-run this mixed workload after such changes. Increasing
pool size alone is not justified by these results: it would increase database pressure and the
combined connection budget across API replicas, public/admin APIs and workers. No application
code or pool settings were changed by this follow-up.

## Method and limits

- Two temporary, non-watching API processes on local ports 3100/3101; only one variant received
  benchmark traffic at a time. Both used `PG_POOL_MAX=20`, `PG_CONNECTION_TIMEOUT_MS=5000`,
  metrics enabled, development mode and the same local PostgreSQL/Valkey instances. Existing dev
  services remained running. Both temporary APIs were stopped after the test.
- Restored the original saved API source archive and applied only the six API files from the saved
  concurrency patch to the second copy. This excludes subsequent application-code changes and
  the frontend HTTP scheduling change. Both use the same current shared package and dependencies.
  Source archive/patch SHA-256 hashes and the dependency checkout revision are saved in
  `results/ui-reads/pool20-environment.json`.
- Equal weighting across seven endpoints and three seeded accounts: organisation owner Amelia,
  workspace admin Priya and member Ben, using the Development Team workspace. These are
  21 account/endpoint combinations, not 100 distinct users. Requests read application data;
  authentication creates local login sessions.
- Closed-loop load: each worker starts its next request when the previous one finishes. There is
  no think time. Tested concurrency is the number of in-flight HTTP requests, not logged-in users.
  This does not establish capacity under a fixed arrival rate or an unbounded burst.
- Six five-second measured batches per variant/level, with two-second warmups for each variant
  at each level. Full HTTP response bodies are included in latency. Metrics use a separate request
  and their overhead is present equally on both variants.
- Fixture: 19 users, 9 workspaces, 23 boards, 238 cards and 258 notifications. Local PostgreSQL
  reported `max_connections=100`; this is not a claim about production configuration.
- Ryzen 7 7840HS, 16 logical CPUs, Node 24.18.0. Other development and browser workloads were
  active. Throughput varies across levels and rounds; small differences should not be treated as
  precise production predictions. This is a small, warm local fixture, not a large-database or
  long-duration soak test. Writes, worker load, multi-replica saturation, hosted billing and
  network latency were not added as benchmark workloads.
- The first attempt at concurrency 100 reached the default five-minute JWT expiry during round 4
  and returned `401 token_expired`. The entire 100-request level was excluded and repeated,
  rather than treating fast authentication failures as successful reads. The final harness renews
  credentials outside timing between load levels, saves errors, exits nonzero on failures, and
  suppresses improvement percentages for batches containing failures. Original failed samples
  remain in `pool20-mixed-initial.json`; accepted samples come from its levels 1/10/20/50 and
  all six rounds in `pool20-mixed-c100-retry.json`.

## Reproduce

The archived source and raw results are ignored local artifacts. Restore the baseline as described
in [the original report](ui-reads.README.md#reproduce), using new directories
`/tmp/kanera-pool20-before` and `/tmp/kanera-pool20-after`. Extract the same baseline archive into
both; apply `results/ui-reads/pool20-api.patch` to the after directory with `patch -p3`.
Both directories need a `node_modules` symlink to `apps/api/node_modules`. From the repo root,
start each API in a separate terminal:

```bash
API_PORT=3100 UPLOADS_DIR=/tmp/kanera-pool20-before/uploads \
  AUTH_RATE_LIMIT_ENABLED=false PG_POOL_MAX=20 PG_CONNECTION_TIMEOUT_MS=5000 \
  METRICS_ENABLED=true METRICS_TOKEN=local-pool-benchmark-only \
  pnpm with:local-env pnpm --filter @kanera/api exec tsx /tmp/kanera-pool20-before/src/index.ts

API_PORT=3101 UPLOADS_DIR=/tmp/kanera-pool20-after/uploads \
  AUTH_RATE_LIMIT_ENABLED=false PG_POOL_MAX=20 PG_CONNECTION_TIMEOUT_MS=5000 \
  METRICS_ENABLED=true METRICS_TOKEN=local-pool-benchmark-only \
  pnpm with:local-env pnpm --filter @kanera/api exec tsx /tmp/kanera-pool20-after/src/index.ts
```

Then run:

```bash
PERF_METRICS_TOKEN=local-pool-benchmark-only \
  node benchmarks/api/ui-reads-load.mjs
node benchmarks/api/ui-reads-load-summary.mjs \
  benchmarks/api/results/ui-reads/pool20-mixed.json
```

Use `PERF_LEVELS=100` to repeat a single level; `PERF_ROUNDS`, `PERF_DURATION_MS`,
`PERF_EMAILS`, `PERF_PASSWORD`, `PERF_API_URL`, `PERF_COMPARE_URL` and `PERF_OUTPUT` are
configurable. The harness refuses remote hosts. Use a fresh output path to retain earlier results.
Stop the two temporary APIs when finished.

## Artifacts and checks

- [Accepted raw samples](results/ui-reads/pool20-mixed.json)
- [Summary](results/ui-reads/pool20-mixed-summary.json)
- [Environment and source provenance](results/ui-reads/pool20-environment.json)
- [Repeated 100-request level](results/ui-reads/pool20-mixed-c100-retry.json)
- Verification: 21 response-parity comparisons per invocation, successful smoke run, and the
  98,859 accepted measured requests above. Benchmark scripts passed explicit ESLint and Node
  syntax checks. `pnpm lint` passed with zero errors and 37 existing web warnings; its output is
  recorded in `results/ui-reads/pool20-lint.log`. The summary also rejected the actual expired-token
  batches as invalid comparisons.
- No application, shared-contract, UI or realtime code was changed in this follow-up; application
  integration/E2E suites were not repeated. The original implementation’s test results remain in
  [the original report](ui-reads.README.md#verification).
