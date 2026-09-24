# Browser E2E suite

Run `pnpm test:e2e` from the repository root, or pass spec names after `--` to run a subset (`pnpm test:e2e -- guest-access reconnect`). Everything after `--` is forwarded to `playwright test`, so `-g "<title>"` and `--repeat-each 3` work too.

The runner:

- starts isolated Postgres and Valkey containers (`docker-compose.e2e.yml`), then migrates and seeds them;
- starts the API, public API, worker, and web app as separate processes on E2E-only ports (`e2e/ports.json`), so a local dev stack on 3000–3003 and 4200 can keep running;
- runs Chromium with the timezone pinned to UTC and the locale to en-US.

It never touches the development database. You need Docker and a Playwright Chromium install (`pnpm exec playwright install chromium`).

## Topology the suite depends on

- **Real Valkey.** Services run with `NODE_ENV=development`. `NODE_ENV=test` would swap Valkey for a per-process `ioredis-mock`, and cross-process realtime could never deliver.
- **Same-origin web build.** The web app uses the `e2e` Angular configuration (`/api`, `/socket.io` and `/public-api` on the web origin). `e2e/web-proxy.config.mjs` mirrors `apps/web/nginx.conf`, including the refresh-cookie path rewrite.
- **Separate processes.** Public API writes and webhooks go through the durable outbox, which the worker drains.

## Writing tests

Import `test` and `expect` from `./support/fixtures`, not from `@playwright/test`.

| Fixture | Use it for |
|---|---|
| `signIn(page, "amelia")` | API sign-in, then lands on the app shell. `auth.spec.ts` is the only spec that uses the login form. |
| `pageAs("marcus", { beforeSignIn })` | A second signed-in user in their own context, closed automatically. `beforeSignIn` installs routes, such as `SocketLink`, before the app loads. |
| `apiAs("amelia")` | Authenticated app-API client for setup that is not the subject of the test. Paths start with `/api/`. |
| `uniqueName("E2E card")` | Names that are unique per test and per repeat, so `--repeat-each` and shared titles never collide. |
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
- **Prove the negative before relying on it.** If a test disconnects something, assert that the disconnection happened, as `reconnect.spec.ts` does with `refusedAttempts` and a bounded check that nothing arrived.
- **Check a new assertion can fail.** When adding a check for a bug, run it once against the unfixed behaviour and confirm it fails.

## Artifacts

Each run writes `e2e/artifacts/<UTC timestamp>-<pid>/`, and the newest 10 runs are kept (`KANERA_E2E_KEEP_RUNS`). A run contains:

- `REPRODUCE.txt`: the command, git revision, working-tree state, fixture and browser settings;
- `worktree.patch` and `untracked.tar.gz`, when the tree was dirty;
- `results.json` and an HTML report (`report/`);
- per-test traces and screenshots (`test-results/`);
- logs for every service (`api`, `public-api`, `worker`, `web`) plus the migrate, seed and Docker logs.

Open a trace with `pnpm exec playwright show-trace <path>/trace.zip`.

See `COVERAGE.md` for which failures each spec catches and how that maps to isolated tests.
