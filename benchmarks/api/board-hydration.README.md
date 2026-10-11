# Board hydration and event-loop experiments

This opt-in harness evaluates the cost of opening the 3,000-card performance board. It changes
temporary source copies and intercepted SQL only. It does not change the application's hydration
contract or enable pagination in the web client.

## Run and isolation

Start the local development Postgres and Valkey services, install repository dependencies, and run
from the repository root:

```bash
HYDRATION_OUTPUT=/tmp/kanera-board-hydration node benchmarks/api/board-hydration.mjs
```

The harness creates a fresh `kanera_hydration_<pid>` database in the local `kanera-postgres`
container, migrates it, seeds exactly 3,000 primary-board cards, six workspaces and 40 members, and
runs `ANALYZE`. Existing development database contents are not replaced. API processes listen on
loopback ports 3100–3101; measurement controls use 3198–3199. These ports must be free. Valkey uses
the local service on port 6379, database 15. No production connector or remote API is used.

The APIs use production Node mode with self-hosted product behavior, test environment settings,
local-only benchmark secrets, a configurable Postgres `work_mem` (4 MiB by default), and an
aggregate connection-pool limit of 20. The two-process experiment gives each process a pool of 10, keeping total pool capacity equal
to the single-process experiment. The runner stops its API processes and removes the temporary
database and source copies when it finishes or throws a handled error. A hard process kill may
require cleanup of those named resources.

Use a separate output directory for each run. Useful controls are:

```bash
HYDRATION_ROUNDS=3 HYDRATION_DURATION_MS=5000 \
  HYDRATION_OUTPUT=/tmp/kanera-board-hydration-repeat \
  node benchmarks/api/board-hydration.mjs

HYDRATION_ONLY=baseline-full-1,json-arrays-full-1,baseline-all-pages100-1 \
  HYDRATION_OUTPUT=/tmp/kanera-board-hydration-selected \
  node benchmarks/api/board-hydration.mjs

HYDRATION_WORK_MEM_MB=16 \
  HYDRATION_ONLY=baseline-full-1,json-arrays-full-1,sql-absent-combined-full-1,sql-all-json-rows-full-1,sql-absent-json-rows-full-1 \
  HYDRATION_OUTPUT=/tmp/kanera-board-hydration-16mb \
  node benchmarks/api/board-hydration.mjs
```

`HYDRATION_WORK_MEM_MB` accepts 4, 16 or 64. The default preserves comparison with the previous
4 MiB experiment; checked-in Compose defaults to 16 MiB. Confirm a winning candidate under the
intended deployment setting rather than attributing sort-spill effects to its JSON transformation.

`HYDRATION_ONLY` selects exact `<variant>-<scenario>-<replicas>` identifiers. By default round 0
runs at one concurrent logical operation; rounds 1–3 use 25. `HYDRATION_DURATION_MS` controls those
25-operation rounds. The runner reverses experiment order on alternating rounds and warms each
fresh API process before resetting its measurements.

`HYDRATION_PREPARE_ONLY=1` pauses after saving the baseline payload, retaining the isolated database
for companion benchmarks. Create `<output>/continue` to resume. Run companion CPU benchmarks
during this pause, not concurrently with API load measurements.

`HYDRATION_PLANS=1` collects three alternating, read-only `EXPLAIN (ANALYZE, BUFFERS)` runs for
every SQL variant at 4 and 16 MiB after HTTP timing finishes. It requires `baseline-full-1` in
the selected experiments to capture the current parameterized query. SQL execution time and
temporary blocks are saved in `plans.json`; these are database measurements, not API CPU.

Summarize the default three measured rounds with:

```bash
node benchmarks/api/board-hydration-summary.mjs /tmp/kanera-board-hydration
```

The summary reports medians of per-run measurements, including CPU and event-loop active time
per complete operation. It checks that every selected experiment has three measured runs.

## Experiments

The P1 implementation makes JSON identifier arrays part of the checked-in baseline. Compare
`HYDRATION_ONLY=pg-arrays-full-1,baseline-full-1` to measure this change alone. `baseline` is
always the current product query; older saved reports predate this change. Other variants now
measure incremental changes on top of JSON identifier arrays.

| Variant | Change being measured |
| --- | --- |
| `baseline` | Checked-in summary query and board mapping. |
| `pg-arrays` | Restore the old PostgreSQL UUID-array transport for label and assignee IDs as a before-change control. |
| `sql-compact` | Strip null custom-field properties inside Postgres before driver decoding. |
| `sql-absent` | Construct custom-field JSON with `ABSENT ON NULL`, avoiding a second JSON walk; requires Postgres 16 or later. |
| `json-arrays` | Aggregate label and assignee IDs as JSON arrays, preserving ordering; now identical to `baseline`. Retained for historical SQL captures. |
| `sql-combined` | `sql-compact` plus `json-arrays`. |
| `lean-cover` | Omit unused cover file-key and MIME columns from the summary query. |
| `sql-all` | `sql-combined` plus `lean-cover`. |
| `sql-absent-combined` | `sql-absent`, `json-arrays` and `lean-cover`. |
| `json-rows` | Return summary rows inside one JSON envelope, then restore the application's row shape. |
| `sql-all-json-rows` | `sql-all` plus the JSON row envelope. |
| `sql-absent-json-rows` | `sql-absent-combined` plus the JSON row envelope. |
| `yield100` | Yield between each batch of 100 summary transformations; the complete response is still returned. |

These SQL variants affect only the known board-card summary query. Expected SQL fragments are
asserted so query drift fails the run instead of silently measuring an unchanged variant. JSON row
variants preserve textual timestamps and numeric positions; globally changing driver type parsers
would affect unrelated endpoints and is outside this experiment. The native `ABSENT ON NULL`
constructor is documented in [PostgreSQL 16 JSON functions](https://www.postgresql.org/docs/16/functions-json.html);
this repository uses PostgreSQL 18.6.

Every SQL/mapping variant runs the `full` scenario. The baseline also runs these scenarios:

| Scenario | One measured logical operation |
| --- | --- |
| `full` | One request returning all 3,000 cards and metadata. |
| `metadata` | One `includeCards=false` request. No cards are returned. |
| `page100` | One request returning the first 100 cards and metadata. |
| `all-pages100` | A sequential walk of all 30 pages, including repeated metadata and request overhead. |

The two-replica baseline distributes full-board requests across separate API processes. This is a
local direct-client experiment, not a deployment/load-balancer benchmark.

Metadata-only and the first 100 cards represent smaller work. Their latency and throughput must not
be presented as a speedup for the complete current board experience. `all-pages100` supplies the
equivalent complete card set, and its reported operation includes all 30 requests and their bytes.
Walks finish after the sampling deadline if necessary; throughput uses actual elapsed time. The
page experiment uses the existing offset API against a stable fixture and does not prove cursor
correctness while cards are created, reordered or removed.

## Correctness and measurement

Before load generation, the harness compares each complete transformed HTTP payload with a saved
baseline using deep equality, including nested values, types and array order. It checks the first
100 cards and page flags against the baseline, metadata against the baseline without `cards`, and
the complete concatenated page walk against the original 3,000-card array. Any HTTP error, response
mismatch or query rewrite failure aborts the run. Fixture covers use deterministic public URLs;
private-media signing behavior is not represented by this fixture.

The constant-only SQL verifier is standalone and reads the current checked-in summary SQL
template, not a previous benchmark result. It checks null omission, false/zero/empty values,
Unicode, high-precision numeric strings, timestamp/date formatting, array null elements, UUID
ordering and empty results using a read-only local PostgreSQL connection:

```bash
HYDRATION_OUTPUT=/tmp/kanera-board-hydration \
  node benchmarks/api/board-hydration-query-verify.mjs

HYDRATION_OUTPUT=/tmp/kanera-board-hydration \
  node benchmarks/api/board-hydration-cpu-summary.mjs
```

The second command summarizes the completed run's `baseline-full-1-r0.json.cpuprofile`; an explicit
profile path may be passed as its first argument. The summary separates profiler control overhead
and idle time from active-work percentages. Categories are sample-stack estimates, not separately
instrumented timings; native JSON work can be attributed to its JavaScript caller.

A separate Node process generates requests and consumes response bytes without parsing the timed
responses. API CPU and event-loop measurements therefore exclude client JSON parsing and UI
hydration. The results include client CPU so a saturated generator can be identified. Measurements
include complete response consumption, logical operations and requests, total uncompressed bytes,
latency percentiles, API CPU milliseconds per completed operation, process RSS, event-loop
utilization and delay, and the latency of small `/health` requests during load.

Event-loop utilization alone is not an optimization score: a busy server can complete more useful
work at the same utilization. Compare CPU/operation, complete-board throughput, request tail
latency and event-loop delay together. Summed API CPU is not database CPU; moving work to Postgres
must also be assessed with SQL execution time and database capacity. `/health` probes wait 50 ms
after each response and are a responsiveness indicator, not an independent fixed-rate traffic mix.

Round 0 is diagnostic. Its one-process full baseline has the CPU profiler enabled; other round-0
candidates do not. Exclude that profiled row from performance comparisons. The unprofiled
25-concurrent-operation rounds are the primary comparisons. Retain individual rounds and compare
their spread instead of treating one short run as a stable latency bound. Short runs, warm database
caches, a local network, one fixture, and development Valkey/Postgres services limit generalization.

Outputs include the raw baseline payload, environment and fixture metadata, process and seed logs,
per-experiment JSON measurements, and the diagnostic CPU profile. The environment records the Git
revision and working-tree status. Keep the matching working-tree patch alongside results when
benchmarking uncommitted source changes; temporary application source copies are removed.

This harness does not mount Angular, measure browser rendering, or establish functional E2E
coverage. Use the [web benchmark](../web/README.md) for real browser startup, interaction and memory
measurements. Do not run it simultaneously with these CPU comparisons.

## What the web client needs from initial hydration

The current payload already excludes description bodies, comments, attachment rows and checklist
bodies. `CompactCardSummary` omits defaults and null fields; `BoardPage.loadBoard` expands them
before passing them to `BoardState`. Tiles use title/key, list/order, due/completion state,
description/count badges, labels, assignees, cover geometry and shown custom-field values.
`updatedAt` drives inactivity; `createdAt` is available in table columns. Detail-only data is fetched
when the drawer or inline checklist opens.

The board initially mounts up to eight lists and 15 cards per list, then grows the DOM as the user
scrolls. It nevertheless loads all matching card summaries. A global first-100 page can concentrate
cards in one lane; it is not the same work as the current multi-lane first viewport. An alternative
first-viewport protocol should measure per-lane slices plus accurate lane counts.

Full collections currently support local search, filters, overview counts, grouping, sorting,
range/select-all actions, export and offline snapshots. Hidden custom-field values are omitted
from the first response but fetched immediately after hydration so changing views works offline.
Further delaying them changes when that offline guarantee becomes available.

Lossless alternatives worth comparing before changing behavior include hoisting repeated board,
workspace and organization identity into a board-response envelope, and omitting a nested
custom-field row's repeated parent `cardId`. Decoding must restore the current summary contract.
Dictionary or tuple encodings can reduce bytes further but add transformation and schema-evolution
costs: compare server construction, serialization, client parsing and expansion together. The
generic compact summary is also used by cross-board Global Work, so a board-specific envelope
must not assume that every compact-summary collection shares one board or workspace.

Safe incremental hydration requires all of the following before a product rollout:

- A per-lane ordering/paging contract and accurate counts, with deterministic behavior under
  concurrent create, delete, move and rebalance operations.
- Full-set search/filter/sort/group/bulk/export semantics, either on the server or after guaranteed
  complete loading; a match outside loaded pages must not silently disappear.
- Explicit partial versus complete offline snapshots and a drawer/deep-link path for unloaded
  cards. Existing cached authorization rejection must still clear every local copy.
- Page merging, deletion tombstones and stale-response guards that preserve recent confirmed
  creations, realtime edits and open detail state. `BoardState.hydrate` currently replaces its card
  set and treats omitted cards as absent.
- Realtime handling for unloaded cards. `BoardSocketBridge` currently requests resynchronization
  for unknown moved, deleted, rebalanced or custom-field cards; retaining that rule with partial
  hydration can create repeated full refreshes.
- Reconnect and visibility reconciliation that restores loaded depth without overlapping whole
  page walks, dropping rows, or applying older responses after newer edits. Assigned-only guest
  visibility and revocation must apply to every page and cache.

Relevant implementations are `apps/web/src/app/features/board/board.page.ts`, `board-state.ts`,
`board-socket-bridge.ts`, `list.component.ts`, `card.component.ts`, and
`table-view/board-table-view.component.ts`; the wire contracts are in
`packages/shared/src/events/index.ts`.

## Functional verification before adopting a candidate

The benchmark's equality assertions are evidence about the fixed fixture, not a claim that these
E2Es were run. Preserve existing focused checks and use the isolated E2E runner for a product
change:

```bash
pnpm test:e2e -- board.spec.ts reconnect.spec.ts live-card-edits.spec.ts \
  shared-fields.spec.ts guest-access.spec.ts angular-state-races.spec.ts \
  board-overview.spec.ts drag-and-drop.spec.ts lane-insert.spec.ts
```

For pagination, add coverage that places search/filter matches, selected cards and a deep-linked
drawer on the final page; checks overview and export against the complete set; injects realtime
create/move/delete/custom-field changes while page requests are held; disconnects and reconnects
after loading more pages; rejects stale navigation responses; and exercises offline partial versus
complete caches and guest access revocation. Assert exact persisted and rendered data, not a
machine-dependent timing threshold. Include desktop and phone screenshots. Record caught failures
in `e2e/COVERAGE.md` and report the runner's `e2e/artifacts/<run>/` path and reproduction command.
