# Card drawer and notification query experiments — 2026-11-11

Historical investigation of the pre-change code. See [implemented changes and verification](implemented-performance.README.md)
for the current implementation, updated measurements, and reproducible before/after runner.

This is a performance investigation, with executable SQL prototypes. It does **not** change the
application, database schema, deployed indexes, connection-pool size, or request concurrency.
The strongest candidates are bounded activity-feed lookups and notification card-visibility checks.

## Reproduce

From the repository root, with the local `kanera-postgres` development container running:

```bash
DRAWER_OUTPUT=benchmarks/api/results/drawer-queries-small-final \
  node benchmarks/api/drawer-queries.mjs
DRAWER_NOTIFICATIONS=50000 DRAWER_OUTPUT=benchmarks/api/results/drawer-queries-large \
  node benchmarks/api/drawer-queries.mjs
pnpm lint
```

The runner creates a uniquely named `kanera_drawer_<pid>` database, migrates it, seeds synthetic data,
and removes it in `finally`. It does not reset or modify the development database. The SQL experiment
process additionally refuses any host except `127.0.0.1` or any database outside that naming pattern.
Fixture-only bulk loading temporarily disables foreign-key triggers for rows derived from existing
seeded records; triggers are restored before measurement. A killed runner can leave its disposable
DB behind; never use its database-name pattern to delete an unrelated database.

The API's existing dependencies are reused. No dependency installation or production connector is
needed. Artifacts are gitignored under the chosen output folder; the scripts and this report are
versioned. `harness/` preserves the scripts used by each final run.

## Method

- Node 24.18.0 and local PostgreSQL; exact CPU, PostgreSQL version and source revision in
  `environment.json`.
- 3,400 cards across three workspaces, with 3,000 on the main board; 300,008 activity events,
  20 members, and either 5,000 or 50,000 notifications for the seeded owner. Ten percent of
  notifications are unread. The data intentionally stresses a busy board and a large inbox.
- One pool connection, sequential benchmark calls, and `max_parallel_workers_per_gather=0`.
  Existing application `Promise.all` calls queue on that one connection. No parallelization is
  introduced by any candidate.
- Screening invokes the actual backend module functions, five times per operation. These numbers
  include module work and query-capture instrumentation, but exclude HTTP, authentication, card
  authorization, response serialization, and the asynchronous internal-link repair. They are not
  browser drawer-opening times. Five samples are screening data, not a reliable tail-latency study.
- Activity and fixed-recipient comparisons use six alternating before/after batches of ten SQL
  executions (60 samples per version), after executing both queries for result equality.
- Visibility prototypes have 30 SQL samples and full-result equality checks. Where the original
  query times out, equality is checked using the **same original SQL** with nested-loop plans and
  JIT disabled. Those reference executions are excluded from baseline timing results.
- Index comparisons alternate four before/after `EXPLAIN (ANALYZE, BUFFERS)` runs. JIT comparisons
  alternate three times per setting. Index/JIT figures are server execution times; the other SQL
  samples include a local pg round trip and result decoding. Do not compare these as identical metrics.
- Five-second query timeouts are recorded as failures, never silently removed from latency results.
- This is a shared development machine and warm-cache synthetic data, not a production capacity
  test. No claim is made about concurrent-user throughput, cold storage, hosted billing, or write cost.

## Findings

### 1. Bound the first card-activity page before combining the two lookup paths

The current activity query filters on `(entity_type = card AND entity_id = cardId) OR
payload.cardId = cardId`, then orders and limits. PostgreSQL chose the board/time index and
scanned unrelated activity to find the target card. The prototype uses two independently bounded
queries with the existing entity and payload indexes, followed by `UNION`, ordering and a final limit.
It adds no database index and remains one SQL command.

| 300,008-activity fixture | Current SQL p50 / p95 | UNION SQL p50 / p95 | Buffer hits, example plans |
|---|---:|---:|---:|
| First page | 86.52 / 93.06 ms | 1.62 / 1.99 ms | 153,900 → 57 |
| Next page | 0.82 / 1.52 ms | 1.83 / 2.84 ms | 8 → 17 |

The first-page median improves **98.1%**. The next-page query already has a good plan and regresses
about **1 ms**. Apply the measured optimization to first-page reads; do not blindly replace the
cursor path. Both pages pass complete-row equality, including overlapping entity/payload matches,
payload-only card references, hidden/comment exclusions and same-timestamp priorities.

Relevant application code: `apps/api/src/modules/comments/card-feed.ts`.
Raw paired samples and plans: [large activity experiment](results/drawer-queries-large/experiments.json).

### 2. Avoid the notification visibility join's pathological card scan

The original notification page/group/count queries left-join cards to reject archived cards and
completed overdue items. At 50,000 notifications the planner estimated approximately one eligible
notification and chose repeated full card-table scans. The page, board-group counts and mention
counts all exceeded the **5,000 ms SQL timeout**.

The prototype replaces those two card conditions with `NOT EXISTS` checks for an archived card
and, only for overdue reasons, a completed card. It removes the card join when no other selected
or filtered field needs it. All other visibility/access predicates remain unchanged. This also
preserves null-card and absent-card left-join semantics.

| 50,000-notification fixture | Original SQL | Visibility prototype p50 / p95 |
|---|---:|---:|
| All-tab page selector | >5,000 ms, timeout | 475.10 / 581.20 ms |
| Board-group counts | >5,000 ms, timeout | 454.72 / 487.99 ms |
| Mention counts | >5,000 ms, timeout | 343.27 / 376.65 ms |

These are **SQL query** times, not complete HTTP responses. The All-tab selector is one of five
queries in the page operation. The three improvements are lower bounds of about **90–93%** versus
the timeout, not exact speedups. All eight transformed query occurrences passed result equality;
for timed-out originals, the unchanged original SQL was evaluated with a different plan solely to
obtain the reference result. JIT stays enabled during the prototype timing and no new index is used.

This is not yet a fully optimized path: example rewritten plans still spent 310–382 ms compiling
JIT code. Other notification operations were already much faster and should not be assigned these
same gains.

Relevant code: `apps/api/src/lib/notification-visibility.ts` and
`apps/api/src/modules/notifications/notification-feed.ts`.
Raw results: [large visibility experiment](results/drawer-queries-large/visibility-experiment.json).

### 3. Ordering index and JIT are separate alternatives to measure

An experimental `(user_id, created_at DESC, id DESC)` notification index matches the complete page
ordering. On the initial 5,000-notification run, an example plan reduced rows processed from 5,000
to 31 and buffer hits from 20,125 to 128. On the final 50,000 fixture, the original page selector
changed from repeated five-second timeouts to **410.43 ms median server execution** across four
index-enabled plans. This measurement uses the original visibility join, not the EXISTS prototype.

JIT compilation dominates several small OLTP reads. Disabling JIT alone on the 50,000 fixture did
**not** rescue the pathological page/group/mention plans: they still timed out. Fix the query or
index access path first. Do not add the independent index, query-rewrite and JIT gains together.

The new index costs storage and maintenance on every notification write. Its exact measured size
is in `combined.json`; write throughput and migration locking were not benchmarked. Prefer evaluating
it as a replacement for the existing shorter user/time index, after checking the revised query plan.
A global JIT change needs broader workload validation, including long-running analytical queries.

Raw alternatives: [index plans](results/drawer-queries-large/index-experiment.json),
[JIT plans](results/drawer-queries-large/jit-experiment.json),
[index plus JIT disabled](results/drawer-queries-large/combined.json).

### Rejected or limited candidates

Replacing correlated notification recipient references with the already-bound user ID was not a
consistent improvement across paging and counts; some cases regressed. Do not ship that rewrite on
these results. The first activity-page UNION also regresses the next page, as shown above.

Card-detail assembly itself was approximately **6 ms** for both ordinary and rich cards in the final
large run, using **12 queries** for the ordinary card. That excludes authorization and asynchronous
link repair. The demonstrated drawer bottleneck is activity retrieval; this investigation does not
justify rewriting the detail assembler or claiming that its background workspace-note repair is free.

The complete original module screening is in [profiles.json](results/drawer-queries-large/profiles.json).
### Small-fixture cross-check: the visibility rewrite is not a universal win

Final paired SQL measurements on 5,000 notifications (six alternating batches, 30 samples/version):

| Query | Original median | Visibility rewrite median |
|---|---:|---:|
| All-tab selector | 67.28 ms | 79.72 ms |
| Board-group counts | 43.86 ms | 47.35 ms |
| Mention counts | 32.20 ms | 33.33 ms |
| Unread count | 2.32 ms | 2.52 ms |

The visibility rewrite fixes the demonstrated large-inbox plan failure but regresses this smaller
fixture. It needs further plan tuning before a blanket rollout. The original-query ordering-index
experiment is more consistent: **38.45 → 27.12 ms** median server execution on the small fixture,
and timeout → **410.43 ms** on the large fixture. These independent runs must not be conflated with
the paired visibility-query timings above.

With the original small-fixture queries and no extra index, JIT on → off reduced median server
execution from **37.26 → 12.34 ms** for the page selector, **46.28 → 14.42 ms** for board-group
counts, and **29.59 → 2.99 ms** for mention counts. This is a worthwhile OLTP configuration
experiment, not a recommendation to change production globally without mixed-workload validation.
The experimental ordering index measured **304 KiB** at 5,000 notifications and **2.84 MiB** at
50,000; adding it alongside existing indexes duplicates some storage/write work.

The final small fixture independently reproduced the activity tradeoff: first-page SQL p50
**133.65 → 2.75 ms**, next-page SQL **1.24 → 2.41 ms**. Absolute times varied on the shared machine,
but the alternating comparisons and buffer reductions consistently identified the same bottleneck.

Raw final small results: [query comparisons](results/drawer-queries-small-final/experiments.json),
[visibility comparisons](results/drawer-queries-small-final/visibility-experiment.json),
[index plans](results/drawer-queries-small-final/index-experiment.json),
[JIT plans](results/drawer-queries-small-final/jit-experiment.json).

Recommended order: first-page activity query; notification ordering index (with write-cost checks);
then tune notification visibility/JIT together against both inbox sizes. Keep the already-efficient
activity cursor path. Do not ship the rejected recipient rewrite.

## Verification

- Both reproduction commands completed successfully on the final harness versions saved with their
  results. Expected original-query timeouts remain visible in the large-fixture artifacts.
- First/next activity-page full-result parity passed on both final fixtures. All eight transformed
  notification-query occurrences passed full-result parity in each fixture. These are fixture
  comparisons, not a replacement for production authorization/pagination regression coverage.
- `node --check benchmarks/api/drawer-queries.mjs` and
  `node --check benchmarks/api/drawer-query-variants.mjs`: passed.
- Confirmed no `kanera_drawer_*` databases remained after the runs.
- `pnpm lint`: passed, zero errors and 38 existing web warnings; log: `benchmarks/api/results/drawer-queries-lint.log`.

Only four benchmark/report files were added. Existing unrelated working-tree changes were retained.

## Implementation boundaries

The SQL variants are deliberately confined to `drawer-query-variants.mjs`. Before shipping them:

- Port the activity UNION into the existing Drizzle query, retaining the board filter, hidden/comment
  exclusions, cursor, creation-entry priority, and UUID tie-break. Bound each arm before the final
  union/order/limit. Use `UNION`, not `UNION ALL`: historical rows can match both arms.
- The notification EXISTS prototype applies only when card columns are used solely for visibility.
  Notification text search and hydration still need their card joins. Keep the null-card case,
  archived-card exclusion, and overdue/completion rules. Use negative existence checks for archived/completed cards: these also preserve the original
  left-join behavior when a notification has no card.
- Keep every existing organization, board-membership, suspension and assigned-items-only access
  predicate. A fast owner benchmark does not establish guest/security equivalence.
- If an ordering index is shipped, update the shared schema and generate a new migration. Evaluate
  replacing the existing `(user_id, created_at)` index rather than retaining both indefinitely.
  Measure write overhead before deciding; this experiment measures index size, not insert throughput.
- Do not globally disable JIT from these figures alone. The experiment shows compilation overhead
  on these OLTP reads; other workloads can benefit from JIT.

No production changes were made, so UI screenshots, realtime E2E tests, schema migration tests,
and application regression tests are not claimed by this investigation.
