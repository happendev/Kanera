# Browser E2E suite

Run `pnpm test:e2e` from the repository root, or pass spec names after `--` to run a subset (`pnpm test:e2e -- guest-access reconnect`). Everything after `--` is forwarded to `playwright test`, so `-g "<title>"` and `--repeat-each 3` work too.

The runner:

- starts isolated Postgres and Valkey containers (`docker-compose.e2e.yml`), then migrates and seeds them;
- starts the API, public API, worker, MCP server, and web app as separate processes on E2E-only ports (`e2e/ports.json`), so a local dev stack on 3000–3003 and 4200 can keep running;
- builds the `kanera` CLI bundle that CLI specs execute;
- runs Chromium with the timezone pinned to UTC and the locale to en-GB.

The web server uses `--watch=false --hmr=false --live-reload=false` to serve its startup build throughout the run. Concurrent development edits must not trigger browser reloads that interrupt fetches or user flows. Restart the suite to test a new build.

It never touches the development database. You need Docker and a Playwright Chromium install (`pnpm exec playwright install chromium`).

## Concurrent CI runs

CI splits the suite into three duration-balanced shards on separate GitHub-hosted runners. Each shard
starts its own freshly migrated and seeded Postgres, Valkey, API, worker, MCP server and web app.
Tests remain sequential within that stack (`workers: 1`, `fullyParallel: false`): seeded users,
boards, settings and realtime rooms must not be shared by concurrently executing tests.
`support/shards.ts` assigns whole spec files, slowest first, to the lightest shard using the recorded
file durations in `timings.json`. Files stay together and execute in Playwright's normal order.
New specs are discovered automatically with an estimated weight; the timing file is not an allowlist.
Refresh weights after a successful full run with
`node scripts/update-e2e-timings.mjs e2e/artifacts/<run>/results.json` and commit the updated JSON.

The `seed` project runs the `seed-*.spec.ts` files against the pristine database before the
`behavior` project on every shard. These are curated demo-data checks with small UI rendering
checks, not prerequisites that depend on a behavior test's mutations. They also run first in an
unsharded invocation. Run them alone with `pnpm test:e2e -- --project=seed`. When deliberately
repeating only behavior tests, `--project=behavior --no-deps` omits that already-verified dependency.

The three shards exercise the default-off compression setting, including
`realtime-compression.spec.ts`. The compression-enabled setting can be checked manually with
`REALTIME_WEBSOCKET_COMPRESSION_ENABLED=true`; it does not have a separate CI job.
CI caches the pnpm package store by lockfile and Chromium by Playwright version. Every runner still
performs a frozen-lockfile install and installs browser system dependencies.

Reproduce an individual shard or manually check compression locally:

```bash
KANERA_E2E_SHARD=1/3 pnpm test:e2e
KANERA_E2E_SHARD=2/3 pnpm test:e2e
KANERA_E2E_SHARD=3/3 pnpm test:e2e
REALTIME_WEBSOCKET_COMPRESSION_ENABLED=true pnpm test:e2e -- realtime-compression.spec.ts --project=behavior --no-deps
```

Run those commands one at a time on a local checkout: its fixed E2E ports, Docker Compose project
and database are protected by the runner's lock. CI concurrency comes from separate machines.
Do not increase `--workers` against a shared stack without first isolating its test fixtures.
Playwright's native `--shard=1/3` remains available for count-based partitioning; do not combine it
with `KANERA_E2E_SHARD`, which would shard an already restricted file set and omit tests.

All shards finish even if one fails, and upload separate `e2e-results-<index>-of-3` artifacts with
traces, screenshots, service logs, reports and the command/environment in `REPRODUCE.txt`.
The existing `e2e` CI check passes only when every shard passes, so branch protection can continue
requiring that check. Sharding repeats stack setup on each runner, trading more runner minutes
for a shorter wait; it does not skip tests or retry failures.

## Topology the suite depends on

- **Real Valkey.** Services run with `NODE_ENV=development`. `NODE_ENV=test` would swap Valkey for a per-process `ioredis-mock`, and cross-process realtime could never deliver.
- **Same-origin web build.** The web app uses the `e2e` Angular configuration (`/api`, `/socket.io` and `/public-api` on the web origin). `e2e/web-proxy.config.mjs` mirrors `apps/web/nginx.conf`, including the refresh-cookie path rewrite.
- **Separate processes.** Public API writes and webhooks go through the durable outbox, which the worker drains.

## Writing tests

Import `test` and `expect` from `./support/fixtures`, not from `@playwright/test`.

| Fixture | Use it for |
|---|---|
| `signIn(page, "amelia", destination?)` | API sign-in, then opens the destination (Home by default). Pass the test's starting route to avoid booting Home only to immediately abandon it. `auth.spec.ts` is the only spec that uses the login form. |
| `pageAs("marcus", { beforeSignIn })` | A second signed-in user in their own context, closed automatically. `beforeSignIn` installs routes, such as `SocketLink`, before the app loads. |
| `apiAs("amelia")` | Authenticated app-API client for setup that is not the subject of the test. Paths start with `/api/`. Reused per user within the test; disposed afterward. Browser sessions still authenticate independently. |
| `uniqueName("E2E card")` | Names that are unique per test and per repeat, so `--repeat-each` and shared titles never collide. |
| `testWorkspace` | An empty workspace/board with Backlog, Wishlist, In Progress and Done, accessible to Amelia, Marcus and Priya. Includes `addBoard(name)`; teardown deletes the workspace even after an assertion failure. |
| `runtimeGuard` (automatic) | Fails the test on an uncaught page error, a `console.error`, or any HTTP 5xx seen by any tracked page. |

`runtimeGuard` ignores two kinds of console error:

- `Failed to load resource`: access-denial flows expect 4xx responses, and 5xx responses are caught separately.
- Angular's dev-mode `NG02955` LCP-image advisory: it is layout-dependent, so it made results flaky.

Seeded users are in `support/env.ts`. All share the password `Abc12345`.

- `amelia`: owner.
- `marcus`: admin.
- `priya`: Development admin, and a teammate for Team Cards.
- `maya`: a user in another organisation, for guest tests.

Shared helpers:

- **`support/ui.ts`**: board navigation (`openBoard`, `boardHref`, `workspaceSettingsHref`, `expectBoardLoaded`, `expectBoardDenied`), cards (`createCard`, `openCard`, `cardTile`, `moveCardToBoard`), and card-detail edits made as a person makes them (`renameCard`, `setDescription`, `moveCardToList`, `completeCard`).
- **`support/socket.ts`**: `SocketLink` cuts and restores a context's realtime socket. `setOffline` does not reliably close an open WebSocket.

Rules that keep results trustworthy:

- **Wait for data, not for a route.** Use `expectBoardLoaded(page, name)`: the board `h1` appears only once the board has loaded. `k-board` and the page header render before the access check, so a denied user passes a check on either of them.
- **Own the state you change.** A test that revokes access, deletes something, or changes shared settings creates its own board, card, or field first. It must not depend on which spec ran before it.
- **Unique names are not cleanup.** Use `testWorkspace` for ordinary board behavior; keep explicit `finally` cleanup for personal keys, reminders and webhook receivers. Remove webhook subscriptions before closing a local receiver. If historical state cannot be created through today's API, scope direct database setup to test-owned IDs in the fixed E2E Docker project; never mutate the shared seed to manufacture it.
- **Prove the negative before relying on it.** If a test disconnects something, assert that the disconnection happened, as `reconnect.spec.ts` does with `refusedAttempts` and a bounded check that nothing arrived.
- **Check a new assertion can fail.** When adding a check for a bug, run it once against the unfixed behaviour and confirm it fails.
- **Mind the lane render cap.** A lane mounts only its first 15 cards (`INITIAL_RENDER_CAP` in `list.component.ts`). By late in a full run, seed lists exceed that, so a newly created tile can be in state but not in an observing page's DOM. Assert late tiles with `expectCardTileMounted(page, title, listId?)`. A realtime spec that fails only in the full suite and only for the newest cards is usually this, not a fanout regression.
- **Record coverage.** Add each new spec's caught failures to `COVERAGE.md`.

## Artifacts

Each run writes `e2e/artifacts/<UTC timestamp>-<pid>/`, and the newest 10 runs are kept (`KANERA_E2E_KEEP_RUNS`). A run contains:

- `REPRODUCE.txt`: the command, git revision, working-tree state, fixture and browser settings;
- `worktree.patch` and `untracked.tar.gz`, when the tree was dirty;
- `results.json` and an HTML report (`report/`);
- per-test traces and screenshots (`test-results/`);
- logs for every service (`api`, `public-api`, `worker`, `mcp`, `web`) plus the migrate, seed, CLI build and Docker logs.

Open a trace with `pnpm exec playwright show-trace <path>/trace.zip`.

See `COVERAGE.md` for which failures each spec catches and how that maps to isolated tests.

## What a passing suite establishes

The normal stack is self-hosted Chromium. Narrow viewport screenshots check layout; only tests
that enable coarse-pointer/touch input establish touch interaction behavior. Screenshots are
debugging evidence, not pixel baselines; geometry assertions provide automated layout checks.

Offline tests cut the API and realtime connection while the dev server still serves assets. They
verify persisted app data, read-only behavior and reconnect convergence, not production service-worker
cold boot or update installation. Localized manifest tests inspect metadata, not PWA installation.

`billing-realtime` invokes hosted conversion transactions and observes their fanout; it does not
exercise checkout or payment-provider webhooks. `email-unsubscribe` constructs signed tokens and
tests consumption, not outbound email delivery. MCP local cancellation tests prove session reuse,
not server-side work cancellation. Concurrent API request bursts are useful stress checks, but do
not force a specific database interleaving; retain deterministic integration coverage for those races.

## Hosted analytics regression

`pnpm test:analytics` runs a separate
production-configured web build on port 4223, with all backend and analytics requests intercepted.
It does not contact production or create accounts. It checks shared anonymous identity, consent
boundaries and first-touch signup payloads. Traces and desktop/mobile screenshots are saved under
`e2e/artifacts/analytics/`. The usual E2E build disables analytics, so cannot exercise this startup path.
