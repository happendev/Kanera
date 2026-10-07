import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { statSync } from "node:fs";
import { configPath, readConfig, readRepoConfig, saveProfile, validateApiUrl, withConfigLock, writeConfig } from "./config.js";

void test("repository config may select a profile but cannot select a credential destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanera-cli-repo-config-"));
  try {
    await mkdir(join(root, ".kanera"));
    await writeFile(join(root, ".kanera", "config.json"), JSON.stringify({
      profile: "agent",
      url: "https://credential-thief.example",
    }));
    assert.deepEqual(readRepoConfig(root), { profile: "agent" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("API origins require HTTPS except for loopback development", () => {
  assert.equal(validateApiUrl("https://api.kanera.app/"), "https://api.kanera.app");
  assert.equal(validateApiUrl("http://127.0.0.1:3001"), "http://127.0.0.1:3001");
  assert.equal(validateApiUrl("http://localhost:3001"), "http://localhost:3001");
  assert.throws(() => validateApiUrl("http://kanera.example"), /refusing insecure/u);
  assert.throws(() => validateApiUrl("https://api.kanera.app/proxy"), /must be an origin/u);
});

/* Automatic refresh writes while other processes read without locking. A browser test cannot
 * reliably hit the truncate/write window. This stress regression catches empty/partial JSON and
 * verifies that replacing an existing credential file preserves owner-only permissions.
 */
void test("credential publication stays readable and owner-only during concurrent reads", async () => {
  const previous = process.env.XDG_CONFIG_HOME;
  const home = await mkdtemp(join(tmpdir(), "kanera-config-publication-"));
  process.env.XDG_CONFIG_HOME = home;
  let reader: Worker | undefined;
  const control = new Int32Array(new SharedArrayBuffer(8));
  try {
    await saveProfile("default", { apiKey: "test-key" }, true);
    control[0] = 1;
    reader = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      const control = new Int32Array(workerData.control);
      let reads = 0, failures = 0;
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      while (Atomics.load(control, 0)) {
        try { JSON.parse(readFileSync(workerData.path, 'utf8')); } catch { failures++; }
        reads++;
      }
      parentPort.postMessage({ reads, failures });
    `, { eval: true, workerData: { path: configPath(), control: control.buffer } });
    const result = new Promise<{ reads: number; failures: number }>((resolve, reject) => {
      reader!.once("message", resolve);
      reader!.once("error", reject);
    });
    assert.notEqual(Atomics.wait(control, 1, 0, 10_000), "timed-out");
    await withConfigLock(() => {
      const config = readConfig();
      for (let i = 0; i < 500; i++) {
        config.profiles.default!.label = `revision ${i}`;
        writeConfig(config);
      }
    });
    Atomics.store(control, 0, 0);
    const observed = await result;
    assert.ok(observed.reads > 0);
    assert.equal(observed.failures, 0);
    assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  } finally {
    Atomics.store(control, 0, 0);
    await reader?.terminate();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
