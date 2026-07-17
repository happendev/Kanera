const { test, expect } = require("@playwright/test");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const WORKSPACE_ID = "70000000-0000-4000-8000-000000000100";
const BOARD_ID = "70000000-0000-4000-8000-000000000200";
const USER_ID = "70000000-0000-4000-8000-000000000010";
const EMAIL = "perf@kanera.local";
const PASSWORD = "Perf12345";
const EXPECTED_CARDS = 1_000;
const EXPECTED_LISTS = 20;
const NAVIGATION_RUNS = Math.max(1, Number.parseInt(process.env.PERF_NAVIGATION_RUNS ?? "5", 10));

const LISTENER_INSTRUMENTATION = String.raw`
(() => {
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const registry = new WeakMap();
  const counts = new Map();
  const keyFor = (target, type) => (target === window ? 'window:' : target === document ? 'document:' : 'other:') + type;
  const captureFor = (options) => typeof options === 'boolean' ? options : Boolean(options && options.capture);
  const adjust = (key, delta) => counts.set(key, Math.max(0, (counts.get(key) || 0) + delta));
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (listener && (this === window || this === document)) {
      let targetRegistry = registry.get(this);
      if (!targetRegistry) { targetRegistry = new Map(); registry.set(this, targetRegistry); }
      let typeRegistry = targetRegistry.get(type);
      if (!typeRegistry) { typeRegistry = new WeakMap(); targetRegistry.set(type, typeRegistry); }
      let captures = typeRegistry.get(listener);
      if (!captures) { captures = new Set(); typeRegistry.set(listener, captures); }
      const capture = captureFor(options);
      if (!captures.has(capture)) { captures.add(capture); adjust(keyFor(this, type), 1); }
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (listener && (this === window || this === document)) {
      const captures = registry.get(this)?.get(type)?.get(listener);
      const capture = captureFor(options);
      if (captures?.delete(capture)) adjust(keyFor(this, type), -1);
    }
    return nativeRemove.call(this, type, listener, options);
  };
  Object.defineProperty(window, '__kaneraPerfListenerCounts', {
    configurable: false,
    value: () => Object.fromEntries([...counts.entries()].filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b))),
  });
})();`;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function bytesToMiB(value) {
  return round(value / 1024 / 1024, 2);
}

test("large main-page baseline", async ({ page, browser }) => {
  await page.addInitScript({ content: LISTENER_INSTRUMENTATION });
  const cdp = await page.context().newCDPSession(page);
  await Promise.all([cdp.send("Performance.enable"), cdp.send("HeapProfiler.enable")]);

  const samples = [];
  const interactionTimings = {};
  let currentNetworkSample = null;
  page.on("requestfinished", async (request) => {
    const sample = currentNetworkSample;
    if (!sample) return;
    sample.requests += 1;
    try {
      const sizes = await request.sizes();
      sample.encodedBytes += sizes.responseBodySize + sizes.responseHeadersSize;
    } catch { /* A navigation can replace the request before its size is available. */ }
  });

  const navigate = async (pathname, ready) => {
    currentNetworkSample = { requests: 0, encodedBytes: 0 };
    const startedAt = performance.now();
    await page.goto(pathname, { waitUntil: "domcontentloaded" });
    await expect.poll(ready, { timeout: 90_000 }).toBe(true);
    await page.waitForTimeout(100);
    return round(performance.now() - startedAt);
  };

  const collect = async (name, durationMs = null, extra = {}) => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(100);
    const [{ metrics }, browserState] = await Promise.all([
      cdp.send("Performance.getMetrics"),
      page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const listeners = window.__kaneraPerfListenerCounts?.() ?? {};
        return {
          domNodes: document.querySelectorAll("*").length,
          cards: document.querySelectorAll("k-card").length,
          lists: document.querySelectorAll("k-list").length,
          boardLinks: document.querySelectorAll("k-app-shell a.board-link").length,
          listenerTotal: Object.values(listeners).reduce((sum, count) => sum + count, 0),
          listeners,
          navigation: nav ? { domContentLoadedMs: nav.domContentLoadedEventEnd, loadMs: nav.loadEventEnd, transferBytes: nav.transferSize } : null,
        };
      }),
    ]);
    const metric = Object.fromEntries(metrics.map(({ name: metricName, value }) => [metricName, value]));
    const row = {
      name,
      durationMs,
      jsHeapMiB: bytesToMiB(metric.JSHeapUsedSize ?? 0),
      domNodes: browserState.domNodes,
      cards: browserState.cards,
      lists: browserState.lists,
      boardLinks: browserState.boardLinks,
      globalListeners: browserState.listenerTotal,
      listeners: browserState.listeners,
      documentClickListeners: browserState.listeners["document:click"] ?? 0,
      windowStorageListeners: browserState.listeners["window:storage"] ?? 0,
      layoutCount: metric.LayoutCount ?? 0,
      recalcStyleCount: metric.RecalcStyleCount ?? 0,
      taskDurationMs: round((metric.TaskDuration ?? 0) * 1_000),
      scriptDurationMs: round((metric.ScriptDuration ?? 0) * 1_000),
      requests: currentNetworkSample?.requests ?? 0,
      encodedMiB: bytesToMiB(currentNetworkSample?.encodedBytes ?? 0),
      navigation: browserState.navigation,
      ...extra,
    };
    samples.push(row);
    return row;
  };

  await navigate("/login", async () => await page.locator("#email").isVisible() && await page.locator("#password").isVisible());
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("k-app-shell")).toBeVisible({ timeout: 90_000 });

  const runtime = await page.evaluate(() => ({
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    viewport: [innerWidth, innerHeight],
    userAgent: navigator.userAgent,
  }));

  const homeDurations = [];
  for (let run = 0; run < NAVIGATION_RUNS; run += 1) {
    homeDurations.push(await navigate("/", async () => await page.locator("k-home").isVisible() && await page.locator("k-app-shell a.board-link").count() >= 40));
  }
  await collect("shell/home", round(median(homeDurations)), { navigationRunsMs: homeDurations });

  const boardDurations = [];
  for (let run = 0; run < NAVIGATION_RUNS; run += 1) {
    boardDurations.push(await navigate(`/b/${BOARD_ID}`, async () => await page.locator("k-board k-list").count() >= 8 && await page.locator("k-board k-card").count() >= 200));
  }
  await collect("board/initial", round(median(boardDurations)), { navigationRunsMs: boardDurations });

  interactionTimings.documentClickInitialUs = await page.evaluate(() => {
    const runs = 200;
    const start = performance.now();
    for (let index = 0; index < runs; index += 1) document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return ((performance.now() - start) * 1_000) / runs;
  });
  interactionTimings.boardSearchMs = await page.evaluate(async () => {
    const input = document.querySelector("k-board .bf-search-input:not([disabled])");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const start = performance.now();
    setter.call(input, "scenario 09"); input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    setter.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    return performance.now() - start;
  });

  const expandStartedAt = performance.now();
  await page.evaluate(async ({ expectedCards, expectedLists }) => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
    for (let attempt = 0; attempt < 40 && document.querySelectorAll("k-board k-list").length < expectedLists; attempt += 1) {
      const lists = document.querySelector("k-board .lists");
      lists.scrollLeft = lists.scrollWidth;
      lists.dispatchEvent(new Event("scroll"));
      await pause();
    }
    for (let attempt = 0; attempt < 8 && document.querySelectorAll("k-board k-card").length < expectedCards; attempt += 1) {
      for (const cards of document.querySelectorAll("k-board k-list .cards")) {
        cards.scrollTop = cards.scrollHeight;
        cards.dispatchEvent(new Event("scroll"));
      }
      await pause();
    }
  }, { expectedCards: EXPECTED_CARDS, expectedLists: EXPECTED_LISTS });
  await expect.poll(async () => ({ cards: await page.locator("k-board k-card").count(), lists: await page.locator("k-board k-list").count() }), { timeout: 90_000 })
    .toEqual({ cards: EXPECTED_CARDS, lists: EXPECTED_LISTS });
  interactionTimings.mountAllBoardCardsMs = round(performance.now() - expandStartedAt);
  interactionTimings.documentClickExpandedUs = await page.evaluate(() => {
    const runs = 200;
    const start = performance.now();
    for (let index = 0; index < runs; index += 1) document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return ((performance.now() - start) * 1_000) / runs;
  });
  await collect("board/1,000-mounted", interactionTimings.mountAllBoardCardsMs);

  // The card link contains interactive label/checklist controls. Click the title itself so the
  // benchmark always measures opening the detail rather than whichever nested control is centred.
  const richCardTitles = page.locator("k-board k-card .card-title-text").filter({ hasText: "[Rich]" });
  await expect(richCardTitles).toHaveCount(60);
  const openRichCardBatch = async (startIndex, count) => {
    const timings = [];
    for (let index = startIndex; index < startIndex + count; index += 1) {
      const startedAt = performance.now();
      await richCardTitles.nth(index).click();
      await expect(page.locator("k-board k-card-detail .panel")).toBeVisible({ timeout: 30_000 });
      await page.locator("k-board k-card-detail .close-btn").click();
      await expect(page.locator("k-board k-card-detail")).toHaveCount(0);
      timings.push(performance.now() - startedAt);
    }
    return timings;
  };

  const firstDetailBatch = await openRichCardBatch(0, 25);
  await collect("board/after-25-details", round(median(firstDetailBatch)), { detailRunsMs: firstDetailBatch.map((value) => round(value)) });
  const secondDetailBatch = await openRichCardBatch(25, 25);
  await collect("board/after-50-details", round(median(secondDetailBatch)), { detailRunsMs: secondDetailBatch.map((value) => round(value)) });
  const cachedDetailBatch = await openRichCardBatch(0, 25);
  await collect("board/reopen-25-details", round(median(cachedDetailBatch)), { detailRunsMs: cachedDetailBatch.map((value) => round(value)) });

  const listViewStartedAt = performance.now();
  await page.locator('k-board button[aria-label="List view"]').click();
  await expect(page.locator("k-board-list-view")).toBeVisible();
  await page.waitForTimeout(150);
  interactionTimings.boardListViewMs = round(performance.now() - listViewStartedAt);
  await collect("board/list-view", interactionTimings.boardListViewMs);

  const assignedDurations = [];
  for (let run = 0; run < NAVIGATION_RUNS; run += 1) {
    assignedDurations.push(await navigate(`/w/${WORKSPACE_ID}/u/${USER_ID}`, async () => await page.locator("k-assigned-work k-list").count() === 20 && await page.locator("k-assigned-work k-card").count() >= 500));
  }
  await collect("assigned-work/initial", round(median(assignedDurations)), { navigationRunsMs: assignedDurations });

  const assignedExpandStartedAt = performance.now();
  await page.evaluate(async (expectedCards) => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
    for (let attempt = 0; attempt < 8 && document.querySelectorAll("k-assigned-work k-card").length < expectedCards; attempt += 1) {
      for (const cards of document.querySelectorAll("k-assigned-work k-list .cards")) {
        cards.scrollTop = cards.scrollHeight;
        cards.dispatchEvent(new Event("scroll"));
      }
      await pause();
    }
  }, EXPECTED_CARDS);
  await expect(page.locator("k-assigned-work k-card")).toHaveCount(EXPECTED_CARDS, { timeout: 90_000 });
  interactionTimings.mountAllAssignedCardsMs = round(performance.now() - assignedExpandStartedAt);
  await collect("assigned-work/1,000-mounted", interactionTimings.mountAllAssignedCardsMs);

  const capturedAt = new Date().toISOString();
  const label = process.env.PERF_LABEL ?? "local-baseline";
  const result = {
    schemaVersion: 1,
    label,
    capturedAt,
    baseUrl: process.env.PERF_BASE_URL ?? "http://localhost:4200",
    fixture: { boards: 40, lists: EXPECTED_LISTS, cards: EXPECTED_CARDS, richCards: 60, members: 6, labels: 12, customFields: 7 },
    environment: {
      browserVersion: browser.version(),
      browserPath: browser.browserType().executablePath(),
      ...runtime,
    },
    options: { navigationRuns: NAVIGATION_RUNS },
    interactionTimings: Object.fromEntries(Object.entries(interactionTimings).map(([key, value]) => [key, round(value, 2)])),
    samples,
  };

  console.log("\nKanera large-web benchmark");
  console.table(samples.map((sample) => ({
    sample: sample.name,
    "time ms": sample.durationMs,
    "heap MiB": sample.jsHeapMiB,
    "DOM nodes": sample.domNodes,
    cards: sample.cards,
    "global listeners": sample.globalListeners,
    "document click": sample.documentClickListeners,
    storage: sample.windowStorageListeners,
    requests: sample.requests,
    "encoded MiB": sample.encodedMiB,
  })));
  console.log("Interactions:");
  console.table(result.interactionTimings);
  console.log("KANERA_PERF_RESULT=" + JSON.stringify(result));
  const safeTimestamp = capturedAt.replaceAll(":", "-");
  const safeLabel = label.replaceAll(/[^a-zA-Z0-9_-]+/g, "-").replaceAll(/^-|-$/g, "") || "benchmark";
  const outputPath = process.env.PERF_OUTPUT ?? path.join(__dirname, "results", `${safeTimestamp}-${safeLabel}.json`);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Saved timestamped result: ${outputPath}`);
});
