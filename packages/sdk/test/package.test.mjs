import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
    // `npm publish --dry-run` exports this setting to lifecycle scripts; the nested package test
    // must still create its disposable tarball in order to validate a real clean install.
    env: { ...process.env, npm_config_dry_run: "false", ...options.env },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

// Imports the installed package by name and exercises one request against a stub fetch, so the
// test proves what an integrator's Node resolves and sends — not what the workspace source does.
const VERIFY_SCRIPT = `
import { Kanera, KaneraApiError } from "@kanera/sdk";

let captured;
const kanera = new Kanera({
  apiKey: "kanera_u_package_test",
  fetch: async (url, init) => {
    captured = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ scope: "read" }), { status: 200 });
  },
});
const session = await kanera.session();
if (session.scope !== "read") throw new Error("unexpected session payload");
if (typeof KaneraApiError !== "function") throw new Error("errors module missing");
process.stdout.write(JSON.stringify(captured));
`;

void test("the packed SDK installs and runs without workspace or development dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanera-sdk-package-"));
  try {
    const sourcePackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const packedJson = run("npm", ["pack", "--json", "--pack-destination", root], { cwd: process.cwd() });
    const [{ filename }] = JSON.parse(packedJson);
    const tarball = join(root, filename);
    const installDir = join(root, "install");
    await mkdir(installDir);
    await writeFile(join(installDir, "package.json"), JSON.stringify({ name: "sdk-consumer", type: "module" }));
    run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], { cwd: installDir });

    const installed = join(installDir, "node_modules", "@kanera", "sdk");
    const installedPackage = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.deepEqual(installedPackage.dependencies ?? {}, {});
    assert.equal(existsSync(join(installed, "dist", "index.js")), true);
    assert.equal(existsSync(join(installed, "dist", "index.d.ts")), true);
    // The SDK is MIT (unlike the ELv2 repository) so integrators' license scanners pass it; npm
    // includes a package-root LICENSE in the tarball automatically, ignoring the files allowlist.
    assert.equal(installedPackage.license, "MIT");
    assert.match(readFileSync(join(installed, "LICENSE"), "utf8"), /^MIT License/);
    // Source must not ship: the exports map points at dist, and stray .ts files confuse bundlers.
    assert.equal(existsSync(join(installed, "src")), false);

    await writeFile(join(installDir, "verify.mjs"), VERIFY_SCRIPT);
    const captured = JSON.parse(run(process.execPath, ["verify.mjs"], { cwd: installDir }));
    assert.equal(captured.url, "https://api.kanera.app/api/v1/session");
    // The User-Agent version is a hardcoded constant in client.ts; this pins it to package.json so
    // a release that bumps the manifest but not the constant fails here instead of drifting.
    assert.equal(captured.headers["user-agent"], `kanera-sdk/${sourcePackage.version}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
