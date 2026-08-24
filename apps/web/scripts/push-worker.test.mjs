import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../public/push-worker.js", import.meta.url), "utf8");

function listenerCount(eventName) {
  return source.match(new RegExp(`self\\.addEventListener\\(\\s*["']${eventName}["']\\s*,`, "gu"))?.length ?? 0;
}

void test("push worker leaves notification display and clicks exclusively to Angular", () => {
  assert.match(source, /^importScripts\(["']\.\/ngsw-worker\.js["']\);/u);
  assert.equal(listenerCount("push"), 0);
  assert.equal(listenerCount("notificationclick"), 0);

  assert.equal(listenerCount("fetch"), 1, "share-target listener must remain");
  assert.equal(listenerCount("activate"), 1, "navigation-preload listener must remain");
  assert.equal(listenerCount("pushsubscriptionchange"), 1, "subscription-refresh listener must remain");
  assert.match(source, /oldAuth/u, "subscription rotation must prove possession of the old auth secret");
  assert.match(source, /if \(!response\.ok\)/u, "HTTP failures must trigger the open-client resync fallback");
});
