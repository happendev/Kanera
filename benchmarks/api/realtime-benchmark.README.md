# Socket.IO versus a custom WebSocket layer

Run from the repository root with the existing Node/pnpm dependencies installed and local Valkey
listening on `127.0.0.1:6379`:

```bash
PERF_PATHS=redis PERF_OUTPUT=benchmarks/api/results/realtime-comparison \
  node benchmarks/api/realtime-benchmark.mjs
```

The harness binds ephemeral loopback ports, uses a unique Valkey Pub/Sub namespace per trial, and
never accesses application databases, application channels, credentials, or production. It resolves
`ws` from the installed Engine.IO dependency so both candidates use the same WebSocket implementation;
there is no new dependency. This is an experiment, not a replacement transport for deployment.

## What is compared

- **Socket.IO:** installed server/client and Redis adapter, WebSocket-only transport, discarded initial
  HTTP request, 10 KB inbound limit, and Kanera's compression configuration.
- **Custom `ws`:** JSON `[event, payload]` protocol, encode once per local broadcast, indexed room sets,
  overlapping-room deduplication, join acknowledgement, disconnect cleanup, a basic ping/pong
  heartbeat, the same inbound limit/compression, and JSON over Valkey Pub/Sub for cross-process delivery.

The Redis path uses three Node processes: publisher, socket gateway, and load generator/clients. The
Socket.IO publisher is a broadcast-only `Server`, like Kanera's worker. The local path omits Valkey
and the publisher process to isolate local transport overhead. Kanera itself always configures its
Redis adapter; the local path is an attribution experiment, not its complete deployed configuration.

Clients join five rooms each. Every measured event targets two overlapping rooms; each recipient
must receive it exactly once. Distinct room groups must not receive each other's events. The fixtures
approximate `CompactWireCard`, card moves, presence changes, and full note updates in the shared event
contracts. The mix is synthetic (40% card updates, 30% moves, 20% presence, 10% notes), not production
telemetry. Notes contain about 8 KB of deliberately compressible text. Each room sees the whole mix.

| Profile | Connected clients | Rooms | Published events/s | Deliveries/s |
| --- | ---: | ---: | ---: | ---: |
| collaboration | 100 | 10 | 100 | 1,000 |
| busy | 500 | 10 | 1,000 | 50,000 |
| hot-room | 500 | 1 | 200 | 100,000 |

Each trial uses fresh processes and connections, one second of warmup (fully drained before
measurement), and four seconds of fixed-rate publishing. Both compression settings get three trials,
with candidate order reversed in the second trial. These are offered-load measurements, not a search
for maximum sustainable throughput. Queues may grow under load; reported elapsed time includes drain.
Any missing, duplicated, out-of-order, misrouted event, early disconnect, or missing end marker fails
the trial. A failure is not silently included as a fast result.

## Measurements

- Latency is publisher-to-client-handler time using the host's monotonic clock, including serialization,
  Valkey, compression, transport, and client decode; it excludes timer scheduling before publication.
- CPU is the sum of publisher and gateway process user/system time. It includes compression worker
  threads, excludes the Valkey daemon, and is separate from load-generator/client CPU.
- Connected heap/RSS deltas are measured after forced GC against the ready server baseline. They are
  approximate allocations per connection, not a capacity guarantee. Post-load process memory is also saved.
- Gateway TCP bytes written include WebSocket framing and control traffic, exclude TCP/IP/TLS overhead,
  and are divided by received application deliveries. Benchmark timing metadata is included. Fixture
  JSON sizes without that metadata are recorded separately in `environment.json`.
- Connection timing includes local connect and acknowledged room setup in batches of 50. Neither
  candidate executes Kanera JWT/database authorization, so this is not application sign-in timing.
- The gateway's event-loop p99 and client CPU help identify an overloaded generator or compressor.

`results.json` contains individual runs, not just averages. `environment.json` records installed
versions, host CPU, runtime, and fixture sizes. Results live under the repository's ignored benchmark
results directory.

Controls: `PERF_REPEATS`, `PERF_DURATION_MS`, `PERF_PROFILES=collaboration,busy,hot-room`,
`PERF_PATHS=local,redis`, `PERF_COMPRESSION=on,off`, `PERF_TRANSPORTS=socket.io,ws`, and `PERF_OUTPUT`.

An additional experiment explicitly disables compression on application packets below 1024 bytes,
retaining compression/context takeover for larger notes. Run it separately to avoid competing load:

```bash
PERF_PATHS=redis PERF_PROFILES=busy PERF_COMPRESSION=on PERF_TRANSPORTS=socket.io \
  PERF_SELECTIVE_COMPRESSION=1 PERF_OUTPUT=benchmarks/api/results/realtime-selective \
  node benchmarks/api/realtime-benchmark.mjs
```

This measures a possible Socket.IO tuning change, including the cost of checking serialized size,
without applying that change to the app. Compare its bandwidth as well as CPU/latency. On the tested
Engine.IO 6.6.9, this flag did **not** change compression: its WebSocket `_doSend`/`_doSendLast` call
`socket.send(data, callback)` without forwarding the packet's compression option. A successful call
to `.compress(false)` therefore does not establish that a packet was sent uncompressed.

To test the effective `ws` threshold through negotiation instead:

```bash
PERF_PATHS=redis PERF_PROFILES=busy PERF_COMPRESSION=on PERF_TRANSPORTS=socket.io \
  PERF_NO_CONTEXT_TAKEOVER=1 PERF_OUTPUT=benchmarks/api/results/realtime-threshold \
  node benchmarks/api/realtime-benchmark.mjs
```

This sets `serverNoContextTakeover: true` beside `threshold: 1024`. Small packets skip compression;
large packets are compressed independently. This trades dictionary reuse and bandwidth for reduced
CPU/queueing; it must be evaluated against actual payloads and network limits before deployment.

## Limits and replacement work

This isolates a candidate transport's costs. It does not measure HTTP mutations, PostgreSQL writes,
outbox wakeups/leases, webhook delivery, database access checks, presence storage, Angular rendering,
mobile battery, WAN/TLS, reconnect storms, slow consumers, node failure, or long-lived memory growth.
Short runs with a basic raw heartbeat do not establish heartbeat or reconnect parity. Only one gateway
is tested; the raw prototype's single channel is not an optimized multi-gateway subscription design. Both transports
share the load-generator host; high-fanout results are not independent production capacity numbers.

A production replacement must preserve the authorization and fanout rules in
`apps/api/src/realtime/io.ts`, `broadcast.ts`, `outbox.ts`, and the reconnect/resubscription behavior in
`apps/web/src/app/core/realtime/socket.service.ts`. In particular:

- Authorize active organisation, workspace and board grants; preserve assigned-items-only filtering,
  private user rooms, support-session revocation, and cross-process user eviction.
- Preserve rebalance-before-move ordering and deduplicate overlapping authorized rooms.
- Retain durable outbox dispatch and webhook semantics; Pub/Sub alone is not durable replay.
- Implement token refresh, reconnect backoff/jitter, room acknowledgements, PWA sleep/resume handling,
  presence lifecycle, heartbeat timeouts, and bounded slow-client queues.
- Replace Redis adapter socket-management operations, and test cross-process revocation/failure paths.
- Validate deployment upgrades, protocol compatibility, and the existing browser consumers with E2E.

Socket.IO already pre-encodes local broadcasts. A shorter JSON envelope removes just the `42` prefix
for the events used here, before compression; this is not a large bandwidth optimization. The installed
`ws` sender applies its deflate threshold only with the relevant no-context-takeover parameter. Both
candidates use Kanera's existing context-takeover configuration, so small packets can be compressed
despite the configured 1024-byte threshold. Changing that policy is a separate experiment.

Do not translate a transport CPU reduction into the same percentage improvement in Kanera request
latency. First measure how much production time/CPU is actually spent in this layer. For a fraction
`f` of total cost and measured transport speedup `s`, an optimistic overall speedup is
`1 / ((1 - f) + f / s)`; real replacement features reduce the prototype's advantage.

Primary references: [Socket.IO performance tuning](https://socket.io/docs/v4/performance-tuning/),
[Redis adapter](https://socket.io/docs/v4/redis-adapter/), and
[delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).

## Measured snapshot: 12 October 2026

Recommendation: keep Socket.IO for now and investigate compression policy before committing to a
custom transport. The lean prototype saves CPU and connection heap, but the default-compression
stress cases remain overloaded with either transport. These results do not establish that Socket.IO
is a meaningful bottleneck in ordinary Kanera interactions.

Environment: Kanera commit `12f9f9f2ae76f4a3f687ebbcfa79ed07ad44757e`, Node 24.18.0,
Socket.IO/client 4.8.4, Engine.IO 6.6.9, Redis adapter 8.3.0, `ws` 8.21.0,
Ryzen 7 7840HS (16 logical CPUs), Linux 7.2.8. Shared development host, loopback, no TLS or CPU pinning.
Date is Asia/Calcutta; raw timestamps are UTC. App code and dependencies were unchanged.

All tables below are medians of three trials per configuration, using the Redis path. The latency
column is the median of trial p95s, not a pooled percentile. CPU reduction compares aggregate
publisher+gateway CPU for the same number of delivered events, including queue drain.

| Offered deliveries/s | Compression | Socket.IO p95 ms | Custom `ws` p95 ms | Custom server CPU reduction |
| ---: | --- | ---: | ---: | ---: |
| 1,000 | pre-tuning default | 1.97 | 1.70 | 26.6% |
| 50,000 | pre-tuning default | 1,643.66 | 530.20 | 15.5% |
| 100,000 | pre-tuning default | 6,209.56 | 4,618.20 | 5.1% |
| 1,000 | disabled | 1.46 | 1.14 | 31.5% |
| 50,000 | disabled | 2.48 | 1.98 | 27.7% |
| 100,000 | disabled | 15.56 | 8.44 | 24.6% |

At 50,000 deliveries/s with default compression, trial p95 ranges were 1,602–1,655 ms for Socket.IO
and 456–652 ms for `ws`. Four seconds of publishing took a median 5.36/4.36 seconds respectively
to deliver and drain (see raw results for each trial). These are overloaded offered-load tests,
not sustainable-throughput claims. Both server and Node client compression work contribute.

At 100 connected clients/default compression, measured incremental heap was 20.3 KiB/client for
Socket.IO versus 13.6 KiB for the prototype. At 500 clients it was about 10.2 versus 5.9 KiB/client.
The different ratios reflect fixed costs and GC behavior; do not linearly extrapolate them to an
untested connection count or treat them as total app process memory.

The uncompressed protocol saving was approximately two bytes per event, as expected from removing
the `42` prefix. With default compression both candidates used about 32 bytes/delivery in the busy
fixture; there was no meaningful bandwidth improvement from the custom envelope.

### A smaller Socket.IO tuning experiment

Same 500 clients, 50,000 offered deliveries/s, and four-second publishing window:

| Socket.IO configuration | p95 ms | Publisher + gateway CPU ms | Wire bytes/delivery |
| --- | ---: | ---: | ---: |
| Existing compression defaults | 1,643.66 | 8,649 | 32.3 |
| `.compress(size >= 1024)` | 1,532.00 | 8,629 | 32.3 |
| `serverNoContextTakeover: true`, threshold 1024 | 14.63 | 4,342 | 472.2 |
| Compression disabled | 2.48 | 2,129 | 1,209.5 |

Negotiating no server context takeover made the configured threshold effective: p95 fell roughly
112-fold and server CPU roughly halved, at about 14.6 times the default compressed wire traffic.
It still used about 61% fewer wire bytes than disabling compression completely. This suggests a
useful experiment on representative production traffic, not an unconditional recommendation to
disable compression or change the transport. The per-message flag experiment was ineffective in the
installed Engine.IO send path, as described above.

### Artifacts and verification

- `benchmarks/api/results/realtime-20261012-final/{environment,results,summary}.json`: 36 baseline
  trials, 7,248,000 measured deliveries.
- `benchmarks/api/results/realtime-20261012-selective/{environment,results}.json`: three per-message
  compression-flag trials, 600,000 measured deliveries.
- `benchmarks/api/results/realtime-20261012-threshold/{environment,results}.json`: three effective
  threshold trials, 600,000 measured deliveries.
- Across all 42 completed comparison trials: 8,448,000 measured deliveries, zero missing, duplicate,
  out-of-order, or misrouted events and no unexpected disconnects. Warmup deliveries are additional.
- Commands are the three examples above, with `PERF_OUTPUT` set to the dated directories. The baseline
  used `PERF_PATHS=redis`; all other baseline controls were defaults.
- `pnpm lint` passed, including type checks, E2E typechecking/lint, and knip, with existing warnings
  in unchanged application files. `node --check benchmarks/api/realtime-benchmark.mjs` passed.
  No app UI or realtime behavior changed;
  browser screenshots and app E2E were not run. This harness checks its own transport semantics and
  is not a substitute for E2E coverage before a production replacement.

## Applied tuning follow-up

The initial tuning used `serverNoContextTakeover: true` and `zlibDeflateOptions: { level: 1 }`
with the existing enabled flag and configurable 1024-byte threshold. These settings are retained
for opt-in compression; the subsequent seed-based decision below disables compression by default.
No dependencies or transport protocol changed. The measurements above describe the configuration
**before** these changes.

Fast deflate was measured separately before adoption using:

```bash
PERF_PATHS=redis PERF_PROFILES=busy PERF_COMPRESSION=on PERF_TRANSPORTS=socket.io \
  PERF_NO_CONTEXT_TAKEOVER=1 PERF_DEFLATE_LEVEL=1 \
  PERF_OUTPUT=benchmarks/api/results/realtime-20261012-level1 \
  node benchmarks/api/realtime-benchmark.mjs
```

Three trials, 200,000 measured deliveries each, gave median p95 **14.54 ms**, aggregate server CPU
**3,641 ms**, and **473.6 bytes/delivery**. Compared with independent compression at the default zlib
level, level 1 saved another **16.2% CPU** for **0.3% more bytes**. Compared with the original settings,
this was **57.9% less server CPU** and about **113 times lower p95**, with **14.7 times more wire bytes**
on this compressible synthetic workload. Payload mix and network constraints remain material.

`PERF_DEFLATE_LEVEL` is a benchmark-only control. Production fixes level 1 to avoid extra deployment
configuration; the existing enable/threshold variables retain their documented defaults. Use
`PERF_NO_CONTEXT_TAKEOVER=1 PERF_DEFLATE_LEVEL=1` to reproduce the application's opt-in compression
configuration in this harness; its bare defaults intentionally preserve the original comparison.

The `realtime-compression` E2E test was first run against the old app and failed at the expected
`server_no_context_takeover` negotiation assertion. It observes Chromium's native socket and verifies
full, ordered small/large card updates from the separate public API process. See `e2e/COVERAGE.md`
for functional coverage and each E2E run's `REPRODUCE.txt` for its exact command and source snapshot.

Follow-up verification:

- `pnpm lint` passed (647 existing warnings in unchanged files); `pnpm lint:e2e` passed again after
  correcting the new test's cleanup to accept successful empty DELETE responses.
- `pnpm test:e2e -- realtime-compression reconnect guest-access live-card-edits card-follow`:
  eight existing tests passed. The new test passed its functional assertions but failed while
  parsing an empty cleanup response as JSON; that test-only issue was corrected.
  Artifacts: `e2e/artifacts/20261011T203735Z-4063058/`.
- `pnpm test:e2e -- realtime-compression`: passed, including cleanup.
  Artifacts: `e2e/artifacts/20261011T204032Z-4073304/` (native negotiation evidence, decoded messages,
  browser screenshot, trace, and service logs).
- The expected pre-fix regression failure is retained at
  `e2e/artifacts/20261011T203613Z-4058324/`.
- No full E2E suite was run. The focused cases cover compression negotiation, mixed-size delivery,
  public-API and worker fanout, user notifications, guest revocation, live edits, and reconnect.

## Seed-based default decision

After reviewing the representative seed content, compression is **disabled by default** in the API,
Compose, and deployment examples. The earlier repeated 8 KB note fixture is a useful stress case,
but overstates the size of typical seeded content. Opt-in compression retains the tuning above.

Reproduce the read-only content analysis:

```bash
node benchmarks/api/realtime-seed-sizes.mjs
```

The script evaluates only the pure `buildWorkspaceSeeds()` functions with the shared template
constants; it does not import the seeder, run database writes, or read credentials. It covers 10 boards
in the three main workspaces, including nested notes (not standalone/guest boards or scratchpads).
It uses the actual `compactWireCard` function and representative UUID/date/entity metadata to estimate
full event sizes. Expanded signed media URLs and the seeder's later internal-link additions are
excluded; event sizes are estimates, while the builder text sizes are exact. Attachment binaries
are fetched separately and are not included as binary data in these card/note updates.

| Seed content | Count | Median bytes | p95 bytes | Maximum bytes |
| --- | ---: | ---: | ---: | ---: |
| Card description text | 167 | 139 | 232 | 427 |
| Note body text | 26 | 563 | 1,102 | 1,427 |
| Comment body text | 71 | 113 | 153 | 163 |
| Modeled full `card:updated` event | 167 | 756 | 948 | 1,136 |
| Modeled full `note:updated` event | 26 | 1,254 | 1,805 | 2,127 |

Only two modeled card events cross the former 1 KiB threshold. Typical notes save hundreds of bytes,
not the many kilobytes of the stress fixture. This supports avoiding zlib work/queues as the default;
it does not establish real event frequencies or promise noticeable speedups for ordinary users.
Bandwidth-constrained deployments with substantially larger updates can still set
`REALTIME_WEBSOCKET_COMPRESSION_ENABLED=true`. Existing explicit `true` configurations remain enabled
until changed and the app API restarted/recreated. HTTP gzip is independent of this setting.

Results: `benchmarks/api/results/realtime-seed-20261012/summary.json`.
The benchmark's compression-off cases (`PERF_COMPRESSION=off`) now match the application's default.
The browser test checks the absent compression extension by default (after observing a real handshake)
and independent compression when explicitly enabled:

```bash
pnpm test:e2e -- realtime-compression reconnect
REALTIME_WEBSOCKET_COMPRESSION_ENABLED=true pnpm test:e2e -- realtime-compression
```

Default-off verification:

- `node benchmarks/api/realtime-seed-sizes.mjs`: passed; regenerated the size summary above.
- `pnpm --filter @kanera/api exec tsx --import ./src/test/setup.ts --test src/env.test.ts`:
  21 tests passed, including default-off and explicit true/false. Schema coverage is necessary because
  E2E pins the setting to prevent the API's dotenv loader from reading a developer's legacy opt-in.
- `pnpm lint`: passed with the same existing application warnings.
- `pnpm test:e2e -- realtime-compression reconnect`: two tests passed after isolating that override.
  Artifacts: `e2e/artifacts/20261011T205214Z-4101030/`.
- `REALTIME_WEBSOCKET_COMPRESSION_ENABLED=true pnpm test:e2e -- realtime-compression`: passed,
  confirming explicit opt-in still negotiates independent compression and delivers complete updates.
  Artifacts: `e2e/artifacts/20261011T205349Z-4107237/`.
- The disabled-default assertion rejected the prior enabled setting as intended. A subsequent run
  exposed the local root `.env` opt-in overriding the new default; the E2E service environment now
  pins the mode without editing that file. Those failures are retained in
  `e2e/artifacts/20261011T204821Z-4088579/` and `e2e/artifacts/20261011T204944Z-4093108/`.
