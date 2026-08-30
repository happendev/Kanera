import assert from "node:assert/strict";
import test from "node:test";
import { applyPositionals, matchAlias } from "./aliases.js";
import { expandFlagPaths, parseArgs } from "./args.js";
import { EXIT } from "./errors.js";
import { agentsSection, skillDocument } from "./skill.js";
import { openToolSession } from "./tools.js";

/**
 * The skill document is prose an agent takes literally, so its examples are contract, not
 * decoration. These tests replay every fenced `kanera …` line through the real argument parser,
 * alias table, and tool catalog: renaming an alias, moving a tool argument, or changing an exit
 * code breaks the build here instead of shipping instructions that teach agents commands which
 * no longer exist.
 */

/** Commands dispatched by cli.ts itself rather than resolved through the alias table. */
const BUILTIN_COMMANDS = new Set(["auth", "commands", "help", "setup", "doctor", "skill", "call", "mcp"]);

function fencedCommandLines(document: string): string[] {
  const lines: string[] = [];
  for (const [, block] of document.matchAll(/```bash\n([\s\S]*?)```/gu)) {
    for (const raw of (block ?? "").split("\n")) {
      const line = raw.replace(/#.*$/u, "").trim();
      if (line.startsWith("kanera ")) lines.push(line);
    }
  }
  return lines;
}

/** Split like a shell would for the simple grammar the examples use: bare words and "quoted". */
function shellTokens(line: string): string[] {
  return (line.match(/"[^"]*"|\S+/gu) ?? []).map((token) =>
    token.startsWith('"') ? token.slice(1, -1) : token,
  );
}

void test("every command the skill teaches parses, resolves, and only uses real tool arguments", async () => {
  const session = await openToolSession({
    apiKey: "kanera_u_offline_catalog_probe",
    publicApiUrl: "http://127.0.0.1:9",
  });
  try {
    const documents = [skillDocument(), agentsSection()];
    const lines = documents.flatMap(fencedCommandLines);
    assert.ok(lines.length >= 10, "the skill document lost its examples");

    for (const line of lines) {
      const parsed = parseArgs(shellTokens(line).slice(1));
      const command = parsed.positionals[0]!;

      if (BUILTIN_COMMANDS.has(command)) {
        // `kanera help <tool>` names a concrete tool in one example; placeholders are skipped.
        const named = parsed.positionals[1];
        if (command === "help" && named !== undefined && !named.startsWith("<")) {
          assert.ok(session.tools.some((tool) => tool.name === named), `"${line}" names unknown tool ${named}`);
        }
        continue;
      }

      const match = matchAlias(parsed.positionals);
      assert.ok(match, `the skill documents "${line}" but no alias matches it`);
      const tool = session.tool(match.alias.tool);
      const payload = { ...applyPositionals(match.alias, match.rest), ...expandFlagPaths(parsed.flags) };
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      for (const name of Object.keys(payload)) {
        assert.ok(properties.includes(name), `"${line}" passes ${name}, which ${tool.name} does not accept`);
      }
    }

    // Any tool named anywhere in the documents (prose included) must exist in the catalog.
    for (const [name] of documents.join("\n").matchAll(/kanera_[a-z_]+/gu)) {
      assert.ok(session.tools.some((tool) => tool.name === name), `the skill mentions unknown tool ${name}`);
    }
  } finally {
    await session.close();
  }
});

void test("the skill's exit-code table matches the CLI's exit-code contract exactly", () => {
  const documented = [...skillDocument().matchAll(/^\| (\d+) \|/gmu)].map(([, code]) => Number(code));
  const actual = Object.values(EXIT);
  assert.deepEqual(
    [...documented].sort((a, b) => a - b),
    [...actual].sort((a, b) => a - b),
  );
});

void test("the skill document carries the frontmatter Claude Code requires", () => {
  const document = skillDocument();
  assert.match(document, /^---\nname: kanera\ndescription: .+\n---\n/u);
});
