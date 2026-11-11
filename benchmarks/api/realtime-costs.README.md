# Valkey and outbox efficiency investigation — 2026-11-11

Historical investigation of the pre-change code. See [implemented changes and verification](implemented-performance.README.md)
for the current implementation, updated measurements, and reproducible before/after runner.

The architecture already has useful safeguards and batching. The strongest opportunities found are
**reuse of bounded bulk publication on filtered-audience paths**, **constant-work presence updates**,
and **sharing PostgreSQL LISTEN connections**. Combining outbox claim commands helps less.
These are benchmark prototypes and code-review findings; no application behavior was changed.

## Already efficient

- The worker owns the event/direct outbox dispatchers and mirror scheduler; API replicas do not each
  start those pollers (`worker-server.ts`, `server.ts`). This is the current code, even though the
  high-level API AGENTS description still attributes event-outbox draining to the app process.
- Claims use FIFO `(created_at, id)` partial indexes, `FOR UPDATE SKIP LOCKED`, 30-second leases,
  and batches of 50. Completed history is excluded from the pending indexes.
- Dispatch is single-flight. Full batches continue immediately, while NOTIFY wakes otherwise-idle
  dispatchers and a one-second poll provides a fallback. Increasing polling frequency is not the
  promising optimization here.
- Webhook/MCP subscription discovery is batched per drain, including empty results. Final completion
  updates are batched. Normal multi-recipient notification publication already batches 100 rows.
- Valkey connections are reused; Pub/Sub has its own connection pair. Presence transitions are
  atomic Lua operations. Card broadcasts have compact representations, and WebSocket compression
  is configured to avoid spending compression CPU on small messages.

## 1. Reuse bulk publication for filtered audiences

`emitFilteredUserPayloads` in `apps/api/src/realtime/emit.ts` builds one
`publishDirectRealtimeEvent` promise per recipient. Each io-less publication writes one row and
issues its own NOTIFY. `publishUserRealtimeEvents` already performs bounded 100-row inserts and
one notification per chunk, and is used by `emitToUsersDurable` elsewhere.

A serial SQL experiment, with one connection and the same number of durable recipient rows:

| Recipients | Individual INSERT/NOTIFY p50 / p95 | Batches of 100 p50 / p95 | Commands |
|---|---:|---:|---:|
| 10 | 62.93 / 72.92 ms | 6.00 / 9.37 ms | 20 → 2 |
| 100 | 644.37 / 721.16 ms | 8.41 / 9.31 ms | 200 → 2 |
| 1,000 | 6,208.24 / 6,504.64 ms | 77.41 / 81.47 ms | 2,000 → 20 |

**These are serial database-work timings, not measured current HTTP latency.** The existing filtered
path issues promises together; the experiment deliberately serializes both variants to measure
work without gaining speed from more connections. The tables are schema/index clones without FKs,
with synthetic recipients and small JSON payloads. Real recipient validation and payload costs are
not included. Local durable-commit costs strongly influence the absolute values.

The useful result is the reduction in statements, commits and returned row data while keeping one
outbox row per recipient. Reuse the existing bulk helper here, preserving recipient-specific
payloads and the separate board/workspace webhook row. Do not broadcast a personalized notification
row to a shared audience. Other user-audience loops should be audited for the same existing helper.

Raw results: [publication.json](results/realtime-costs-final/publication.json).

## 2. Presence updates currently scale with every socket in a workspace

Both `MARK_ONLINE_SCRIPT` and `MARK_OFFLINE_SCRIPT` in `realtime/presence.ts` execute `HVALS` over
the workspace's socket hash to decide whether a user crossed online/offline. That scans and allocates
all entries inside an atomic Lua command. More sockets therefore make each join/leave consume more
of the shared Valkey process.

The prototype adds a user→socket-count hash, maintained in the same atomic scripts. It also moves
the extra server-registry SADD into the join script. No request parallelism is added.

| Sockets in one workspace | Current join+leave p50 / p95 | Counter prototype p50 / p95 |
|---|---:|---:|
| 10 | 0.149 / 0.247 ms | 0.108 / 0.164 ms |
| 1,000 | 0.387 / 0.553 ms | 0.110 / 0.179 ms |
| 10,000 | 3.223 / 4.058 ms | 0.094 / 0.194 ms |

Valkey `INFO CPU` deltas also show reduced server work: median CPU per cycle was
**0.267 → 0.033 ms** at 1,000 sockets (about 88% lower), and **3.082 → 0.031 ms** at
10,000 sockets (about 99% lower). These are process user+system CPU deltas over 100-cycle batches,
not just improvements in client waiting time.

This measures a new user's first socket joining, then its last socket leaving, with two sockets per
seeded existing user. Ordinary small workspaces have little absolute time to save; busy workspaces
and reconnect bursts are where removing the scan matters.

The separate EVALSHA-only variant stayed near the current implementation: **3.139 ms** versus
**3.223 ms** at 10,000 sockets. Script caching alone does not remove the expensive scan.

Nine transition checks matched the existing scripts, including duplicate joins, multiple tabs,
stale/mismatched disconnects, socket replacement, and repeated disconnects. This is not yet a
production-ready replacement: all disconnect, close and dead-server reaper paths must maintain the
counter, and existing presence state needs a rolling-deployment/migration strategy. The extra hash
also costs memory. Cross-process crash/reaper correctness still requires E2E validation before use.

Raw samples, exact source/prototype Lua, and CPU snapshots:
[presence.json](results/realtime-costs-final/presence.json), `presence-cpu-*.json` in the same directory.

## 3. Consolidate LISTEN connections without increasing query concurrency

This is a code-confirmed resource count, not a throughput benchmark:

- `startRealtimeOutboxDispatcher` reserves a pool connection for `kanera_event_outbox`.
- `startBoardMirrorScheduler` reserves another connection for that **same channel**.
- `startDirectRealtimeOutboxDispatcher` reserves a third for the direct channel.
- `startNotifyListener` holds each `pool.connect()` client until shutdown.
- Production Compose sets the worker's default `PG_POOL_MAX` to **5**.

Thus three long-lived listeners leave **two** slots for ordinary worker database work. One connection
can LISTEN on both channels and route notifications to all three callbacks. Sharing it saves two
PostgreSQL sessions. To preserve the existing two-query concurrency budget, combine that with an
explicit two-query pool plus one listener connection, or reduce the shared pool from five to three.
There is no need to turn the saved sessions into additional simultaneous work.

Implementation needs callback registration/release and reconnect handling while retaining the poll
fallback. No pool size, listener, or environment setting was changed by this investigation.

## 4. Combine claim and fetch into one SQL statement

Both outbox claim functions currently perform `BEGIN`, `UPDATE … RETURNING id`, a sorted `SELECT`,
and `COMMIT`. A writable CTE can return the claimed rows already sorted in one atomic command:
`WITH claimed AS (UPDATE … RETURNING *) SELECT * FROM claimed ORDER BY created_at, id`.
The FIFO predicate, SKIP LOCKED, lease and attempts updates stay unchanged.

| Claim workload | Current p50 / p95 | CTE p50 / p95 |
|---|---:|---:|
| Event outbox, 50 rows | 8.58 / 9.72 ms | 7.55 / 8.94 ms |
| Direct outbox, 50 rows | 7.72 / 9.18 ms | 7.39 / 8.22 ms |
| Empty event outbox | 0.402 / 0.531 ms | 0.381 / 0.488 ms |
| Empty direct outbox | 0.396 / 0.787 ms | 0.396 / 0.779 ms |

That removes three commands per non-empty claim (four → one), or two per empty claim (three → one),
but the measured gains are modest: approximately 12% and 4% for populated batches. Treat this as a
lower-priority simplification, not a dramatic dispatch-throughput improvement. Full returned rows,
attempt counts and FIFO order matched after excluding the deliberately changing lease/update times.

Do **not** indiscriminately remove the per-event realtime completion writes in `processEvent`.
They keep a later webhook-enqueue failure from rebroadcasting an already-dispatched event on retry.
The direct outbox and final completion writes are already batched. This benchmark did not alter
that retry behavior.

Raw results: [claims.json](results/realtime-costs-final/claims.json).

## Reproduce and limits

```bash
REALTIME_OUTPUT=benchmarks/api/results/realtime-costs-final \
  node benchmarks/api/realtime-costs.mjs
pnpm lint
```

The runner reuses the installed API dependencies and local Postgres container. It creates and drops
its own `kanera_realtime_<pid>` database and starts/removes a separate Valkey container on a random
loopback port, using the locally installed Valkey image. It does not touch the development Valkey
keyspace, publish to live Socket.IO rooms, or call production services. A forcibly killed runner may
leave its named test resources behind. Final harness copies and environment metadata are saved with
results; result files are gitignored.

- PostgreSQL 18.6, Valkey 9.1.3, Node 24.18.0 on a shared Ryzen 7 7840HS development machine.
- One DB connection, one Valkey command connection, sequential tests, and PostgreSQL parallel
  query workers disabled. The Valkey instance is dedicated to this benchmark.
- Each outbox clone starts with 100,000 processed rows and 500 pending rows, with 500-character
  payload content. Claims have six alternating batches × 20 samples/version/state. Resets occur
  outside timing. Tables are regular logged tables with copied indexes, not temporary/unlogged ones.
- Publication has six alternating batches × three samples/version/size. Cleanup is outside timing.
- Presence has six alternating batches × 100 join/leave cycles/version/size (600 samples each).
  CPU snapshots bracket each 100-cycle batch and include small measurement/maintenance overhead.
- These are component benchmarks, not HTTP latency, end-to-end event delivery, websocket fanout,
  worker throughput, crash recovery, or production concurrency measurements. No new realtime
  functionality was implemented, so no cross-process E2E pass is claimed.

Verification: both benchmark runs completed, parity/count assertions passed, and resources were
removed. `node --check benchmarks/api/realtime-costs.mjs` passed. `pnpm lint` passed with zero
errors and 38 existing web warnings; log: `results/realtime-costs-final/lint.log`.
