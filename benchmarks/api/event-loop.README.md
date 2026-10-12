# Board payload and event-loop microbenchmark

`event-loop.mjs` compares the cost of encoding one real board-open payload. It uses Node built-ins
and the already-installed Fastify serializer, adds no dependency, and accepts only a local API.
It authenticates and reads one board; it does not modify board data. Results and the payload are
written under the gitignored `benchmarks/api/results/` directory.

This is a CPU/payload microbenchmark, not an HTTP, SQL, browser, or production-throughput benchmark.
Run it separately from HTTP load tests so the two do not contend for CPU.

```bash
# Seed the intended fixture separately, then start the local API.
PERF_CARD_COUNT=3000 PERF_WORKSPACE_COUNT=6 PERF_MEMBER_COUNT=40 pnpm perf:web:seed

# Fetch once without running the benchmark; validates the expected 3,000 cards.
node benchmarks/api/event-loop.mjs --fetch-only

# Reuse exactly the same payload on subsequent runs.
PERF_INPUT=benchmarks/api/results/event-loop-20261012/board-open.json \
  node benchmarks/api/event-loop.mjs
```

Use `PERF_API_URL`, `PERF_EMAIL`, `PERF_PASSWORD`, and `PERF_BOARD_ID` to select another local fixture.
`PERF_EXPECT_CARDS` defaults to 3000 and fails when the fixture size differs. `PERF_OUTPUT_DIR` changes
the output directory; `PERF_ROUNDS` defaults to 31, with `PERF_WARMUP_ROUNDS=3` discarded warmups.
`PERF_VARIANTS` selects comma-separated exact variant names from a previous result.

Every round rotates/reverses variant order to spread thermal and garbage-collection drift. The
result retains every sample, medians and p95s, along with Node/CPU details and roundtrip checks.

| Comparison | What it includes |
| --- | --- |
| JSON serialization / parsing | Full payload, including conversion to UTF-8 as a separate case |
| Schema serializer | Fastify's installed `fast-json-stringify`, with a schema inferred from all fixture values; compile cost reported separately |
| Worker offload | Reused worker, main-thread structured clone, serialization, and string or transferred UTF-8 return |
| Worker cache / response cache | Optimistic bound with preloaded data; excludes permission-aware invalidation and cache construction |
| 150 / 500-card pages | Initial page encoding/parsing and all pages serialized with event-loop yields between pages |
| Targeted field hoist | Removes repeated board/workspace/organisation context and custom-field card IDs; includes runtime transformation and restoration |
| Common fields / columnar / string dictionary | Exact lossless JSON transformations, with encoding and decoding costs |
| gzip 6 / deflate 6 / Brotli 4 | Synchronous diagnostic, asynchronous pre-encoded input, and stringify + asynchronous compression |

`dispatchMs` is the synchronous call before its returned promise is awaited. For worker variants,
this exposes sender-side structured cloning. `processCpuMs` includes all process threads, including
workers and libuv compression; it is not main-thread CPU. `mainLoopActiveMs` comes from Node's
`eventLoopUtilization`. `maxTimerLagMs` uses a 1 ms timer during each sample, so small values have a
scheduling floor; compare against `idle-probe`. A p95 over 31 samples is descriptive, not a
statistical confidence interval.

The paging experiment includes full board metadata on the initial page and cards only thereafter.
It retains every card but excludes queries, network round trips, merging, and render costs. Actual
endpoints that repeat metadata will send more bytes. Dictionary/columnar encodings change the wire
contract and require corresponding client decoding. All encodings, worker returns, schema output,
and compression codecs are checked for exact decoded equality outside timed sections.

An inferred serializer schema covers only this fixture. It must not be copied into a production
route: a real schema must preserve every supported optional field and viewer-specific response.
Likewise, a pre-serialized cache hit assumes authorization, tenancy, invalidation, and freshness
have already been handled. These cases quantify a ceiling; they are not implementation proposals.
