import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolCatalogCache } from "./tool-cache.js";

/* Real OAuth/revocation and live commands remain covered by cli-oauth E2E. These failures require
 * deliberately malformed storage or protocol hints: stale catalogue after server version change,
 * cross-endpoint/private-data reuse, expired cache use, corrupt/partial JSON, unwritable disk, or
 * invalidation ignoring a cached schema, or a server withdrawing public-cache permission. None
 * should stop a valid remote command from fetching.
 */
const key = { method: "tools/list", params: "", partition: '["kanera@4.0.0",""]' };
const entry = () => ({ value: JSON.stringify({ tools: [] }), scope: "public" as const, expiresAt: Date.now() + 60_000 });
const endpoint = "https://mcp.example.test/mcp";

void test("public catalogues survive a new process store with endpoint/version isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanera-tool-cache-"));
  try {
    const value = entry();
    await new ToolCatalogCache(endpoint, directory).set(key, value);
    assert.equal((await new ToolCatalogCache(endpoint, directory).get(key))?.value, value.value);
    assert.equal(await new ToolCatalogCache(endpoint, directory).get({ ...key, partition: '["kanera@5.0.0",""]' }), undefined);
    assert.equal(await new ToolCatalogCache("https://other.example.test/mcp", directory).get(key), undefined);
    const [name] = await readdir(directory);
    assert.equal((await stat(join(directory, name!))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test("private, unhinted and expired results are never persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanera-tool-cache-"));
  try {
    for (const value of [{ ...entry(), scope: "private" as const }, { value: entry().value }, { ...entry(), expiresAt: Date.now() - 1 }]) {
      await new ToolCatalogCache(endpoint, directory).set(key, entry());
      await new ToolCatalogCache(endpoint, directory).set(key, value);
      assert.equal(await new ToolCatalogCache(endpoint, directory).get(key), undefined);
    }
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test("schema invalidation removes both in-memory and persisted catalogue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanera-tool-cache-"));
  try {
    const cache = new ToolCatalogCache(endpoint, directory);
    await cache.set(key, entry());
    await cache.delete(key);
    assert.equal(await cache.get(key), undefined);
    assert.equal(await new ToolCatalogCache(endpoint, directory).get(key), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test("corrupt, expired and inaccessible cache files become misses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanera-tool-cache-"));
  try {
    await new ToolCatalogCache(endpoint, directory).set(key, entry());
    const [name] = await readdir(directory);
    const invalidCatalogues = [{ tools: [null] }, { tools: [{}] }, { tools: [{ name: "bad", inputSchema: null }] }];
    for (const data of ["{truncated", JSON.stringify({ key, entry: { ...entry(), expiresAt: Date.now() - 1 } }), JSON.stringify({ key, entry: { ...entry(), value: "garbage" } }), ...invalidCatalogues.map(value => JSON.stringify({ key, entry: { ...entry(), value: JSON.stringify(value) } }))]) {
      await writeFile(join(directory, name!), data);
      assert.equal(await new ToolCatalogCache(endpoint, directory).get(key), undefined);
    }
    const notDirectory = join(directory, "file");
    await writeFile(notDirectory, "not a directory");
    await new ToolCatalogCache(endpoint, notDirectory).set(key, entry());
    assert.equal(await new ToolCatalogCache(endpoint, notDirectory).get(key), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
