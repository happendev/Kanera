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
