# Parallel UI reads: benchmark and verification

Independent database reads now overlap in sidebar navigation, Portfolio, workspace members,
notifications, search, Global Work catalog and workspace detail. The shared accessible-board
resolver overlaps admin and explicit grants while preserving admin precedence. Workspace settings
starts both HTTP request groups after the role is resolved.

## Measured results

Values are medians of six batch p50/p95 measurements, in milliseconds. Each batch contains 100
successful requests per version (600 samples per endpoint/version/concurrency). Batch order alternates
before/after and after/before. Positive percentages mean faster.

| Endpoint | 1 request p50 before → after | Improvement | 1 request p95 before → after | 10 requests p50 before → after | Improvement | 10 requests p95 before → after |
|---|---:|---:|---:|---:|---:|---:|
| Sidebar | 13.23 → 7.93 | 40.0% | 14.88 → 9.28 | 31.10 → 33.67 | -8.3% | 37.12 → 40.52 |
| Portfolio | 12.88 → 9.14 | 29.1% | 14.76 → 10.25 | 22.78 → 22.95 | -0.8% | 27.19 → 28.22 |
| Workspace members | 4.61 → 3.83 | 16.9% | 5.72 → 4.97 | 6.45 → 5.79 | 10.2% | 8.62 → 7.79 |
| Notifications | 15.05 → 12.55 | 16.6% | 16.93 → 14.33 | 24.03 → 22.90 | 4.7% | 28.63 → 27.36 |
| Search | 13.65 → 10.02 | 26.6% | 17.51 → 13.89 | 26.01 → 25.88 | 0.5% | 31.90 → 30.28 |
| Work catalog | 7.71 → 6.94 | 10.0% | 9.08 → 8.18 | 23.82 → 25.10 | -5.4% | 35.33 → 32.39 |
| Workspace detail | 3.97 → 3.64 | 8.5% | 4.91 → 4.44 | 12.09 → 11.28 | 6.7% | 14.99 → 13.79 |

All seven endpoints improved at single-request concurrency. Six improved in all six paired batches;
workspace detail improved in five. At ten concurrent requests, sidebar p50/p95 regressed about 8–9%;
catalog p50 regressed 5.4% while its p95 improved. Portfolio and search p50 were approximately unchanged.
Parallelism reduces serial wait but keeps the query work and increases simultaneous demand on the
fixed pool. These changes are not a throughput improvement under every load.

## Method and limits

- HTTP timings include reading the complete response body; they are not SQL-only or browser-paint times.
- Two non-watching local API processes on ports 3100/3101 used the same development database and
  environment, Node 24.18.0, development mode, metrics enabled and `PG_POOL_MAX=10` each. Only one
  version received benchmark traffic at a time.
- Fixture: 19 users, 9 workspaces, 22 boards, 238 cards and 249 notifications across the database.
  The measured caller was seeded organisation owner `amelia@kanera.test`; the workspace was
  Development Team. No database reset, schema/index change or artificial latency was applied.
- Each endpoint/version receives 20 sequential warmup requests before the six measured batches.
- This is a shared developer machine (Ryzen 7 7840HS, 16 logical CPUs), with other browser workloads
  active. Initial long sequential before/after passes varied substantially; the table uses only six
  short alternating paired batches. This reduces drift but is not a production-capacity experiment.
- Gains include the shared resolver change as well as endpoint-specific changes; they do not isolate
  the contribution of each edit.
- The ten-request workload repeatedly hits one endpoint at a time; mixed traffic, a larger database,
  hosted billing paths and deployment network latency were not benchmarked.
- Each paired scenario compares complete baseline/optimized JSON before timing and aborts on any
  HTTP/network error. The 16,800 measured requests completed successfully. A separate 32-response
  comparison across owner, workspace admin, member and guest accounts also matched exactly,
  including denied responses.
- Existing board-members-menu edits were present in both versions and are excluded from these gains.

## Reproduce

Start before and after APIs on separate local ports with identical database, JWT, media-signing,
deployment and pool settings. Run from the repository root:

```bash
PERF_API_URL=http://localhost:3100 PERF_COMPARE_URL=http://localhost:3101 \
  PERF_ROUNDS=6 PERF_SAMPLES=100 PERF_LABEL=paired \
  node benchmarks/api/ui-reads.mjs

PERF_API_URL=http://localhost:3100 PERF_COMPARE_URL=http://localhost:3101 \
  PERF_ROUNDS=6 PERF_SAMPLES=100 PERF_CONNECTIONS=10 PERF_LABEL=paired \
  node benchmarks/api/ui-reads.mjs

node benchmarks/api/ui-reads-summary.mjs benchmarks/api/results/ui-reads/paired-c1.json
node benchmarks/api/ui-reads-summary.mjs benchmarks/api/results/ui-reads/paired-c10.json
```

The harness refuses remote hosts. `PERF_EMAIL`, `PERF_PASSWORD`, `PERF_OUTPUT` and the values above
are configurable. Login creates a local session; measured endpoints only read application data.
Result files overwrite the same label/concurrency, so use a new label to retain another run.

Baseline Git revision: `a1c6df4d25483a4ec1dedccaee30527544f417ba`, plus the working-tree changes already present at task start.

The exact baseline API snapshot is saved in `results/ui-reads/before-api-src.tar.gz`; implementation
changes are in `results/ui-reads/implementation.patch`. These ignored local artifacts are required
to reproduce this particular uncommitted baseline.

Restore the saved baseline into a new temporary directory:

```bash
mkdir -p /tmp/kanera-ui-read-before
tar -xzf benchmarks/api/results/ui-reads/before-api-src.tar.gz -C /tmp/kanera-ui-read-before
ln -s "$PWD/apps/api/node_modules" /tmp/kanera-ui-read-before/node_modules
API_PORT=3100 UPLOADS_DIR=/tmp/kanera-ui-read-before/uploads \
  AUTH_RATE_LIMIT_ENABLED=false PG_POOL_MAX=10 \
  pnpm with:local-env pnpm --filter @kanera/api exec tsx /tmp/kanera-ui-read-before/src/index.ts
```

In a second terminal, start the optimized source:

```bash
API_PORT=3101 UPLOADS_DIR=/tmp/kanera-ui-read-after/uploads \
  AUTH_RATE_LIMIT_ENABLED=false PG_POOL_MAX=10 \
  pnpm with:local-env pnpm --filter @kanera/api exec tsx src/index.ts
```

Ports must be free. Stop these temporary processes after benchmarking. The normal development
API/web processes need not be stopped.

## Verification

- `pnpm lint`: passed, zero errors; 37 existing web warnings.
- `pnpm test:api:integration -- apps/api/src/modules/work/routes.itest.ts apps/api/src/modules/workspaces/routes.itest.ts apps/api/src/modules/search/routes.itest.ts apps/api/src/modules/notifications/routes.itest.ts apps/api/src/lib/accessible-boards.itest.ts`: 90 tests passed across five files.
- `pnpm --filter @kanera/web test -- workspace-settings.page.spec.ts`: 82 tests passed.
- `pnpm test:e2e -- guest-access angular-settings-races attachment-reactions`: seven tests passed,
  including live guest revocation, settings edits and cross-process notification delivery.
  Traces/screenshots/logs: [E2E artifacts](../../e2e/artifacts/20261020T202055Z-703200/).
- Additional Chromium check at 1440×900 and 390×844: settings members rendered, eight expected
  data requests succeeded, no page errors or HTTP 5xx. Members/API keys/webhooks/guests requests
  began in the same millisecond on both viewports. This confirms HTTP-group overlap; it is not a
  before/after browser-paint benchmark.

Local artifacts under `benchmarks/api/results/ui-reads/`: raw `paired-c1.json`/`paired-c10.json`,
summaries, exploratory runs, `environment.json`, `parity.json`, verification logs, desktop/phone
PNGs, browser traces, baseline source archive and implementation patch. Results are intentionally
gitignored; this document and the benchmark scripts are source files.

Screenshots: [desktop](results/ui-reads/settings-desktop.png), [phone](results/ui-reads/settings-phone.png).
Raw paired results: [one request](results/ui-reads/paired-c1.json), [ten requests](results/ui-reads/paired-c10.json).
