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
const EXPECTED_COVERS = 500;
const NAVIGATION_RUNS = Math.max(1, Number.parseInt(process.env.PERF_NAVIGATION_RUNS ?? "5", 10));
const CPU_THROTTLE_RATE = Math.max(1, Number.parseFloat(process.env.PERF_CPU_THROTTLE ?? "1"));
const SCROLL_PROFILE_CYCLES = Math.max(1, Number.parseInt(process.env.PERF_SCROLL_CYCLES ?? "2", 10));
const SCROLL_PROFILE_TIMEOUT_MS = 20_000;

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

function metricMap(metrics) {
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(before, after) {
  return {
    layoutCount: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0),
    recalcStyleCount: (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0),
    layoutDurationMs: round(((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1_000),
    recalcStyleDurationMs: round(((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1_000),
    taskDurationMs: round(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1_000),
    scriptDurationMs: round(((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1_000),
    jsHeapDeltaMiB: bytesToMiB((after.JSHeapUsedSize ?? 0) - (before.JSHeapUsedSize ?? 0)),
  };
}

test("large main-page baseline", async ({ page, browser }) => {
  await page.addInitScript({ content: LISTENER_INSTRUMENTATION });
  const cdp = await page.context().newCDPSession(page);
  await Promise.all([cdp.send("Performance.enable"), cdp.send("HeapProfiler.enable")]);
  if (CPU_THROTTLE_RATE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });

  const samples = [];
  const interactionTimings = {};
  const scrollProfiles = {};
  const dragStartProfiles = {};
  const dropProfiles = {};
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

  const profileScroll = async (name, selector, axis = "vertical") => {
    await page.locator(selector).evaluate((element, scrollAxis) => {
      element[scrollAxis === "horizontal" ? "scrollLeft" : "scrollTop"] = 0;
    }, axis);
    await page.waitForTimeout(100);
    const beforeMetrics = metricMap((await cdp.send("Performance.getMetrics")).metrics);
    const browserProfile = await page.evaluate(async ({ selector, axis, cycles, timeoutMs }) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing scroll profile target: ${selector}`);
      const positionProperty = axis === "horizontal" ? "scrollLeft" : "scrollTop";
      const extentProperty = axis === "horizontal" ? "scrollWidth" : "scrollHeight";
      const clientExtentProperty = axis === "horizontal" ? "clientWidth" : "clientHeight";

      const resourceSnapshot = () => {
        const images = performance.getEntriesByType("resource").filter((entry) => entry.initiatorType === "img");
        return {
          count: images.length,
          transferBytes: images.reduce((sum, entry) => sum + entry.transferSize, 0),
          decodedBodyBytes: images.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        };
      };
      const domSnapshot = () => ({
        domNodes: document.querySelectorAll("*").length,
        boardCards: document.querySelectorAll("k-board k-card").length,
        boardLists: document.querySelectorAll("k-board k-list").length,
        listCards: element.querySelectorAll("k-card").length,
        listCovers: element.querySelectorAll(".card-cover img").length,
        completeListCovers: [...element.querySelectorAll(".card-cover img")].filter((image) => image.complete).length,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      });

      const before = domSnapshot();
      const resourcesBefore = resourceSnapshot();
      const frames = [];
      const longTasks = [];
      const longAnimationFrames = [];
      let lastFrame = performance.now();
      let animationFrame = 0;
      const collectFrame = (now) => {
        frames.push(now - lastFrame);
        lastFrame = now;
        animationFrame = requestAnimationFrame(collectFrame);
      };
      animationFrame = requestAnimationFrame(collectFrame);

      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      longTaskObserver.observe({ type: "longtask", buffered: false });

      let longAnimationFrameObserver = null;
      if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
        longAnimationFrameObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longAnimationFrames.push({ duration: entry.duration, blockingDuration: entry.blockingDuration });
          }
        });
        longAnimationFrameObserver.observe({ type: "long-animation-frame", buffered: false });
      }

      const startedAt = performance.now();
      let lastStepAt = startedAt;
      let direction = 1;
      let completedEdges = 0;
      while (completedEdges < cycles * 2 && performance.now() - startedAt < timeoutMs) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        const elapsed = Math.min(50, now - lastStepAt);
        lastStepAt = now;
        element[positionProperty] += direction * elapsed * 2.4;
        const atEnd = direction > 0 && element[positionProperty] + element[clientExtentProperty] >= element[extentProperty] - 2;
        const atStart = direction < 0 && element[positionProperty] <= 1;
        if (atEnd || atStart) {
          direction *= -1;
          completedEdges += 1;
        }
      }
      await new Promise(requestAnimationFrame);
      cancelAnimationFrame(animationFrame);
      longTaskObserver.disconnect();
      longAnimationFrameObserver?.disconnect();

      const wallDurationMs = performance.now() - startedAt;
      const sortedFrames = frames.slice(1).sort((a, b) => a - b);
      const percentile = (fraction) => sortedFrames[Math.min(sortedFrames.length - 1, Math.floor(sortedFrames.length * fraction))] ?? 0;
      const resourcesAfter = resourceSnapshot();
      return {
        wallDurationMs,
        completedEdges,
        frames: sortedFrames.length,
        framesPerSecond: sortedFrames.length / (wallDurationMs / 1_000),
        frameP50Ms: percentile(0.5),
        frameP95Ms: percentile(0.95),
        frameP99Ms: percentile(0.99),
        maxFrameMs: sortedFrames.at(-1) ?? 0,
        framesOver20Ms: sortedFrames.filter((duration) => duration > 20).length,
        framesOver33Ms: sortedFrames.filter((duration) => duration > 33.3).length,
        framesOver50Ms: sortedFrames.filter((duration) => duration > 50).length,
        estimatedDroppedFrames: sortedFrames.reduce((sum, duration) => sum + Math.max(0, Math.round(duration / 16.667) - 1), 0),
        longTasks: longTasks.length,
        longTaskDurationMs: longTasks.reduce((sum, duration) => sum + duration, 0),
        longAnimationFrames: longAnimationFrames.length,
        longAnimationFrameDurationMs: longAnimationFrames.reduce((sum, entry) => sum + entry.duration, 0),
        longAnimationFrameBlockingMs: longAnimationFrames.reduce((sum, entry) => sum + entry.blockingDuration, 0),
        before,
        after: domSnapshot(),
        imageRequests: resourcesAfter.count - resourcesBefore.count,
        imageTransferMiB: (resourcesAfter.transferBytes - resourcesBefore.transferBytes) / 1024 / 1024,
        imageDecodedBodyMiB: (resourcesAfter.decodedBodyBytes - resourcesBefore.decodedBodyBytes) / 1024 / 1024,
      };
    }, { selector, axis, cycles: SCROLL_PROFILE_CYCLES, timeoutMs: SCROLL_PROFILE_TIMEOUT_MS });
    const afterMetrics = metricMap((await cdp.send("Performance.getMetrics")).metrics);
    return {
      name,
      ...Object.fromEntries(Object.entries(browserProfile).map(([key, value]) => [key, typeof value === "number" ? round(value, 2) : value])),
      ...metricDelta(beforeMetrics, afterMetrics),
    };
  };

  const profileDragStart = async (name) => {
    const card = page.locator("k-board k-list").first().locator("k-card:not(.cdk-drag-disabled)").first();
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    if (!box) throw new Error(`Missing drag card bounds for ${name}`);
    const beforeMetrics = metricMap((await cdp.send("Performance.getMetrics")).metrics);
    await page.evaluate(() => {
      const state = { pointerDownAt: null, previewAt: null, firstPreviewFrameAt: null, longTasks: [] };
      window.__kaneraDragStartProfile = state;
      document.addEventListener("pointerdown", () => { state.pointerDownAt = performance.now(); }, { capture: true, once: true });
      state.observer = new MutationObserver(() => {
        if (state.previewAt !== null || !document.querySelector(".cdk-drag-preview")) return;
        state.previewAt = performance.now();
        requestAnimationFrame(() => { state.firstPreviewFrameAt = performance.now(); });
      });
      state.observer.observe(document.body, { childList: true, subtree: true });
      state.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      });
      state.longTaskObserver.observe({ type: "longtask", buffered: false });
    });
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(40, box.height / 2));
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + Math.min(40, box.height / 2) + 12);
    await expect(page.locator(".cdk-drag-preview")).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(() => window.__kaneraDragStartProfile?.firstPreviewFrameAt !== null);
    const receivingLists = await page.locator(".cdk-drop-list-receiving").count();
    await page.mouse.up();
    await expect(page.locator(".cdk-drag-preview")).toHaveCount(0);
    const browserProfile = await page.evaluate(() => {
      const state = window.__kaneraDragStartProfile;
      state.observer.disconnect();
      state.longTaskObserver.disconnect();
      delete window.__kaneraDragStartProfile;
      return {
        pointerDownToPreviewMs: state.previewAt - state.pointerDownAt,
        pointerDownToFirstPreviewFrameMs: state.firstPreviewFrameAt - state.pointerDownAt,
        longTasks: state.longTasks.length,
        longTaskDurationMs: state.longTasks.reduce((sum, duration) => sum + duration, 0),
      };
    });
    const afterMetrics = metricMap((await cdp.send("Performance.getMetrics")).metrics);
    return {
      name,
      ...Object.fromEntries(Object.entries(browserProfile).map(([key, value]) => [key, round(value, 2)])),
      receivingLists,
      ...metricDelta(beforeMetrics, afterMetrics),
    };
  };

  const profileDrop = async (name) => {
    const list = page.locator("k-board k-list").first();
    const source = list.locator("k-card:not(.cdk-drag-disabled):has(.card-cover)").first();
    const target = list.locator("k-card:not(.cdk-drag-disabled)").nth(4);
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) throw new Error(`Missing covered-card drop bounds for ${name}`);

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + Math.min(40, sourceBox.height / 2));
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + Math.min(40, sourceBox.height / 2) + 12);
    await expect(page.locator(".cdk-drag-preview")).toBeVisible({ timeout: 10_000 });
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 4 });

    const beforeMetrics = metricMap((await cdp.send("Performance.getMetrics")).metrics);
    await page.evaluate(() => {
      const state = { releaseAt: null, previewRemovedAt: null, settledAt: null, settleQueued: false, longTasks: [] };
      window.__kaneraDropProfile = state;
      document.addEventListener("pointerup", () => { state.releaseAt = performance.now(); }, { capture: true, once: true });
      state.observer = new MutationObserver(() => {
        if (state.releaseAt === null || document.querySelector(".cdk-drag-preview")) return;
        state.previewRemovedAt ??= performance.now();
        if (state.settleQueued || document.querySelector(".cdk-drag-animating")) return;
        state.settleQueued = true;
        requestAnimationFrame(() => requestAnimationFrame(() => { state.settledAt = performance.now(); }));
      });
      state.observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      state.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      });
      state.longTaskObserver.observe({ type: "longtask", buffered: false });
    });

    await page.mouse.up();
    await expect(page.locator(".cdk-drag-preview")).toHaveCount(0);
    await page.waitForFunction(() => window.__kaneraDropProfile?.settledAt !== null);
    const browserProfile = await page.evaluate(() => {
      const state = window.__kaneraDropProfile;
      state.observer.disconnect();
      state.longTaskObserver.disconnect();
      delete window.__kaneraDropProfile;
      return {
        releaseToPreviewRemovedMs: state.previewRemovedAt - state.releaseAt,
        releaseToSettledFrameMs: state.settledAt - state.releaseAt,
        longTasks: state.longTasks.length,
        longTaskDurationMs: state.longTasks.reduce((sum, duration) => sum + duration, 0),
      };
    });
    const afterMetrics = metricMap((await cdp.send("Performance.getMetrics")).metrics);
    return {
      name,
      sourceHasCover: true,
      ...Object.fromEntries(Object.entries(browserProfile).map(([key, value]) => [key, round(value, 2)])),
      ...metricDelta(beforeMetrics, afterMetrics),
    };
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
  dragStartProfiles.initial = await profileDragStart("board/drag-start-initial");
  dropProfiles.initial = await profileDrop("board/drop-initial");

  const firstListSelector = "k-board k-list:first-of-type .cards";
  const boardListsSelector = "k-board .lists";
  scrollProfiles.horizontalFirstTraversal = await profileScroll("board/horizontal-scroll-first-traversal", boardListsSelector, "horizontal");
  await navigate(`/b/${BOARD_ID}`, async () => await page.locator("k-board k-list").count() >= 8 && await page.locator("k-board k-card").count() >= 200);
  scrollProfiles.firstTraversal = await profileScroll("board/vertical-scroll-first-traversal", firstListSelector);
  // Restore the exact pre-traversal mount state so the existing mount-all metric remains
  // comparable with historical results rather than starting with one fully mounted list.
  await navigate(`/b/${BOARD_ID}`, async () => await page.locator("k-board k-list").count() >= 8 && await page.locator("k-board k-card").count() >= 200);

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
  dragStartProfiles.fullyMounted = await profileDragStart("board/drag-start-1,000-mounted");
  dropProfiles.fullyMounted = await profileDrop("board/drop-1,000-mounted");
  scrollProfiles.horizontalSteadyState = await profileScroll("board/horizontal-scroll-steady-state", boardListsSelector, "horizontal");
  scrollProfiles.steadyState = await profileScroll("board/vertical-scroll-steady-state", firstListSelector);

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
    schemaVersion: 3,
    label,
    capturedAt,
    baseUrl: process.env.PERF_BASE_URL ?? "http://localhost:4200",
    fixture: { boards: 40, lists: EXPECTED_LISTS, cards: EXPECTED_CARDS, covers: EXPECTED_COVERS, richCards: 60, members: 6, labels: 12, customFields: 7 },
    environment: {
      browserVersion: browser.version(),
      browserPath: browser.browserType().executablePath(),
      ...runtime,
    },
    options: { navigationRuns: NAVIGATION_RUNS, cpuThrottleRate: CPU_THROTTLE_RATE, scrollCycles: SCROLL_PROFILE_CYCLES },
    interactionTimings: Object.fromEntries(Object.entries(interactionTimings).map(([key, value]) => [key, round(value, 2)])),
    dragStartProfiles,
    dropProfiles,
    scrollProfiles,
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
  console.log("Scroll profiles:");
  console.table(Object.values(scrollProfiles).map((profile) => ({
    profile: profile.name,
    "p95 ms": profile.frameP95Ms,
    "p99 ms": profile.frameP99Ms,
    "max ms": profile.maxFrameMs,
    ">33 ms": profile.framesOver33Ms,
    "dropped est.": profile.estimatedDroppedFrames,
    "long tasks": profile.longTasks,
    "script ms": profile.scriptDurationMs,
    "layout ms": profile.layoutDurationMs,
    "image reqs": profile.imageRequests,
    "lists before": profile.before.boardLists,
    "lists after": profile.after.boardLists,
    "cards before": profile.before.boardCards,
    "cards after": profile.after.boardCards,
  })));
  console.log("Drag-start profiles:");
  console.table(Object.values(dragStartProfiles).map((profile) => ({
    profile: profile.name,
    "preview ms": profile.pointerDownToPreviewMs,
    "first frame ms": profile.pointerDownToFirstPreviewFrameMs,
    "receiving lists": profile.receivingLists,
    "script ms": profile.scriptDurationMs,
    "layout ms": profile.layoutDurationMs,
    "style ms": profile.recalcStyleDurationMs,
    "long tasks": profile.longTasks,
  })));
  console.log("Drop profiles:");
  console.table(Object.values(dropProfiles).map((profile) => ({
    profile: profile.name,
    "preview removed ms": profile.releaseToPreviewRemovedMs,
    "settled frame ms": profile.releaseToSettledFrameMs,
    "script ms": profile.scriptDurationMs,
    "layout ms": profile.layoutDurationMs,
    "style ms": profile.recalcStyleDurationMs,
    "long tasks": profile.longTasks,
  })));
  console.log("KANERA_PERF_RESULT=" + JSON.stringify(result));
  const safeTimestamp = capturedAt.replaceAll(":", "-");
  const safeLabel = label.replaceAll(/[^a-zA-Z0-9_-]+/g, "-").replaceAll(/^-|-$/g, "") || "benchmark";
  const outputPath = process.env.PERF_OUTPUT ?? path.join(__dirname, "results", `${safeTimestamp}-${safeLabel}.json`);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Saved timestamped result: ${outputPath}`);
});
