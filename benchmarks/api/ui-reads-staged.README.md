# UI reads with smaller parallel query groups

The API now stages the largest read groups while retaining smaller independent query pairs.
The PostgreSQL pool setting is unchanged. This comparison uses the immediately preceding wide
parallel implementation as **before**, and the staged implementation as **after**; it is not a
comparison with the original sequential code in the earlier reports.

## Implementation

- Sidebar: organisation and guest directory loaders run in stages; directory and due-item work
  still overlap, with invitations afterwards. Board-access resolution finishes before the timezone
  lookup, which is skipped when no accessible boards exist.
- Workspace detail: the seven top-level branches become groups of three, followed by the
  automation allowance lookup. Child-row loaders keep their existing internal dependencies.
- Global Work catalog: five initial queries become a group of three and a pair; field-option and
  membership enrichment remain a pair.
- Portfolio: four aggregate/activity projections become two pairs.
- Search scope: board-grant resolution completes before the workspace-membership pair.
- SQL predicates, access rules, result shapes and ordering are preserved. No global scheduler,
  new dependency, environment variable or pool-size change was introduced. Other existing
  parallel groups, including member rosters and notification reads, remain in place.

## Results

All **125,712 measured requests succeeded**; there were no request or metrics-scrape failures.
Values below are medians of six alternating AB/BA batch measurements. Latency is milliseconds;
queue depth is the median of the batch means of sampled waiting queries.

| Concurrent requests | p50 before → after | p95 before → after | p99 before → after | Successful requests/s before → after | Mean queued queries before → after |
|---:|---:|---:|---:|---:|---:|
| 1 | 7.43 → 8.23 | 11.79 → 12.11 | 13.37 → 13.33 | 138.18 → 129.42 | 0.00 → 0.00 |
| 10 | 21.03 → 20.47 | 28.40 → 27.26 | 32.60 → 31.18 | 481.31 → 503.63 | 0.59 → 0.02 |
| 20 | 42.42 → 41.05 | 52.95 → 50.09 | 59.96 → 56.41 | 478.62 → 505.28 | 15.90 → 7.28 |
| 50 | 102.66 → 104.62 | 133.10 → 128.90 | 147.21 → 141.66 | 478.95 → 494.61 | 82.54 → 59.78 |
| 100 | 204.18 → 206.35 | 274.52 → 260.25 | 290.99 → 271.49 | 473.98 → 496.44 | 194.62 → 149.76 |

At 100 concurrent requests, mean queue depth fell **23.1%**, throughput increased **4.7%**, and
overall p95 fell **5.2%**. Sampled connections stayed at or below **20** in both variants. Peak
observed queue depth at this level fell from 242 to 189 queries. This reduces contention; it does
not eliminate queues or establish an overload guarantee.

## Per-endpoint trade-off at 100 concurrent requests

| Endpoint | p95 before | p95 after | Change in latency |
|---|---:|---:|---:|
| home-boards | 222.13 | 267.69 | +20.5% |
| portfolio | 226.77 | 221.99 | -2.1% |
| workspace-members | 151.26 | 114.85 | -24.1% |
| notifications | 229.24 | 173.27 | -24.4% |
| search | 220.43 | 217.79 | -1.2% |
| work-catalog | 289.10 | 265.26 | -8.2% |
| workspace-detail | 288.07 | 264.48 | -8.2% |

Six of the seven endpoints improved p95 under this load, especially members and notifications
(about 24%). The sidebar became **20.5% slower** at p95 (222.13 → 267.69 ms): it yields more
of the shared pool to competing requests. Overall median latency at 100 requests was nearly
flat (204.18 → 206.35 ms). At concurrency one, overall median latency increased by **0.80 ms**
(7.43 → 8.23 ms), with p95 increasing 0.31 ms. These are deliberate trade-offs, not a claim that
every request is faster.

An exploratory version serialized all sidebar directory work before due items. Its pilot reduced
queueing but penalized sidebar latency too heavily. The final version retains overlap between
directory and due-item work; only `staged-final.json` contributes to the tables above.
`staged-pilot.json` is retained for diagnosis and does not represent the final implementation.

## Method and limits

- Same mixed harness as the [pool-size benchmark](ui-reads-pool20.README.md): seven endpoints,
  equal weighting across owner Amelia, workspace-admin Priya and member Ben; 21 combinations.
- Six five-second batches per variant at concurrency 1/10/20/50/100, two-second warmups, alternating
  before/after order. Only one variant is loaded at a time; outstanding requests drain before the
  next batch. HTTP timings include full response bodies. Credentials renew outside measured batches.
- The harness compares complete JSON responses before timing. A separate comparison of eight
  endpoints across owner, workspace admin, member and guest matched all **32 responses**, including
  expected denials. This protects against treating missing data or fast errors as improvements.
- Two non-watching API processes on local ports 3100/3101, both with `PG_POOL_MAX=20`,
  `PG_CONNECTION_TIMEOUT_MS=5000`, development mode and authenticated metrics enabled.
  Both temporary APIs were stopped after verification.
- Pool state sampled approximately every 100 ms, so brief peaks may be missed. Latency statistics
  and queue means are medians of batches, not pooled distributions or confidence intervals.
- Fixture snapshot: 19 users, 9 workspaces, 23 boards, 238 cards, 330 notifications. These counts
  matched a second snapshot after timing. Local PostgreSQL `max_connections` was 100. No reset or
  artificial latency was applied. Login creates sessions; measured endpoints read application data.
- Node 24.18.0, Ryzen 7 7840HS, 16 logical CPUs, shared development machine. Test suites ran after
  timing. This small warm fixture and closed-loop workload do not establish production capacity:
  in-flight requests are not logged-in users, and writes, hosted billing load, many replicas, large
  datasets and fixed arrival-rate overload were not simulated. Small differences may reflect noise.

## Reproduce

The ignored artifact `results/ui-reads/staged-before-api-src.tar.gz` contains the exact baseline
API source and package manifest. Restore it into a new temporary directory and symlink its
`node_modules` to this repository’s `apps/api/node_modules`. Start it on port 3100 using the same
local environment and flags as the [pool-size report](ui-reads-pool20.README.md#reproduce), replacing
its source path with `/tmp/kanera-staged-before/src/index.ts`. Start the current staged source
`apps/api/src/index.ts` on port 3101 with identical flags. To restore the exact staged source later,
apply `results/ui-reads/staged-implementation.patch` with `patch -p3` to a second baseline copy.
Source checksums, checkout revision, environment and fixture counts are saved in
`results/ui-reads/staged-environment.json`.

```bash
PERF_METRICS_TOKEN=local-pool-benchmark-only \
  PERF_OUTPUT=benchmarks/api/results/ui-reads/staged-final.json \
  node benchmarks/api/ui-reads-load.mjs
node benchmarks/api/ui-reads-load-summary.mjs \
  benchmarks/api/results/ui-reads/staged-final.json
```

Stop temporary APIs after benchmarking. Raw samples and source snapshots are ignored local
artifacts and are required to reproduce this exact baseline.

## Verification and artifacts

- `pnpm lint`: passed, zero errors and 37 existing web warnings.
- API type-check: `pnpm --filter @kanera/api exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm test:api:integration -- apps/api/src/modules/work/routes.itest.ts apps/api/src/modules/workspaces/routes.itest.ts apps/api/src/modules/search/routes.itest.ts`: 40 tests passed across three files; details in `results/ui-reads/staged-integration.log`.
- `pnpm test:e2e -- guest-access board-overview angular-settings-races`: all 8 tests passed,
  including guest revocation, portfolio counts, settings edits, and desktop/phone screenshots.
  [Traces, screenshots and logs](../../e2e/artifacts/20261020T230644Z-1200249/).
  The first attempt stopped before application startup because its isolated Postgres container
  exited; the successful retry ran after the integration database shut down. Its console output is
  in `results/ui-reads/staged-e2e-retry.log`.
- [Raw measurements](results/ui-reads/staged-final.json), [summary](results/ui-reads/staged-final-summary.json),
  [response parity](results/ui-reads/staged-parity.json), [environment](results/ui-reads/staged-environment.json).
