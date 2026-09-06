import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalStorage } from "./local.js";

// Regression guard for path traversal: the storage key allowlist keeps "." characters, so "..
// segments must be rejected outright rather than joined into the tenant directory.
void test("local storage rejects traversing keys before touching the filesystem", async () => {
  const storage = createLocalStorage("00000000-0000-4000-8000-000000000001");
  for (const key of ["../../etc/passwd", "cards/../../../etc/passwd", "./x", "a//b", "../x"]) {
    await assert.rejects(storage.getObject(key), /invalid storage key/, key);
    await assert.rejects(storage.get(key), /invalid storage key/, key);
    await assert.rejects(storage.delete(key), /invalid storage key/, key);
    await assert.rejects(storage.put(key, Buffer.from("x"), "text/plain"), /invalid storage key/, key);
  }
});
