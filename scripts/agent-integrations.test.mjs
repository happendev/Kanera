import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const canonicalSkillPath = new URL("../integrations/skills/kanera/SKILL.md", import.meta.url);
const canonicalOpenAiPath = new URL("../integrations/skills/kanera/agents/openai.yaml", import.meta.url);
const pluginRoot = new URL("../integrations/plugins/kanera/", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

void test("the plugin shares Kanera workflows but excludes standalone CLI setup", async () => {
  const [canonicalSkill, bundledSkill, canonicalOpenAi, bundledOpenAi] = await Promise.all([
    readFile(canonicalSkillPath, "utf8"),
    readFile(new URL("skills/kanera/SKILL.md", pluginRoot), "utf8"),
    readFile(canonicalOpenAiPath, "utf8"),
    readFile(new URL("skills/kanera/agents/openai.yaml", pluginRoot), "utf8"),
  ]);

  // The directory package uses OAuth/MCP only; standalone skills retain CLI setup for coding agents.
  // Keep the shared project workflows aligned while validating the submission's transport boundary.
  const workflowHeading = "## Resolve context";
  assert.ok(bundledSkill.includes(workflowHeading));
  assert.ok(canonicalSkill.includes(workflowHeading));
  assert.equal(
    bundledSkill.slice(bundledSkill.indexOf(workflowHeading)),
    canonicalSkill.slice(canonicalSkill.indexOf(workflowHeading)),
  );
  assert.doesNotMatch(bundledSkill, /```(?:bash|sh)|\bnpx\b|npm install|kanera auth login|KANERA_API_KEY/u);
  assert.equal(bundledOpenAi, canonicalOpenAi);
  assert.match(canonicalSkill, /npx -y @kanera\/cli commands/u);
  assert.match(canonicalSkill, /npm install --global @kanera\/cli/u);
});

void test("the submission plugin declares the hosted Kanera MCP server", async () => {
  const [manifest, mcp, mcpPackage, server, files] = await Promise.all([
    readJson(new URL(".codex-plugin/plugin.json", pluginRoot)),
    readJson(new URL(".mcp.json", pluginRoot)),
    readJson(new URL("../apps/mcp/package.json", import.meta.url)),
    readJson(new URL("../apps/mcp/server.json", import.meta.url)),
    readdir(pluginRoot, { recursive: true }),
  ]);

  assert.equal(manifest.name, "kanera");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  assert.match(server.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(mcpPackage.version, server.version);
  assert.equal(manifest.version, server.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.apps, undefined);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.ok(!files.some((file) => file.endsWith(".app.json")));
  assert.deepEqual(manifest.interface.capabilities, ["Read", "Write"]);
  assert.ok(manifest.interface.defaultPrompt.some((prompt) => prompt.includes("Kanera")));
  assert.match(manifest.description, /cards/u);
  assert.deepEqual(mcp.mcpServers, {
    kanera: { url: "https://mcp.kanera.app/mcp" },
  });
});

void test("MCP registry releases trigger the publishing workflow", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish-mcp.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /release:\s*\n\s+types: \[published\]/u);
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'mcp-v'\)/u);
  assert.match(workflow, /integrations\/plugins\/kanera\/\.codex-plugin\/plugin\.json/u);
  assert.doesNotMatch(workflow, /github\.event_name == 'push'/u);
});
