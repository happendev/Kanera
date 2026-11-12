# Large web benchmark

This opt-in benchmark captures a repeatable baseline before production performance changes. It does not run in CI and does not modify application code.

## Fixture

`pnpm perf:web:seed` replaces only the marked `[LOCAL PERF] Kanera Web Benchmark` organisation in the local development database. It refuses production and non-local database URLs.

The fixture contains:

- 40 boards for app-shell navigation;
- 20 workspace-scoped lists;
- exactly 1,000 active cards on the primary board;
- 500 deterministic local cover images with wide, square, and tall aspect ratios;
- descriptions, three labels, two or three assignees, due dates, and seven custom-field values on every card;
- 60 rich cards with two eight-item checklists and eight comments each.

Login with `perf@kanera.local` / `Perf12345`.

The shape is env-tunable. The defaults above are the historical fixture, so results captured before
the fixture became parameterised stay comparable:

```bash
PERF_CARD_COUNT=3000 PERF_BOARD_COUNT=60 pnpm perf:web:seed
PERF_WORKSPACE_COUNT=6 PERF_MEMBER_COUNT=40 pnpm perf:web:seed
PERF_SECONDARY_BOARDS=5 PERF_SECONDARY_CARDS=500 pnpm perf:web:seed
```

`PERF_WORKSPACE_COUNT` and `PERF_MEMBER_COUNT` control the cross-workspace breadth that
`loadAccessibleBoards` fan-out, `/work/catalog`, and multi-page work cursors need; the primary
1,000-card board is unaffected by them. The concurrent server-side companion to this benchmark lives
in [../api](../api/README.md).

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
PERF_CPU_THROTTLE=4 pnpm perf:web
PERF_SCROLL_CYCLES=3 pnpm perf:web
```

Every successful run writes its complete JSON result to `benchmarks/web/results/<timestamp>-<label>.json`. The timestamp uses UTC and the optional `PERF_LABEL` makes before/after runs easy to identify. `PERF_OUTPUT` overrides the generated path when a specific destination is needed.

Results are also printed as a table and as one machine-readable `KANERA_PERF_RESULT=...` JSON line.

## Coverage

The runner measures:

- app-shell/home navigation with 40 board links;
- initial board render and the fully mounted 1,000-card board;
- first-traversal and fully mounted list scrolling, including frame percentiles, dropped-frame
  estimates, Long Animation Frames, long tasks, script/layout/style cost, DOM growth, and image resources;
- pointer-down to drag-preview and first-preview-frame latency on the initial and fully mounted board;
- document-click fanout before and after mounting all cards;
- board search and table-view switching;
- retained heap after opening 25, then 50 unique rich card details, followed by a cached reopen cycle;
- post-GC JavaScript heap, DOM size, global listener counts by event, layout/style counters, request count, and encoded bytes.

Navigation timing uses the median of five warm runs by default. Compare runs on the same machine, browser, viewport, dev-stack state, and commit; absolute development-build timings are less important than the before/after delta.

## Calendar, Timeline and Dependencies

`planning-performance.spec.cjs` benchmarks the three board views using local fixture data. Use the
**default** fixture, then add planned starts and 900 blocking edges (100 chains of ten cards):

```bash
pnpm perf:web:seed
docker exec -i kanera-postgres psql -U kanera -d kanera -v ON_ERROR_STOP=1 < benchmarks/web/planning-fixture.sql
# Start the normal API + worker, then serve the optimized web bundle locally:
pnpm --dir apps/web exec ng serve --configuration production --watch=false --hmr=false --live-reload=false --port 4201 --proxy-config ../../benchmarks/web/planning-proxy.config.cjs
# In another terminal:
PERF_BASE_URL=http://localhost:4201 PERF_BUILD=optimized \
  PERF_OUTPUT=benchmarks/web/results/planning-optimized.json \
  pnpm exec playwright test --config benchmarks/web/planning-performance.config.cjs
```

The benchmark refuses non-loopback destinations. It discards one navigation per view/width, then
records five warm full-document navigations, DOM and mounted-card counts, post-GC heap, API request
timing, long tasks, six density toggles (Calendar/Dependencies) or alternating zoom clicks (Timeline) and two seconds of scrolling per axis. Desktop is 1600×1000;
phone-width is 390×1000 (viewport coverage, not mobile hardware or touch emulation). Dependencies
currently returns at most 400 cards; Timeline and Calendar consume all 1,000 board cards.

Toggle timing is measured **inside the browser**, from a synthetic button click through two animation
frames. Timeline additionally records time to a settled zoom and animation frame p95, waiting for
four unchanged slider frames before the next interaction or scroll (the full settled time includes
that four-frame stability guard). Hover and critical-path toggles
also run in-browser (six samples each). It excludes Playwright selector/actionability work and is not
a field INP measurement. Scroll
p95 uses animation-frame intervals during scripted vertical scrolling; CDP records scroll script,
layout, style and total task durations. CPU profiling also saves a separate scroll-only profile. Navigation includes local API,
authentication, module loading and browser automation readiness checks; it is not LCP.

`PERF_CPU_THROTTLE=4`, `PERF_NAVIGATION_RUNS=5`, `PERF_WIDTHS=1600,390`,
`PERF_VIEWS=calendar,timeline,dependencies`, and `PERF_TEST_OUTPUT` are supported. Screenshots
are written under `e2e/artifacts/planning-perf/`. `PERF_PROFILE=1` saves CPU profiles; `PERF_TRACE=1`
saves Playwright traces. Run diagnostic captures separately: trace snapshots/accessibility traversal
can materially distort timing on large DOMs. Do not compare traced results to untraced results.
Production configuration here measures optimized JavaScript served by `ng serve`, not nginx/CDN,
compression, production database load, or installed-PWA behavior.

Reseeding resets the extra edges and start dates. The SQL is restricted to the marked local fixture;
never run it against a real organisation.

**Historical Timeline caveat:** the original audit and calendar/mounting comparison below started
scrolling before zoom animations settled. Their Timeline scroll results include overlapping zoom
work and should not be treated as isolated scrolling measurements. Use the settled-scroll comparison
below for the follow-up investigation.

### Measured baseline — 11 November 2026

Source revision `952a94c9`; Chromium 149.0.7827.55; Node 24.18.0; Ryzen 7 7840HS; Linux x86_64. Optimized production configuration served locally, local self-hosted API and worker. No network throttling. Five warm full-document navigations per cell; three samples per toggle direction. These are synthetic measurements on a working development machine, not field percentiles or production latency guarantees.

| View | Width | Mounted cards | DOM elements | Ready, 1× / 4× CPU | Restore details or zoom out, 1× / 4× | Scroll p95 frame, 1× / 4× |
|---|---:|---:|---:|---:|---:|---:|
| Calendar | 1600 | 846 | 28,661 | 1455 / 5170 ms | 669 / 3237 ms | 16.7 / 100.0 ms |
| Timeline | 1600 | 21 | 1,220 | 437 / 1599 ms | 28 / 98 ms | 16.7 / 83.3 ms |
| Dependencies | 1600 | 377 | 23,743 | 1358 / 4768 ms | 558 / 2202 ms | 16.7 / 66.7 ms |
| Calendar | 390 | 22 | 1,331 | 414 / 1203 ms | 27 / 123 ms | 16.8 / 16.7 ms |
| Timeline | 390 | 25 | 927 | 446 / 1428 ms | 29 / 82 ms | 16.8 / 50.0 ms |
| Dependencies | 390 | 377 | 23,442 | 1259 / 4183 ms | 206 / 1176 ms | 16.7 / 33.3 ms |

Calendar is paged month view. Desktop Dependencies is Map; phone Dependencies defaults to Steps. The graph endpoint returns 400 cards with a truncation warning; 377 are rendered in this fixture, in 220 chain fragments, because relations beyond the cap cannot be drawn. The underlying fixture has 1,000 cards and 900 relations. Graph topology is stable within a seeded fixture; reseeding random UUIDs changes its exact chains.

The normal-speed desktop board-open request medians were 58–63 ms; schedule was 75 ms and dependency-graph was 62 ms. Calendar and Dependencies had median longest startup tasks of 504 ms and 446 ms respectively, while Timeline had no startup long tasks in these samples. The expensive page loads are predominantly browser work in this local test; this is not a concurrent backend capacity benchmark.

Priority findings:

1. **Calendar: correct its initial width before mounting cards, then bound desktop mounting.** At a 1200 px viewport, a MutationObserver verified **846 cards mounted initially, then 76** after the host-width observer selected compact layout, in all three diagnostic runs. `board-calendar-view.component.ts:187` seeds layout from `window.innerWidth`; the sidebar makes the actual panel narrower. Avoiding this temporary full render is a concrete, smaller first fix.  The full layout mounts every card in the visible month, including cards many screens below the fold. Its existing compact layout already caps each day behind “more”; extending that approach to crowded full-width days, or windowing weeks/cards, is the first candidate. Preserve drag/drop targets and keyboard access.
2. **Dependencies: window chain sections.** The 400-card response cap does not bound DOM complexity: Map has 23,743 elements and phone Steps has 23,442. Mount only nearby chain contents while retaining measured layout extents; retain focused cards and link targets. The phone layout still has this problem.
3. **Timeline: retain row virtualization and investigate throttled scrolling.** It mounts only 21–25 rows at a time and zoom is inexpensive at normal CPU speed. At 4× CPU, desktop scrolling reaches an 83 ms p95 frame interval. Hiding wires improved the diagnostic scroll p95 to 66.6 ms, but 12 frames still exceeded 33.4 ms in two seconds; wires explain only part of the slowdown. Profile row churn, label measurement and rendering before changing the scheduler.
4. **Lower priority: repeated presentation calculations.** Calendar overdue/due-soon helpers and dependency tile labels, assignee arrays, and list lookups run from templates. Cache per-card presentation only if a focused profile shows material residual cost after mounting is bounded. Current evidence does not justify rewriting the graph or scheduling engine.

No application behavior was changed. Browser checks had no uncaught errors. This benchmark covers board views and their shared components; cross-board My/Team Cards pagination, realtime bursts, drag/reschedule writes, dense single-component dependency graphs, production network delivery and physical phones remain outside this run.

Raw local results: `results/planning-optimized.json` and `results/planning-optimized-4x.json`. Screenshots: `../../e2e/artifacts/planning-optimized/` and `../../e2e/artifacts/planning-optimized-4x/`. Initial exploratory traced runs were discarded because Playwright tracing/accessibility traversal distorted timings; only untraced optimized runs appear above.

Targeted diagnostics:

- `PERF_WIDTHS=1200 PERF_VIEWS=calendar PERF_NAVIGATION_RUNS=3 PERF_OBSERVE_CALENDAR=1` confirms the transient 846 → 76 card mount (`results/planning-calendar-mounts.json`). Mutation observation is opt-in and its timings are excluded from the baseline table.
- The 4× compact-layout comparison settled at 76 cards / 3,074 DOM elements. Restoring detail took 256 ms versus 3,237 ms in the full desktop baseline (about 92% lower); scrolling returned to 16.8 ms p95. Initial navigation remained 5.8 seconds because of the temporary full render. These comparison samples are retained in `results/planning-comparisons-4x.json`; its extra 1200 px Timeline branch was interrupted at a collapsed-control lookup and excluded. The lookup was corrected and the wire comparison rerun separately.
- `PERF_WIDTHS=1600 PERF_VIEWS=timeline PERF_NAVIGATION_RUNS=3 PERF_CPU_THROTTLE=4 PERF_TIMELINE_WIRES=off` isolates Timeline scrolling without dependency wires.

The isolated no-wires run passed with zero mounted wire hit targets; its raw results are `results/planning-timeline-no-wires-4x.json`. Full reproduction commands and service logs are under `../../e2e/artifacts/planning-audit/`.

Validation: both full optimized benchmark runs passed, as did the calendar mount diagnostic and
isolated Timeline wire comparison. `pnpm lint` passed (38 existing web warnings, zero errors).
`pnpm --filter @kanera/web test -- board-calendar-view.component.spec.ts timeline-layout.spec.ts dependency-map.layout.spec.ts`
passed all 58 focused tests, plus the test script's 15 worker/manifest checks. No application code,
shared contracts, translations or realtime behavior changed. The marked temporary benchmark
organisation was deleted after verification, and the API, worker and web servers started for this
audit were stopped. Rerun the fixture commands before reproducing.

### Implemented fixes and matched comparison — 11 November 2026

The follow-up changes the application: Calendar waits for its measured panel width, caps crowded full-width month days at four cards plus “more” (compact: two; week/phone agenda: nineteen), and reuses the translated expansion controls in board and Global Work views. Days with exactly the limit show all their cards. Dependencies keeps chain placeholders and mounts contents near the actual scrolling pane, retains focused/edited chains, and restores each chain’s horizontal scroll offset on remount. A single large chain remains mounted as a unit; this is chain-level windowing, not node-level virtualization.

A fresh fixture was seeded **once** for both builds. Before and after used identical cards, dates and relations, five warm navigations and three clicks in each direction. Both were optimized builds of the same checkout, with the before server frozen before source edits. The new fixture yields 379 rendered dependency cards in 239 fragments (400 returned); this differs from the earlier exploratory fixture, so compare the matched numbers below rather than mixing runs.

| View / width | Mounted cards before → after | DOM elements before → after | Ready before → after | Restore details / zoom out before → after |
|---|---:|---:|---:|---:|
| Calendar / 1600 | 846 → 152 | 28,664 → 5,826 | 1274 → 541 ms | 618 → 125 ms |
| Timeline / 1600 | 21 → 21 | 1,211 → 1,220 | 407 → 415 ms | 29 → 29 ms |
| Dependencies / 1600 | 379 → 23 | 24,213 → 1,997 | 1161 → 474 ms | 477 → 65 ms |
| Calendar / 390 | 22 → 19 | 1,328 → 1,245 | 345 → 358 ms | 26 → 24 ms |
| Timeline / 390 | 25 → 25 | 921 → 932 | 389 → 389 ms | 26 → 28 ms |
| Dependencies / 390 | 379 → 5 | 23,638 → 1,001 | 1123 → 406 ms | 185 → 25 ms |

| View / width, 4× CPU | Ready before → after | Restore details / zoom out before → after | Scroll p95 frame before → after |
|---|---:|---:|---:|
| Calendar / 1600 | 3996 → 1771 ms | 2456 → 601 ms | 66.6 → 16.8 ms |
| Timeline / 1600 | 1270 → 1555 ms | 80 → 107 ms | 50.0 → 66.7 ms |
| Dependencies / 1600 | 3949 → 1574 ms | 1951 → 340 ms | 50.0 → 33.4 ms |
| Calendar / 390 | 1207 → 1255 ms | 94 → 88 ms | 16.8 → 16.7 ms |
| Timeline / 390 | 1304 → 1402 ms | 73 → 92 ms | 50.0 → 50.1 ms |
| Dependencies / 390 | 3737 → 1379 ms | 809 → 116 ms | 16.8 → 33.3 ms |

Desktop post-GC heap fell from 73.1 to 34.5 MiB in Calendar and 53.6 to 28.2 MiB in Dependencies. Normal-speed scrolling stayed around 16.7 ms p95 for both. Calendar’s shorter capped document scrolls about 4,200 px rather than the harness’s 5,000 px ceiling, so its scroll sample is not distance-identical.

The explicit 1200 px MutationObserver check now sees **76 peak / 76 settled cards in all three runs**, versus the prior 846 peak / 76 settled. This diagnostic is separately instrumented; its timing is excluded from the tables. New bounded-mount assertions were run against the old frozen build and failed as expected at 846 calendar cards and 379 dependency cards, then passed against the new build.

Tradeoffs and limits: offscreen chain contents now mount during scrolling. At 4× CPU, phone Steps scroll p95 rose from 16.8 to 33.3 ms (3 frames over 33.4 ms in the two-second sample versus 1 before), while its detail restoration fell from 809 to 116 ms. Timeline was not changed; its normal-speed zoom remained ~29 ms, while the throttled control varied, illustrating machine/run noise. No claim is made that this fixes Timeline scrolling, every individual giant chain, or production network latency.

Verification:

- `pnpm lint` passed with 38 existing warnings and zero errors; extraction only reordered existing source messages, and all 10 translations remain complete.
- `pnpm --filter @kanera/web test -- board-calendar-view.component.spec.ts dependency-map.layout.spec.ts dependency-map.tile.spec.ts`: 48 tests passed, plus 15 script-level worker/manifest checks.
- `pnpm test:e2e -- planning-mounting.spec.ts dependency-map.spec.ts`: all 5 passed. This covers live dependency updates/edits, responsive/touch controls, calendar initial measurement and expansion, real drag/drop into an empty day, focus retention during eviction, horizontal scroll restoration, phone Steps and Global Work’s outer scroller. Artifacts: `../../e2e/artifacts/20261111T201038Z-68940/`.
- Both optimized before/after benchmark pairs and the width diagnostic passed. The first browser-test attempt required fixture fixes (scroll the drag source into view; assign cards to a teammate for Team Cards); the final run above is green.

Reproduce the after benchmark with the fixture and server commands above, plus:

```bash
PERF_BASE_URL=http://localhost:4202 PERF_BUILD=optimized-after PERF_EXPECT_BOUNDED=1 \
  PERF_OUTPUT=benchmarks/web/results/planning-fix-after.json \
  PERF_TEST_OUTPUT=e2e/artifacts/planning-fix-after \
  pnpm exec playwright test --config benchmarks/web/planning-performance.config.cjs
# Repeat with PERF_CPU_THROTTLE=4 and distinct output paths.
```

Serve the after build on port 4202 for this command. `PERF_EXPECT_BOUNDED=1` enables fixture-specific mounting assertions; `PERF_OBSERVE_CALENDAR=1 PERF_WIDTHS=1200 PERF_VIEWS=calendar` checks the startup peak. Raw matched results are `results/planning-fix-{before,after}{,-4x}.json`; screenshots are under `../../e2e/artifacts/planning-fix-{before,after}{,-4x}/`. The temporary local fixture is removed after the run; recreate it before reproducing.

### Timeline scrolling and interaction follow-up — 11 November 2026

The baseline here already includes the Calendar measurement/folding and Dependencies chain-windowing
fixes above. Both optimized servers were frozen before measuring, with the same seeded cards and
900 edges throughout. CPU profiles exposed overlapping zoom work in the old scroll benchmark; the
corrected harness settles every zoom before scrolling. Final 4× results use three alternating
before/after browser sessions, each with one discarded navigation and one measured navigation per
view/width, six zoom/density, hover and critical-path samples, and a two-second sweep on each axis.
The tables use medians of the three per-session measurements; a frame p95 is a per-sweep statistic,
not a field percentile. Normal-CPU runs use three warm navigations and one sweep per axis.

Changes under test:

- Timeline scroll events use a passive native listener. Angular now checks the view when the
  quantized window signals change, rather than on every vertical or horizontal scroll event.
- Grouping, sorting and date parsing are cached independently of zoom; zoom scales cached row
  geometry. Dependency labels and wire geometry survive scroll changes, and offscreen SVG paths
  are created lazily when first needed.
- Initial Fit measures the actual panel before choosing its name-pane width. An existing browser
  assertion caught a wide-panel first-fit race that clipped the last bar.
- Dependencies batches horizontal-position restoration in the render write phase, skips untouched
  zero positions, and takes chain heights from ResizeObserver's border-box measurements.

| View | Width | Scroll JS, before → after | Scroll frame p95, before → after | Hover, before → after | Critical-path toggle, before → after |
|---|---:|---:|---:|---:|---:|
| Timeline | 1600 | 1195 → 730 ms | 50.0 → 33.3 ms | 16 → 16 ms | 41 → 41 ms |
| Dependencies | 1600 | 717 → 659 ms | 66.6 → 49.9 ms | 27 → 27 ms | 59 → 57 ms |
| Timeline | 390 | 1238 → 521 ms | 33.3 → 16.8 ms | 16 → 16 ms | 40 → 43 ms |
| Dependencies | 390 | 179 → 175 ms | 33.3 → 33.3 ms | 31 → 31 ms | 38 → 33 ms |

Timeline horizontal-scroll JS fell from 704 → 24 ms (desktop) and 714 → 26 ms (phone), with frame p95
remaining about 16.7 ms. Horizontal sweeps cover the available overflow; initial-fit correction
changes that extent slightly. Settled zoom duration fell from 823 → 749 ms (desktop) and 714 → 656 ms
(phone), including the four-frame stability guard. Zoom still has long frames at 4× CPU; this is an
incremental improvement, not a claim of 60 fps zooming on constrained hardware.

Dependencies restoring detailed cards measured 335 → 332 ms on desktop and 102 → 93 ms on phone.
Hover and critical-path interactions remain similar. Its desktop scroll JS improvement is modest
(8%); phone scroll JS is essentially unchanged. Frame timings vary on this working machine:
desktop Dependencies scroll p95 ranged 50–66.7 ms before and 49.9–50 ms after. Mounting rich chain
contents remains the main visible scroll cost. This fixture measures a fragmented graph capped at
400 returned cards, not the worst case of one giant connected chain. By-week layout is covered by
functional E2E, not a separate timed workload here. Phone screenshots also show pre-existing wires
painting over Timeline's sticky name pane; that visual issue is unchanged by this performance work.

At normal CPU, every final scroll sweep remained at 16.7–16.8 ms frame p95 with no frames over
33.4 ms. Timeline vertical-scroll JS fell from 416 → 210 ms (desktop) and 367 → 146 ms (phone).
All eight final benchmark sessions passed without page errors or HTTP 5xx responses.

Raw final results: `results/scroll-final-{before,after}-4x-{1,2,3}.json`,
`results/scroll-final-{before,after}-1x.json`, and `results/scroll-final-comparison.json`.
Screenshots: `../../e2e/artifacts/scroll-final-after-1x/` (desktop and phone).
Earlier `scroll-profile-*`, `scroll-settled-profile-*`, `scroll-before*` and `scroll-after*` files are
exploratory captures or superseded implementations, not the final comparison.

Reproduce each 4× sample against the frozen before server on 4201 or after server on 4202, keeping
heavy builds/tests idle; change the output suffix for each of three alternating pairs:

```bash
PERF_BASE_URL=http://localhost:4202 PERF_BUILD=optimized-final-after \
  PERF_VIEWS=timeline,dependencies PERF_CPU_THROTTLE=4 PERF_NAVIGATION_RUNS=1 \
  PERF_OUTPUT=benchmarks/web/results/scroll-final-after-4x-1.json \
  PERF_TEST_OUTPUT=e2e/artifacts/scroll-final-after-4x-1 \
  pnpm exec playwright test --config benchmarks/web/planning-performance.config.cjs
# Normal CPU: PERF_CPU_THROTTLE=1 PERF_NAVIGATION_RUNS=3, with separate output paths.
```

Validation:

- `pnpm lint`: passed, zero errors, 38 existing web warnings.
- `pnpm --filter @kanera/web test -- timeline-layout.spec.ts dependency-map.layout.spec.ts`:
  33 focused tests passed, plus the script's 15 service-worker/manifest checks.
- `pnpm test:e2e -- timeline.spec.ts dependency-map.spec.ts planning-mounting.spec.ts`:
  12 passed; the initial-fit assertion failed, exposing the wide-panel measurement race.
  Artifacts: `../../e2e/artifacts/20261111T202846Z-96422/`.
- After correcting initial fit and the scroll listener,
  `pnpm test:e2e -- timeline.spec.ts -g 'large timelines|chart zooms'`: both passed.
  Artifacts: `../../e2e/artifacts/20261111T203307Z-108359/`.
  These checks cover focus pinning/release, 100–2,000 rows, zoom anchoring and background panning;
  the wider run covers live edits, dependency linking/unlinking, keyboard/touch and responsive layouts.
- Validation logs: `../../e2e/artifacts/planning-scroll-validation/`.

The marked local fixture was deleted and the API, worker and two web servers started for this
investigation were stopped. Existing database/cache containers were left running.

### Rich dependency-chain mounting follow-up — 11 November 2026

This comparison starts after all the Timeline and Dependencies fixes above. The fixture was seeded
once for both frozen optimized builds: 1,000 cards, 900 blocking edges, rich labels/fields/assignees;
the graph response is capped at 400 cards (237 fragments in this fixture). Desktop uses Map and
phone uses Steps. The original `chains-*-4x-1` runs are exploratory: concurrent API benchmarking
made their timings variable. The repeated `chains-final-*` wall-clock measurements also encountered that activity; use the
quiet rerun below for the current mounting-cost conclusion.

The focused changes reuse generated avatar SVG URIs across remounted components (at most 256
identity/theme pairs), reuse pure day/slot/timezone conversions (at most 1,024 instants), and give
each dependency chain CSS layout containment. Overdue/due-soon checks still use the current clock;
labels still use current formatting, and theme/identity changes select different avatar entries.

Browser verification covers rich/slim remounting and live due-slot changes, cross-board updates,
link/unlink with undo/redo, critical paths, Map/By week/Steps, narrow screens and touch controls,
keyboard focus across window eviction, horizontal scroll restoration, and Team Cards scrolling.
The new due-slot assertion initially expected a leading zero that the formatter does not emit;
after correcting that assertion, the targeted browser scenario passed.

Validation commands and artifacts:

- `pnpm lint`: zero errors, 38 existing web warnings.
- `pnpm --filter @kanera/web test -- avatar.component.spec.ts due-date.util.spec.ts dependency-map.layout.spec.ts`:
  38 tests passed, plus 15 service-worker/manifest checks. Includes theme changes, DST, different
  zones/slots and due-status transitions after warming the conversion cache.
- `pnpm test:e2e -- dependency-map.spec.ts planning-mounting.spec.ts`: four passed plus the
  formatting assertion failure described above; `../../e2e/artifacts/20261111T205134Z-147396/`.
- `pnpm test:e2e -- dependency-map.spec.ts -g 'maps a cross-board chain'`: passed;
  `../../e2e/artifacts/20261111T205450Z-160447/`.
- `pnpm exec tsc -p e2e/tsconfig.json && pnpm exec eslint e2e/dependency-map.spec.ts`: passed after
  the test correction. Validation logs: `../../e2e/artifacts/chains-validation/`.

Fixed-work comparison (`PERF_MOUNT_SWEEP=1`): three passes through the same five target chains at
indices 6, 12, 18, 24 and 30, returning to the top before each pass. Each jump waits for the target
chain to mount and two animation frames. Target identities, target-card counts and total mounted-card
counts matched before/after at every step. A separate 1× sweep measures CDP `ThreadTime` (active
renderer-thread CPU); a 4× sweep measures elapsed mount time. Do not use 4× `ThreadTime` as application
CPU: an idle-page check showed Chrome's CPU emulator itself adds substantial thread CPU overhead.

| Viewport | Active CPU for five mounts, 1× | Elapsed for five mounts, 4× | 4× elapsed range, before / after |
|---|---:|---:|---:|
| Desktop Map, 1600 px | 305 → 209 ms (−31%) | 1,867 → 945 ms | 1,172–2,673 / 921–1,209 ms |
| Phone Steps, 390 px | 137 → 119 ms (−13%) | 723 → 599 ms | 693–732 / 527–610 ms |

Values are medians of three fixed-work passes per build/viewport, including the small harness cost.
The active-CPU ranges were 288–331 → 196–221 ms on desktop and 133–148 → 112–122 ms on phone.
Background API benchmarking restarted repeatedly throughout the session, so elapsed time and frame
p95 are indicative, not clean speedup estimates. The matched work and CPU measurements support a
reduction in mounting work; they do not establish an exact 4× wall-clock percentage or guarantee
60 fps. Rich DOM creation and paint remain; this still windows whole chains, not individual cards
inside one giant chain. No new network calls, payload limits or rendered-card limits were introduced.

The three repeated conventional 4× runs and the normal-CPU pair remain available in
`results/chains-final-{before,after}-4x-{1,2,3}.json` and
`results/chains-final-{before,after}-1x.json`; avoid attributing their noisy navigation/toggle deltas
to these changes. The historical fixed-work records are `results/chains-fixed-{before,after}.json` and
`results/chains-fixed-comparison.json`. Screenshots are under
`../../e2e/artifacts/chains-fixed-after/`. All final benchmark sessions passed with no page errors
or HTTP 5xx responses.

Reproduce the fixed-work comparison against frozen before/after builds using the same fixture:

```bash
PERF_BASE_URL=http://localhost:4202 PERF_BUILD=chains-fixed-after \
  PERF_VIEWS=dependencies PERF_CPU_THROTTLE=4 PERF_NAVIGATION_RUNS=1 PERF_MOUNT_SWEEP=1 \
  PERF_OUTPUT=benchmarks/web/results/chains-fixed-after.json \
  PERF_TEST_OUTPUT=e2e/artifacts/chains-fixed-after \
  pnpm exec playwright test --config benchmarks/web/planning-performance.config.cjs
# Repeat on port 4201 with before output paths. The mount sweep records both 1x CPU and 4x latency.
```

The marked fixture was removed and the API/worker plus both web servers started for this comparison
were stopped. Other benchmark processes and their databases were left untouched.


#### Quiet rerun — 11 November 2026

These results supersede the noisy timing estimates above. Other benchmarks were paused. Two frozen
optimized builds differ only in the avatar URI cache, zoned-instant cache and chain layout containment;
all earlier virtualization/scrolling fixes are present in both. The fixture was seeded once for this
comparison (225 graph fragments); its generated topology differs from the historical fixture, so do
not compare absolute times across those sessions. No product code changed during this rerun.

Three independent pairs ran sequentially in before/after, after/before, before/after order using
Chromium 149.0.7827.55, 4× CPU emulation, three measured navigations per viewport and no profiler.
Each run included three fixed-work passes at 1× and three at 4×. Every matched target identity,
target-card count and total mounted-card count agreed. Mount values below are medians of nine
five-target passes per build/viewport; interaction and scroll values are medians of three run summaries.
Phone means a 390 px desktop-browser viewport, not physical phone hardware.

| Measurement | Desktop Map, 1600 px: before → after | Phone Steps, 390 px: before → after |
|---|---:|---:|
| Five mounts, elapsed at 4× | 870 → 749 ms (−14%) | 531 → 479 ms (−10%) |
| Five mounts, active renderer CPU at 1× | 211 → 191 ms (−10%) | 137 → 123 ms (−10%) |
| Restore rich cards at 4× | 305 → 245 ms (−19%) | 79 → 69 ms (−12%) |
| Vertical scroll scripting at 4×, 5,000 px | 645 → 542 ms (−16%) | 155 → 121 ms (−22%) |
| Vertical scroll frame p95 at 4× | 49.9 → 33.4 ms | 16.8 → 16.8 ms |
| Warm navigation at 4× | 1,568 → 1,525 ms | 1,293 → 1,289 ms |

The nine-pass 4× mounting ranges were 824–903 → 704–801 ms on desktop and 490–602 → 443–496 ms
on phone. All three pairs improved mounting latency in both viewports. Navigation, hover and
critical-path toggles showed little change; desktop hover medians were 25.5 → 27.2 ms and critical
path 60.5 → 59.9 ms. Horizontal frame p95 remained about 16.7–16.8 ms. These small differences do
not establish a meaningful change. Desktop rich mounting still exceeds a frame budget: this change
reduces work but does not eliminate pauses or virtualize individual cards within a giant chain.

All six browser benchmark sessions passed without page errors or HTTP 5xx responses. Desktop and
phone screenshots were inspected. The functional E2E, focused unit tests and lint results above
remain applicable to the unchanged product code; those suites were not rerun for this measurement-only
follow-up. `git diff --check` passed.

Raw records: `results/chains-quiet-{before,after}-4x-{1,2,3}.json`; aggregate statistics:
`results/chains-quiet-comparison.json`. Browser screenshots:
`../../e2e/artifacts/chains-quiet-after-4x-3/` (each of the six runs has its own artifact directory).
Reproduce with the fixed-work command above, replacing the label/output paths with
`chains-quiet-after-4x-1` and setting `PERF_NAVIGATION_RUNS=3`; repeat for both builds three times.
The marked local fixture and servers started for this rerun were cleaned up afterward.
