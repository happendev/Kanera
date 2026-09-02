import assert from "node:assert/strict";
import test from "node:test";
import { applyPositionals, COMMAND_ALIASES, matchAlias } from "./aliases.js";
import { coerceArguments, coerceToSchema, openToolSession, type ToolSession } from "./tools.js";

void test("a two-word alias is not shadowed by its one-word prefix", () => {
  assert.equal(matchAlias(["card", "done", "MKT-42"])?.alias.tool, "cards.set_completion");
  assert.deepEqual(matchAlias(["card", "done", "MKT-42"])?.rest, ["MKT-42"]);
  assert.equal(matchAlias(["card", "MKT-42"])?.alias.tool, "cards.get");
});

void test("board create is a setup alias, not a board read with stray arguments", () => {
  const match = matchAlias(["board", "create", "ws-1", "Q4 launch"])!;
  assert.equal(match.alias.tool, "boards.create");
  assert.deepEqual(applyPositionals(match.alias, match.rest), { workspaceId: "ws-1", name: "Q4 launch" });
});

void test("positionals fill the alias arguments and defaults stay applied", () => {
  const match = matchAlias(["card", "done", "MKT-42"])!;
  assert.deepEqual(applyPositionals(match.alias, match.rest), { completed: true, cardId: "MKT-42" });
});

void test("extra positionals are rejected rather than silently changing only one target", () => {
  const match = matchAlias(["card", "MKT-42", "stray"])!;
  assert.throws(() => applyPositionals(match.alias, match.rest), /too many arguments/u);
});

/**
 * The alias table is hand-written against tool schemas that live in @kanera/mcp. This is the test
 * that keeps the two honest: renaming a tool or one of its arguments breaks the build here rather
 * than at a user's terminal. The session needs no network — listTools is answered in process.
 */
void test("every alias targets a real tool and only maps real arguments", async () => {
  const session: ToolSession = await openToolSession({
    apiKey: "kanera_u_offline_catalog_probe",
    publicApiUrl: "http://127.0.0.1:9",
  });
  try {
    for (const alias of COMMAND_ALIASES) {
      const tool = session.tools.find((entry) => entry.name === alias.tool);
      assert.ok(tool, `alias "${alias.path.join(" ")}" targets unknown tool ${alias.tool}`);
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      for (const name of [...(alias.positionals ?? []), ...Object.keys(alias.defaults ?? {})]) {
        assert.ok(properties.includes(name), `alias "${alias.path.join(" ")}" maps ${name}, which ${alias.tool} does not accept`);
      }
    }
  } finally {
    await session.close();
  }
});

void test("shell strings are coerced by the schema, not by how they look", () => {
  // A card key can look numeric and an id can look boolean; only the schema may decide.
  assert.equal(coerceToSchema("25", { type: "integer" }), 25);
  assert.equal(coerceToSchema("true", { type: "boolean" }), true);
  assert.equal(coerceToSchema("false", { type: "boolean" }), false);
  assert.equal(coerceToSchema("42", { type: "string" }), "42");
  assert.deepEqual(coerceToSchema("a", { type: "array", items: { type: "string" } }), ["a"]);
  assert.deepEqual(coerceToSchema(["1", "2"], { type: "array", items: { type: "number" } }), [1, 2]);
  assert.deepEqual(coerceToSchema({ limit: "5" }, { type: "object", properties: { limit: { type: "number" } } }), { limit: 5 });
});

void test("an argument the schema does not describe is passed through untouched", () => {
  // Forwarding it lets the server produce the precise validation message instead of the CLI
  // inventing a worse one.
  assert.equal(coerceToSchema("whatever", undefined), "whatever");
  assert.equal(coerceToSchema("whatever", {}), "whatever");
});

void test("tool arguments reject unknown and missing top-level fields as usage errors", async () => {
  const session = await openToolSession({
    apiKey: "kanera_u_offline_catalog_probe",
    publicApiUrl: "http://127.0.0.1:9",
  });
  try {
    const tool = session.tool("cards.get");
    assert.throws(() => coerceArguments(tool, {}), /missing required argument/u);
    assert.throws(() => coerceArguments(tool, { cardId: "MKT-42", typo: true }), /unknown argument/u);
  } finally {
    await session.close();
  }
});
