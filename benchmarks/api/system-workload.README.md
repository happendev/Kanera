# Global Work and background processing benchmark

This extends `mixed-workload.mjs` with fixed-work comparisons on disposable local databases. It
uses two app APIs, a public API, a worker, real Valkey and eight authenticated WebSocket observers.
Save the API source **before** making the change, then run from the repository root:

```bash
cp -a apps/api/src /tmp/kanera-system-before
# Apply the change being evaluated.
MIXED_WORKLOAD=system MIXED_SOURCE_BEFORE=/tmp/kanera-system-before MIXED_ROUNDS=3 \
  MIXED_OBSERVERS=8 MIXED_OUTPUT=/tmp/kanera-system-results \
  node benchmarks/api/mixed-workload.mjs
node benchmarks/api/system-workload-summary.mjs /tmp/kanera-system-results
```

Use fresh source/output directories. The before/after order alternates each round. Each variant
gets a clone of the same database template. Set `MIXED_SYSTEM_MEMBERS=200` and use a fresh output
directory for the larger fan-out case (default: 40 members; supported: 8–200). Source changes, harness files, image identities and
machine metadata are saved with the results. Follow the prerequisites and cleanup instructions in
`mixed-workload.README.md`. Extra loopback ports 3194/3195 serve SMTP and signed HTTP callbacks.
`MIXED_SYSTEM_FOCUS=1` runs only Global Work, fan-out and triggered automations.
`MIXED_SYSTEM_PAGE_SIZE=250` or `500` changes after-variant full-walk pages; before uses 100, and
both retain 100-card first-page requests. Exact all-card parity still applies. Focused summaries
report total requests, fixed-work CPU/bytes, event-loop delay and automation stage timings.
System phases use direct HTTP and their own fixed workload; `MIXED_READERS`, `MIXED_BOARD_RPS` and
`MIXED_DURATION_MS` do not control them. Do not run other tests/builds concurrently with measurements.

## Work and assertions

- **Global Work:** both My and Team Cards match 3,000 rich cards. Twenty first-page requests and two
  complete walks per lens (30 pages at 100 cards, 12 at 250, or 6 at 500). Verify no missing/duplicate cards and exact decoded card parity
  across versions, excluding only expiring media signature/expiry parameters. All table fields stay
  present. Both versions share the same fixture timestamps, identities and ordering.
- **Notifications:** 40 public-API comments at concurrency four fan out to 39 eligible recipients.
  Assert 1,560 persisted notifications and 280 distinct receipts across seven recipient observers;
  the eighth observer is the suppressed initiating account. With 200 members, the same 40 comments
  create 7,960 notifications. During background phases, My and Team readers each start at up to
  four requests/sec, a full-board reader at up to two/sec, and a health reader at up to one/sec. Record fanout wait/end-to-end time, CPU, SQL
  counts, event-loop delay, HTTP timings, and actual observer receipt timestamps.
- **Triggered automations:** twelve moves, four matching rules, two ordered comment actions each.
  Assert exactly 96 comments and the expected user-move notifications. System-authored automation
  comments deliberately do not notify watchers. Global Work reads continue during execution.
- **Competing jobs:** 25 overdue cards, two scheduled rules with two actions each, an overdue
  notification sweep, daily digest and retention sweeps, 100 SMTP emails, and 100 signed personal
  webhook notifications. Two workspace webhook destinations consume the automation comments. SMTP
  accepts after 100ms (500ms every tenth message); every thirteenth message fails its first attempt.
  HTTP destinations include a 300ms receiver that fails its first attempt. Scheduler triggers use
  the actual single-flight scheduler; production delivery, signing, leases and retry logic run.
- **Digest generation:** 40 UTC recipients each assigned the 25 overdue cards. Run at a controlled
  08:00 UTC, assert one queued digest per member and zero duplicates on a second sweep; compare
  every queued payload across versions, including exact dates/labels/items, then deliver all locally.
- **Retention:** delete 10,000 expired activity rows with 10,000 still-recent notifications in one
  inbox. Verify database deletion and the complete user-scoped deletion event during concurrent reads.
- **Recovery:** advance email/workspace-webhook retry eligibility only in the disposable database,
  rerun delivery, and assert every expected message is delivered, signatures match, no receiver
  accepts the same logical delivery twice, and both realtime outboxes drain.

## Interpretation and limits

This is a fixed-work local benchmark, not a production capacity claim. Read load is rate-limited
but jobs finish at different times, so background phases may have different read counts. Compare
CPU per fixed workload and queue completion alongside latency; do not subtract independent p95s.
SQL counters include application and scheduler queries but exclude fixture/polling queries from the
separate load generator. Instrumentation is identical in both copies and adds some overhead.
SQL durations include client queueing, network and server response time; they are not PostgreSQL
execution time or CPU. Automation stage wall times include nested stages, while each SQL query is
attributed to the innermost stage. Asynchronous descendants can outlive a stage, and concurrent query
durations can sum to more than wall time. Transaction timings include connection acquisition when
measured around the route transaction call. No SQL bind values are captured.

Benchmark-only source hooks expose scheduler triggers on the isolated worker and allow only the
exact local HTTP receiver through workspace webhook SSRF checks. SMTP uses the real protocol and
mail renderer with a local resolver override. Idle polling latency is bypassed. External providers,
TLS/WAN, browser rendering, native web-push encryption/provider delivery, hosted billing, long-lived
memory growth, crash replay, and all possible job types are outside this measurement. The competing-jobs
digest sweep is idle; the separate controlled-time phase measures populated digest generation.
Phase elapsed time includes waiting for rate-limited reader loops to finish. Prefer the dedicated
observer and email timings when assessing delivery latency. Whole-workload reads are not a
saturation or capacity test. Concurrent Global Work readers request first pages; they do not emulate
the browser repeatedly walking all 30 pages after realtime invalidation. The separate full walks
measure that cost directly. Use repeated 200-member pairs before judging tail-latency changes.

## Measured pass: 2026-10-12

Three alternating before/after pairs at each of 40 and 200 members, with the complete final code:

| Metric | Before | After |
| --- | ---: | ---: |
| Notification observer p95, 40 members | 2.17s | 0.94s |
| Notification observer p95, 200 members | 14.04s | 3.06s |
| 100 initial email attempts, 40 members | 15.83s | 4.67s |
| Digest worker maximum loop delay, 200 members | 305ms | 64ms |
| Retention worker maximum loop delay, 40 members | 91ms | 15ms |
| Automation template queries, 12 moves | 96 | 12 |

These are medians of per-run metrics. All retries recovered and exact card/digest payload parity
passed. Global Work's full walk remained about one second, with no repeatable CPU gain; automation
mutation latency also did not consistently improve. At 200 members, concurrent My/Team p95 rose
about 6–9% despite faster job completion. Avoid blanket claims that every path became faster.
Full ranges, event-loop utilization, validation and reproduction details are in the local
`results/system-pass/report.txt`; authoritative raw runs are `final40` and `final200` beneath it.

## Follow-up: bounded Global Work pages and notification concurrency

The follow-up baseline already includes the preceding pass. Three alternating pairs at each of
40 and 200 members use 500-card exhaustive/refresh pages and two notification activity keys in
flight. Initial/manual table pages stay at 100. Exact card parity, expected notification receipts,
96 automation comments per run and empty outboxes passed in all twelve final runs.

| Metric | Before | After |
| --- | ---: | ---: |
| My Cards 3,000-card refresh, 40 members | 983ms | 343ms |
| Team Cards 3,000-card refresh, 40 members | 976ms | 331ms |
| Global Work API CPU, fixed work, 40 members | 2,696ms | 1,530ms |
| Maximum app loop delay in Global Work, 40 members | 17ms | 23ms |
| Notification observer p95, 40 members | 862ms | 211ms |
| Notification observer p95, 200 members | 2,711ms | 2,407ms |
| Notification queue wait p95, 200 members | 2,507ms | 765ms |

At 200 members, full walks remain 65–67% faster with 44% less API CPU. The larger page trades a
longer individual loop pause for fewer requests and less total work. A single exploratory
250-card pair produced roughly 0.51s walks and 33% less CPU with an 18ms maximum loop delay;
this is weaker evidence than the repeated 500-card result. Initial-page latency does not
consistently improve. The notification queue remains process-local; distinct-key backlog and
crash durability are not solved. Its SQL count is unchanged, and the larger audience's end-to-end
gain is only 11%, despite much less queue waiting. Instrument downstream outbox dispatch next.

Automation production behavior is unchanged in this follow-up. Profiling puts the move
transaction at 32–33ms p50 and subsequent publication at 186–200ms p50. Eight generated comments
cause sixteen sequential durable comment/activity publications per move. Ordered publication
batching is the next candidate; no new batching or durable notification-job schema was applied.
Automatic review rejected those broader rewrites, so they remain proposals requiring approval
and delivery/order/recovery validation.

See `results/followup-pass/report.txt` for full metrics, limitations, test commands, the source
archives and reproduction instructions. `final40` and `final200` contain the authoritative runs;
`pages250` is exploratory. Browser verification passed 18 E2E tests, including an exact 201-card
refresh in one request; the same regression test failed on the baseline's two continuations.
Screenshots/traces/logs: `e2e/artifacts/20261012T110849Z-769616`. Because host port 56380 was occupied,
the verified run used an archived temporary runner with Valkey on 56480; the report explains replay.
