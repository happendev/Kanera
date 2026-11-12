# Implemented backend performance improvements — 2026-11-11

Implemented the clear, behaviour-preserving wins from the [drawer-query investigation](drawer-queries.README.md)
and [Valkey/outbox investigation](realtime-costs.README.md). No request parallelism or database query
concurrency was added. The final measurements below exercise the actual application functions,
not the earlier SQL prototypes.

## Changes

- **First activity page:** independently bound the indexed entity and payload lookups, combine with
  `UNION`, and apply the existing ordering/limit. Historical events matching both paths remain one
  event. Board scope, visibility, actor metadata and the merged comment/activity cursor are preserved.
  Cursor pages retain their original OR lookup because splitting those regressed in the investigation.
- **Notification ordering:** replace the shorter user/time index with
  `(user_id, created_at DESC, id DESC)`, matching the existing pagination order. Migration
  `0098_illegal_mandroid.sql` was generated from the shared schema and applied locally. Notification
  visibility rules and JIT settings are unchanged.
- **Filtered audience publication:** reuse the existing 100-recipient outbox insertion helper,
  awaiting chunks sequentially. Keep one private payload per unique recipient and the separate
  board/workspace webhook/audit row. A foreign-key rejection rolls back the whole chunk, so that
  definite failure falls back to sequential individual inserts, preserving delivery to surviving
  recipients if another recipient was deleted. Ambiguous connection failures are not retried.
- **LISTEN sessions:** the event dispatcher, direct dispatcher and mirror scheduler share one
  process-local PostgreSQL connection, including both subscribers to the event channel. Subscriber
  removal, reconnect and shutdown are serialized. Polling remains the durability fallback. The
  worker pool ceiling falls from five to three under the default Compose budget, leaving the same
  two ordinary-query slots; it does not turn the saved listener sessions into extra query concurrency.

Deferred: presence counter state needs a mixed-version API/reaper rollout design to preserve online/offline
behaviour; it was not introduced. The modest outbox claim-CTE optimization was not included. Rejected
notification visibility rewrites, cursor-page splitting and global JIT changes remain unapplied.

## Results

Milliseconds, p50 / p95. Warm local synthetic data; **not HTTP latency, browser opening time, or
production throughput**. Activity and publication rows use the 5,000-notification fixture.

| Actual operation | Before | After |
| --- | ---: | ---: |
| First activity page, 300,008 board events | 86.17 / 91.14 | 3.11 / 5.74 |
| Next activity page, same board | 2.04 / 2.80 | 1.77 / 2.69 |
| Notification page, 5,000-item inbox | 59.89 / 64.80 | 43.91 / 50.16 |
| Notification page, 50,000-item inbox | 5-second query timeout | 417.79 / 432.57 |
| Unread count, 5,000-item inbox | 3.30 / 4.59 | 3.19 / 4.06 |
| Unread count, 50,000-item inbox | 45.43 / 54.76 | 45.04 / 46.68 |
| Filtered publication, 10 recipients | 69.42 / 71.65 | 14.46 / 15.99 |
| Filtered publication, 100 recipients | 616.78 / 766.10 | 20.05 / 23.30 |
| Insert 100 notifications, 5,000 existing | 13.18 / 14.74 | 13.50 / 14.87 |
| Insert 100 notifications, 50,000 existing | 12.86 / 13.36 | 12.12 / 14.60 |

First-page activity is about **28× faster**, the smaller notification page is **27% faster**, and
100-recipient publication is **31× faster** on this fixture. The large inbox now completes well
below the original five-second timeout. Cursor pages and unread counts remain similar; write
samples show small variation without a consistent direction across fixture sizes.

Publication executes **24 → 6** commands for 10 recipients and **204 → 6** for 100. These counts
include the board-to-workspace lookup, board outbox insert/NOTIFY and a final drain barrier. The
recipient-specific portion alone is **200 → 2** at 100 recipients, with all 100 durable rows retained.
Actual foreign keys are enabled during measurement, unlike the earlier table-clone experiment.

The replacement notification index costs more storage: **216 → 304 KiB** at 5,000 notifications,
and **2,008 → 2,904 KiB** at 50,000. The old index is dropped, so there is no redundant second index.
The small local write sample is not a production write-capacity estimate.

## Method and reproduction

Run one command at a time from the repository root with the local `kanera-postgres` container available:

```bash
node benchmarks/api/implemented-performance.mjs
DRAWER_NOTIFICATIONS=50000 DRAWER_OUTPUT=benchmarks/api/results/implemented/large \
  node benchmarks/api/implemented-performance.mjs
```

The runner archives baseline API source from `952a94c919782ce3a1c68fca041acf0796ad66e3` into a temporary
directory (`BENCH_BASELINE_REF` can override it). Baseline and current source use the same installed
dependencies/shared schema. It creates, migrates and seeds its own `kanera_drawer_<pid>` database,
then removes it and the source snapshot in `finally`. It never resets the development database.
The inner harness refuses non-loopback hosts or a database outside that naming pattern. A killed
runner may leave its own disposable database behind.

- PostgreSQL 18.6, Node 24.18.0, Ryzen 7 7840HS; environment/revision recorded with each run.
- 3,400 cards across three workspaces; 3,000 on the main board, 120 members, 300,008 activity events.
  Inboxes contain 5,000 or 50,000 notifications with 10% unread. Fixture loading alone disables FK
  triggers; they are restored before any measurement.
- One connection per version, serial operation calls, PostgreSQL parallel workers disabled. The
  existing application's concurrent promises queue on that one connection. No benchmark/E2E/lint
  workload was intentionally run alongside the timed runs.
- Six alternating before/after batches. One warm-up operation per batch is excluded; activity,
  unread count and insertion have 30 retained samples per version, pages/publication have 18.
  p95 is the empirical sample percentile, not a statistically established service tail latency.
- Complete feed and notification results are checked for equality. Feed fixtures include overlapping
  references, payload-only references, hidden events and equal timestamp priorities. Outbox evidence
  checks exact recipient IDs/payloads and the retained webhook row. Generated UUIDs/timestamps are
  excluded from outbox equivalence checks.
- Notification functions are unchanged: old/new indexes are swapped outside timed batches. The
  original 50,000-item page times out; equivalence uses the same original SQL with nested loops and
  JIT disabled **only for that untimed reference run**, then restores both settings. The revised
  timed operation uses ordinary settings. Timeouts are recorded, never counted as fast successes.
- Notification write measurements insert the same 100 valid, preselected FK-backed rows. Cleanup
  and index replacement are untimed. This includes normal indexes and FK checks but excludes
  notification construction, audience resolution and outbox publication.
- Publication timings include the real function plus a connection barrier to drain its asynchronous
  NOTIFY. Cleanup is untimed. Payloads are deliberately small; production payload size and durable
  storage latency will affect absolute results.

Raw samples, environment, fixture shape, captured harness and publication parity evidence are under
[small](results/implemented/small/) and [large](results/implemented/large/). These artifacts are gitignored;
the runner and this report are versioned.

## Verification

- `pnpm --filter @kanera/api build` — passed.
- `pnpm db:generate` and `pnpm db:migrate:local` — passed; new migration only.
- `pnpm test:api:integration -- apps/api/src/modules/comments/routes.itest.ts apps/api/src/modules/notifications/routes.itest.ts apps/api/src/realtime/outbox.itest.ts apps/api/src/realtime/notify-listener.itest.ts`
  — **70 passed**. Coverage includes overlap deduplication/ordering, notification access and cursor
  semantics, multi-chunk publication with a deleted recipient, one-session/two-channel dispatch,
  release while waiting for a connection, reconnect, and final channel/callback cleanup.

- `pnpm lint` — passed, including API/web typechecks, E2E typecheck and knip; 38 existing frontend
  ESLint warnings, no errors or new backend warnings.
- `pnpm test:api` — **267 passed**.
- `pnpm test:api:integration -- apps/api/src/realtime/outbox.itest.ts` — **7 passed** on the final test
  revision, which retains the original default-audience assertion as well as stale-audience batching coverage.
- A read-only `pg_stat_activity` check during the real E2E run observed **one** idle LISTEN session
  for the running worker's three subscribers (`results/implemented/e2e-listener-count.txt`).

- Cross-process E2E — **10 passed**, with real PostgreSQL, Valkey, API, public API, worker and Chromium.
  The run used `PG_POOL_MAX=5`, so the worker exercised its reduced three-connection ceiling.
  Covered live activity, card-follow/reminder delivery, guest isolation/revocation, mirror wakeups and
  reconciliation, filtered board metadata over private user rooms, signed webhooks, and scheduling
  conflict notifications. Reproduce:

  ```bash
  PG_POOL_MAX=5 pnpm test:e2e -- public-api.spec.ts card-follow.spec.ts performance-async.spec.ts \
    checklist-activity.spec.ts guest-access.spec.ts timeline-notifications.spec.ts
  ```

  Traces, screenshots and service logs:
  [e2e/artifacts/20261111T230214Z-357918](../../e2e/artifacts/20261111T230214Z-357918/).
  The existing public-API E2E now also renames a board through an admin-scoped workspace key and
  verifies live sidebar delivery plus the separate webhook.

Test logs are under `results/implemented/`. No production database or service was used. The broader
full E2E suite and production load testing were not run.
