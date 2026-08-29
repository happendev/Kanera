import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
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

void test("the packed CLI installs and runs without workspace or development dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "kanera-cli-package-"));
  try {
    const sourcePackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const standalone = join(root, "kanera.mjs");
    await copyFile(join(process.cwd(), "dist", "kanera.mjs"), standalone);
    await chmod(standalone, 0o755);
    assert.equal(run(standalone, ["--version"], { cwd: root }).trim(), sourcePackage.version);
    const standaloneCatalog = JSON.parse(run(standalone, ["commands", "--quiet"], {
      cwd: root,
      env: { XDG_CONFIG_HOME: join(root, "standalone-config") },
    }));
    assert.ok(standaloneCatalog.tools.length > 0);

    const packedJson = run("npm", ["pack", "--json", "--pack-destination", root], { cwd: process.cwd() });
    const [{ filename }] = JSON.parse(packedJson);
    const tarball = join(root, filename);
    const installDir = join(root, "install");
    const configDir = join(root, "config");
    await mkdir(installDir);
    run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], { cwd: installDir });

    const executable = join(installDir, "node_modules", ".bin", process.platform === "win32" ? "kanera.cmd" : "kanera");
    assert.equal(run(executable, ["--version"], { cwd: installDir }).trim(), sourcePackage.version);

    const cleanEnv = { ...process.env, XDG_CONFIG_HOME: configDir };
    delete cleanEnv.KANERA_API_KEY;
    delete cleanEnv.KANERA_PUBLIC_API_URL;
    const catalog = JSON.parse(run(executable, ["commands", "--quiet"], { cwd: installDir, env: cleanEnv }));
    assert.ok(catalog.tools.length > 0);
    assert.ok(catalog.tools.every((tool) => tool.inputSchema && typeof tool.inputSchema === "object"));

    const installedPackage = JSON.parse(readFileSync(join(installDir, "node_modules", "@kanera", "cli", "package.json"), "utf8"));
    assert.deepEqual(installedPackage.dependencies ?? {}, {});
    assert.equal(existsSync(join(installDir, "node_modules", "@kanera", "mcp")), false);
    assert.equal(existsSync(join(installDir, "node_modules", "tsx")), false);
    assert.equal(existsSync(join(installDir, "node_modules", "@kanera", "cli", "dist", "LICENSE")), true);

    // The executable bundles MIT/Apache/BSD/ISC code whose licenses require their notices to ship
    // with redistributed copies; the build collects them from the bundle's metafile.
    const notices = readFileSync(join(installDir, "node_modules", "@kanera", "cli", "dist", "THIRD_PARTY_NOTICES.md"), "utf8");
    for (const bundled of ["@modelcontextprotocol/sdk", "zod", "prom-client"]) {
      assert.ok(notices.includes(`## ${bundled}@`), `THIRD_PARTY_NOTICES.md is missing ${bundled}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
