# Large web benchmark

This opt-in benchmark captures a repeatable baseline before production performance changes. It does not run in CI and does not modify application code.

## Fixture

`pnpm perf:web:seed` replaces only the marked `[LOCAL PERF] Kanera Web Benchmark` organisation in the local development database. It refuses production and non-local database URLs.

The fixture contains:

- 40 boards for app-shell navigation;
- 20 workspace-scoped lists;
- exactly 1,000 active cards on the primary board;
- descriptions, three labels, two or three assignees, due dates, and seven custom-field values on every card;
- 60 rich cards with two eight-item checklists and eight comments each.

Login with `perf@kanera.local` / `Perf12345`.

## Run

Start the migrated local database and the normal development stack, then run:

```bash
pnpm perf:web:seed
pnpm dev
# In another terminal:
pnpm perf:web
```

The runner uses pinned Playwright Test `1.61.1` through `npx`; it does not add Playwright to the repository dependencies or lockfile. If that Playwright browser revision is not already installed, run `npx -y playwright@1.61.1 install chromium` once.

Useful options:

```bash
PERF_LABEL=before-signals pnpm perf:web
PERF_NAVIGATION_RUNS=7 pnpm perf:web
PERF_BASE_URL=http://localhost:4200 pnpm perf:web
PERF_OUTPUT=/tmp/kanera-before.json pnpm perf:web
```

Every successful run writes its complete JSON result to `benchmarks/web/results/<timestamp>-<label>.json`. The timestamp uses UTC and the optional `PERF_LABEL` makes before/after runs easy to identify. `PERF_OUTPUT` overrides the generated path when a specific destination is needed.

Results are also printed as a table and as one machine-readable `KANERA_PERF_RESULT=...` JSON line.

## Coverage

The runner measures:

- app-shell/home navigation with 40 board links;
- initial board render and the fully mounted 1,000-card board;
- document-click fanout before and after mounting all cards;
- board search and list-view switching;
- retained heap after opening 25, then 50 unique rich card details, followed by a cached reopen cycle;
- initial and fully mounted 1,000-card Assigned Work views;
- post-GC JavaScript heap, DOM size, global listener counts by event, layout/style counters, request count, and encoded bytes.

Navigation timing uses the median of five warm runs by default. Compare runs on the same machine, browser, viewport, dev-stack state, and commit; absolute development-build timings are less important than the before/after delta.
