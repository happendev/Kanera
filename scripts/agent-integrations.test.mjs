import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonicalSkillPath = new URL("../integrations/skills/kanera/SKILL.md", import.meta.url);
const canonicalOpenAiPath = new URL("../integrations/skills/kanera/agents/openai.yaml", import.meta.url);
const pluginRoot = new URL("../integrations/plugins/kanera/", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

void test("the Codex plugin bundles the canonical Kanera skill", async () => {
  const [canonicalSkill, bundledSkill, canonicalOpenAi, bundledOpenAi] = await Promise.all([
    readFile(canonicalSkillPath, "utf8"),
    readFile(new URL("skills/kanera/SKILL.md", pluginRoot), "utf8"),
    readFile(canonicalOpenAiPath, "utf8"),
    readFile(new URL("skills/kanera/agents/openai.yaml", pluginRoot), "utf8"),
  ]);

  assert.equal(bundledSkill, canonicalSkill);
  assert.equal(bundledOpenAi, canonicalOpenAi);
  assert.match(canonicalSkill, /npx -y @kanera\/cli commands/u);
  assert.match(canonicalSkill, /npm install --global @kanera\/cli/u);
});

void test("the Codex plugin advertises the registered Kanera app", async () => {
  const [manifest, app, server] = await Promise.all([
    readJson(new URL(".codex-plugin/plugin.json", pluginRoot)),
    readJson(new URL(".app.json", pluginRoot)),
    readJson(new URL("../apps/mcp/server.json", import.meta.url)),
  ]);

  assert.equal(manifest.name, "kanera");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  assert.match(server.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.apps, "./.app.json");
  assert.deepEqual(manifest.interface.capabilities, ["Read", "Write"]);
  assert.ok(manifest.interface.defaultPrompt.some((prompt) => prompt.includes("DEV-938")));
  assert.match(manifest.description, /cards/u);
  assert.match(app.apps.kanera.id, /^asdk_app_[a-z0-9]+$/u);
});

void test("MCP registry releases trigger the publishing workflow", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish-mcp.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /release:\s*\n\s+types: \[published\]/u);
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'mcp-v'\)/u);
  assert.doesNotMatch(workflow, /github\.event_name == 'push'/u);
});
