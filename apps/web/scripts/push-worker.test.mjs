import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../public/push-worker.js", import.meta.url), "utf8");

function listenerCount(eventName) {
  return source.match(new RegExp(`self\\.addEventListener\\(\\s*["']${eventName}["']\\s*,`, "gu"))?.length ?? 0;
}

void test("push worker handles card clicks before Angular and leaves notification display to Angular", () => {
  const clickHandler = source.indexOf('self.addEventListener("notificationclick"');
  const angularWorker = source.indexOf('importScripts("./ngsw-worker.js")');
  assert.ok(clickHandler >= 0 && angularWorker > clickHandler, "card click handler must register before Angular's worker");
  assert.match(source.slice(clickHandler, angularWorker), /event\.stopImmediatePropagation\(\)/u);
  assert.equal(listenerCount("push"), 0);
  assert.equal(listenerCount("notificationclick"), 1);

  assert.equal(listenerCount("fetch"), 1, "share-target listener must remain");
  assert.equal(listenerCount("activate"), 1, "navigation-preload listener must remain");
  assert.equal(listenerCount("pushsubscriptionchange"), 1, "subscription-refresh listener must remain");
  assert.match(source, /oldAuth/u, "subscription rotation must prove possession of the old auth secret");
  assert.match(source, /if \(!response\.ok\)/u, "HTTP failures must trigger the open-client resync fallback");
});

// Native notification activation and focus rejection cannot be reproduced reliably by synthetic
// browser clicks. Cover duplicate-tab fallbacks, focus/navigation ordering, window selection and
// Angular action ownership here; browser smoke checks cover the real worker and navigation.
async function clickWorker({ data, action = "", windows = [{ url: "https://kanera.test/home" }], openWindow = async () => null, scope = "https://kanera.test/" } = {}) {
  const { runInNewContext } = await import("node:vm");
  const listeners = new Map();
  const calls = [];
  const pending = [];
  let stopped = false;
  const self = {
    registration: { scope },
    addEventListener(name, listener) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(listener);
      listeners.set(name, handlers);
    },
    clients: {
      async matchAll() {
        calls.push("matchAll");
        return windows.map((window) => ({
          url: window.url,
          async focus() {
            calls.push(["focus", window.url]);
            if (window.focusError) throw window.focusError;
            if (window.focusGate) await window.focusGate;
            return this;
          },
          async navigate(url) {
            calls.push(["navigate", window.url, url]);
            window.onNavigate?.();
            if (window.navigateError) throw window.navigateError;
            return window.navigateResult === null ? null : { ...this, url };
          },
        }));
      },
      openWindow(url) {
        calls.push(["openWindow", url]);
        return openWindow(url);
      },
    },
  };
  runInNewContext(source, {
    self,
    URL,
    importScripts() { self.addEventListener("notificationclick", () => calls.push("angularClick")); },
  });
  const event = {
    action,
    notification: { data, close() { calls.push("close"); } },
    stopImmediatePropagation() { stopped = true; },
    waitUntil(promise) { pending.push(promise); },
  };
  for (const listener of listeners.get("notificationclick")) {
    listener(event);
    if (stopped) break;
  }
  const results = await Promise.allSettled(pending);
  return { calls, results };
}

function navigationData(url = "/o/acme/b/123?cardId=456", operation = "navigateLastFocusedOrOpen") {
  return { onActionClick: { default: { operation, url } } };
}

void test("desktop and PWA clicks reuse the most recent Kanera window with one focus request", async () => {
  for (const operation of ["navigateLastFocusedOrOpen", "openWindow"]) {
    const result = await clickWorker({ data: navigationData(undefined, operation) });
    assert.deepEqual(result.calls, [
      "close", "matchAll", ["focus", "https://kanera.test/home"],
      ["navigate", "https://kanera.test/home", "https://kanera.test/o/acme/b/123?cardId=456"],
    ]);
    assert.equal(result.results[0].status, "fulfilled");
  }
});

void test("clicks open a new window only when no Kanera window is available", async () => {
  const result = await clickWorker({ data: navigationData("home"), windows: [] });
  assert.deepEqual(result.calls, ["close", "matchAll", ["openWindow", "https://kanera.test/home"]]);
  assert.equal(result.results[0].status, "fulfilled", "a null openWindow result is supported");
});

void test("navigation actions resolve their own target and default to the registration scope", async () => {
  const result = await clickWorker({
    action: "view",
    data: { onActionClick: {
      default: { operation: "navigateLastFocusedOrOpen", url: "/home" },
      view: { operation: "navigateLastFocusedOrOpen" },
    } },
    windows: [],
  });
  assert.deepEqual(result.calls, ["close", "matchAll", ["openWindow", "https://kanera.test/"]]);
});

void test("other Angular operations and unmapped actions keep their click handler", async () => {
  for (const data of [undefined, {}, { onActionClick: { default: { operation: "sendRequest", url: "/api/read" } } }, { onActionClick: { default: { operation: "focusLastFocusedOrOpen", url: "/home" } } }]) {
    assert.deepEqual((await clickWorker({ data })).calls, ["angularClick"]);
  }
  const result = await clickWorker({ action: "other", data: navigationData() });
  assert.deepEqual(result.calls, ["angularClick"]);
});

void test("a rejected focus still navigates the existing window without opening a duplicate", async () => {
  const result = await clickWorker({ data: navigationData(), windows: [{ url: "https://kanera.test/home", focusError: new Error("Activation blocked") }] });
  assert.deepEqual(result.calls, [
    "close", "matchAll", ["focus", "https://kanera.test/home"],
    ["navigate", "https://kanera.test/home", "https://kanera.test/o/acme/b/123?cardId=456"],
  ]);
  assert.equal(result.results[0].status, "fulfilled");
});

void test("an already open destination is focused without reloading another tab", async () => {
  const url = "https://kanera.test/o/acme/b/123?cardId=456";
  const result = await clickWorker({ data: navigationData(), windows: [{ url: "https://kanera.test/home" }, { url }] });
  assert.deepEqual(result.calls, ["close", "matchAll", ["focus", url]]);
});

void test("a slow focus request does not hold up destination navigation", { timeout: 2_000 }, async () => {
  let releaseFocus;
  const focusGate = new Promise((resolve) => { releaseFocus = resolve; });
  const result = await clickWorker({ data: navigationData(), windows: [{ url: "https://kanera.test/home", focusGate, onNavigate: () => releaseFocus() }] });
  assert.equal(result.results[0].status, "fulfilled");
  assert.equal(result.calls.filter((call) => call[0] === "navigate").length, 1);
});

void test("navigation failure does not create another tab while a Kanera window exists", async () => {
  for (const failure of [{ navigateError: new Error("Uncontrolled client") }, { navigateResult: null }]) {
    const result = await clickWorker({ data: navigationData(), windows: [{ url: "https://kanera.test/home", ...failure }] });
    assert.equal(result.calls.some((call) => call[0] === "openWindow"), false);
    assert.equal(result.calls.filter((call) => call[0] === "focus").length, 1);
  }
});

void test("only windows inside this registration scope can be reused", async () => {
  const result = await clickWorker({
    data: navigationData("/app/card"), scope: "https://kanera.test/app/",
    windows: [{ url: "https://other.test/app/home" }, { url: "https://kanera.test/app-other/" }],
  });
  assert.deepEqual(result.calls, ["close", "matchAll", ["openWindow", "https://kanera.test/app/card"]]);
});

void test("a rejected window open does not trigger another activation or redisplay", async () => {
  const failure = new Error("Browser denied activation");
  const result = await clickWorker({ data: navigationData("/home"), windows: [], openWindow: async () => { throw failure; } });
  assert.deepEqual(result.calls, ["close", "matchAll", ["openWindow", "https://kanera.test/home"]]);
  assert.equal(result.results[0].status, "rejected");
  assert.equal(result.results[0].reason, failure);
});
