import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("apps/mcp/server.json", root), "utf8"));
const source = await readFile(new URL("apps/mcp/src/server.ts", root), "utf8");
const origin = process.env.KANERA_SITE_URL ?? "https://www.kanera.app";

async function get(path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${path} returned ${response.status}`);
  return response.text();
}

// Registry releases are immutable. Require the matching public metadata and inventory
// before publishing, so a merged but undeployed docs update cannot silently pass.
const [card, plugin, catalog, inventory] = await Promise.all([
  get("/.well-known/mcp/server-card.json").then(JSON.parse),
  get("/plugin.json").then(JSON.parse),
  get("/.well-known/ai-catalog.json").then(JSON.parse),
  get("/docs/ai-mcp-tools.md"),
]);
assert.equal(card.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
for (const field of ["name", "title", "description", "version", "remotes"]) {
  assert.deepEqual(card[field], manifest[field], `Published server card ${field} is stale`);
}
assert.equal(plugin.version, manifest.version, "Published plugin version is stale");
for (const suffix of [":mcp:kanera", ":plugin:kanera"]) {
  assert.equal(catalog.entries.find((entry) => entry.identifier.endsWith(suffix))?.version,
    manifest.version, `Published catalog ${suffix} version is stale`);
}
const tools = [...source.matchAll(/registerKaneraTool\(server,\s*"([^"]+)"/g)].map((match) => match[1]);
const prompts = [...source.matchAll(/server\.registerPrompt\("([^"]+)"/g)].map((match) => match[1]);
const published = [...inventory.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
assert.ok(tools.length > 0 && prompts.length > 0, "No source tools or prompts found");
assert.deepEqual(published.sort(), [...tools, ...prompts].sort(), "Published MCP inventory is stale");
console.log(`Published MCP documentation and discovery match release ${manifest.version}.`);
