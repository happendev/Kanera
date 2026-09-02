import assert from "node:assert/strict";
import test from "node:test";
import { EXIT } from "./errors.js";
import { run } from "./cli.js";

/**
 * The credential resolver honours KANERA_API_KEY, so a developer with one exported would otherwise
 * see the "no credential" tests pass a real key through to a real API.
 */
async function withoutAmbientCredential<T>(body: () => T | Promise<T>): Promise<T> {
  const saved = process.env.KANERA_API_KEY;
  delete process.env.KANERA_API_KEY;
  try {
    return await body();
  } finally {
    if (saved !== undefined) process.env.KANERA_API_KEY = saved;
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
}

void test("leading passthrough separators from pnpm do not swallow the command line", async () => {
  // `pnpm cli -- --version` reaches the binary as `-- -- --version`, one per forwarding layer.
  const { io, out } = capture();
  assert.equal(await run(["--", "--", "--version"], io), EXIT.ok);
  assert.match(out.join(""), /^\d+\.\d+\.\d+/u);
});

void test("no arguments prints usage rather than failing", async () => {
  const { io, out } = capture();
  assert.equal(await run([], io), EXIT.ok);
  assert.match(out.join(""), /kanera auth login/u);
});

void test("an unknown command is a usage error, not a generic failure", async () => {
  const { io, err } = capture();
  assert.equal(await run(["nope"], io), EXIT.usage);
  assert.match(err.join(""), /unknown command/u);
});

void test("a missing credential exits 3 and says how to fix it", async () => {
  const { io, err } = capture();
  // A profile name that cannot exist keeps this independent of the developer's own config file.
  assert.equal(await withoutAmbientCredential(() => run(["whoami", "--profile", "kanera-cli-test-absent-profile"], io)), EXIT.unauthenticated);
  assert.match(err.join(""), /kanera auth login/u);
});

void test("catalog and structured help work before authentication", async () => {
  const catalog = capture();
  assert.equal(await withoutAmbientCredential(() => run(["commands", "--profile", "kanera-cli-test-absent-profile", "--json"], catalog.io)), EXIT.ok);
  const catalogData = JSON.parse(catalog.out.join("")) as { data: { tools: { inputSchema?: unknown }[] } };
  assert.ok(catalogData.data.tools.length > 0);
  assert.ok(catalogData.data.tools.every((tool) => tool.inputSchema !== undefined));

  const help = capture();
  assert.equal(await withoutAmbientCredential(() => run(["card", "--help", "--profile", "kanera-cli-test-absent-profile", "--json"], help.io)), EXIT.ok);
  const helpData = JSON.parse(help.out.join("")) as { data: { tool: string; inputSchema: unknown } };
  assert.equal(helpData.data.tool, "cards.get");
  assert.ok(helpData.data.inputSchema);
});

void test("surplus positionals and invalid JSON arguments are usage errors", async () => {
  const surplus = capture();
  assert.equal(await withoutAmbientCredential(() => run(["card", "MKT-42", "MKT-43"], surplus.io)), EXIT.usage);
  assert.match(surplus.err.join(""), /too many arguments/u);

  const invalidJson = capture();
  assert.equal(await run([
    "card", "MKT-42", "--api-key", "kanera_u_offline_catalog_probe", "--json-args", "[]",
  ], invalidJson.io), EXIT.usage);
  assert.match(invalidJson.err.join(""), /valid JSON object/u);
});

void test("missing tool arguments and command help do not become generic failures", async () => {
  const missing = capture();
  assert.equal(await run(["card", "--api-key", "kanera_u_offline_catalog_probe", "--json"], missing.io), EXIT.usage);
  assert.equal((JSON.parse(missing.err.join("")) as { error: { exitCode: number } }).error.exitCode, EXIT.usage);

  const help = capture();
  assert.equal(await run(["card", "done", "--help", "--json"], help.io), EXIT.ok);
  assert.equal((JSON.parse(help.out.join("")) as { data: { tool: string } }).data.tool, "cards.set_completion");
});

void test("failures are written to stderr so redirected stdout stays clean", async () => {
  const { io, out, err } = capture();
  await withoutAmbientCredential(() => run(["whoami", "--profile", "kanera-cli-test-absent-profile", "--json"], io));
  assert.equal(out.join(""), "");
  assert.equal((JSON.parse(err.join("")) as { ok: boolean }).ok, false);
});
