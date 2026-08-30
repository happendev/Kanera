import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRepoConfig, validateApiUrl } from "./config.js";

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
