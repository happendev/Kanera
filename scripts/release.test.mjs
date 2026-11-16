import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./release.mjs", import.meta.url));
const releaseNotesScriptPath = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
const unreleasedNote = `---
title: A test release
summary: One sentence about the test release.
---

The lead paragraph.

![A test screenshot](media/unreleased/shot.jpg "medium")

## New features

- [Boards] Something new
`;
const releaseManifestPaths = [
  "package.json",
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/sdk/package.json",
  "packages/shared/package.json",
];
const independentManifestPaths = ["apps/cli/package.json", "apps/mcp/package.json", "apps/mcp/server.json"];
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "kanera-release-test-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(bin);
  await cp(scriptPath, path.join(repo, "scripts/release.mjs"));
  await cp(releaseNotesScriptPath, path.join(repo, "scripts/release-notes.mjs"));
  await mkdir(path.join(repo, "release-notes/media/unreleased"), { recursive: true });
  await writeFile(path.join(repo, "release-notes/unreleased.md"), unreleasedNote);
  await writeFile(path.join(repo, "release-notes/media/unreleased/shot.jpg"), "jpeg");

  for (const manifestPath of releaseManifestPaths) {
    const fullPath = path.join(repo, manifestPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${JSON.stringify({ name: manifestPath, version: "1.2.3" }, null, 2)}\n`);
  }
  for (const manifestPath of independentManifestPaths) {
    const fullPath = path.join(repo, manifestPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${JSON.stringify({ name: manifestPath, version: "9.9.9" }, null, 2)}\n`);
  }
  await writeFile(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  // The release also rewrites the SDK's hardcoded User-Agent version constant.
  await mkdir(path.join(repo, "packages/sdk/src"), { recursive: true });
  await writeFile(
    path.join(repo, "packages/sdk/src/client.ts"),
    'const before = 1;\nconst SDK_VERSION = "1.2.3";\nconst after = 2;\n',
  );

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Release Test"]);
  git(repo, ["config", "user.email", "release-test@example.com"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);

  return { root, repo, bin };
}

async function writeExecutable(filePath, contents) {
  await writeFile(filePath, contents);
  await chmod(filePath, 0o755);
}

async function runRelease(fixture, pnpmScript, gitScript) {
  await writeExecutable(path.join(fixture.bin, "pnpm"), pnpmScript);
  if (gitScript) await writeExecutable(path.join(fixture.bin, "git"), gitScript);

  return spawnSync(process.execPath, ["scripts/release.mjs"], {
    cwd: fixture.repo,
    encoding: "utf8",
    input: "3\ny\n",
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
}

async function assertRolledBack(fixture, initialHead, result) {
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Rollback complete\./);
  assert.equal(git(fixture.repo, ["rev-parse", "HEAD"]), initialHead);
  assert.equal(git(fixture.repo, ["status", "--porcelain"]), "");
  const manifest = JSON.parse(await readFile(path.join(fixture.repo, "package.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  const clientSource = await readFile(path.join(fixture.repo, "packages/sdk/src/client.ts"), "utf8");
  assert.match(clientSource, /const SDK_VERSION = "1\.2\.3";/);
  assert.equal(await readFile(path.join(fixture.repo, "release-notes/unreleased.md"), "utf8"), unreleasedNote);
  assert.ok(!existsSync(path.join(fixture.repo, "release-notes/1.2.4.md")));
  assert.ok(existsSync(path.join(fixture.repo, "release-notes/media/unreleased/shot.jpg")));
}

test("rolls back version and lockfile changes when validation fails", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initialHead = git(fixture.repo, ["rev-parse", "HEAD"]);
  const result = await runRelease(
    fixture,
    "#!/bin/sh\nif [ \"$1\" = \"install\" ]; then printf \"changed\\n\" > pnpm-lock.yaml; exit 0; fi\nexit 23\n",
  );

  await assertRolledBack(fixture, initialHead, result);
});

test("removes the release commit when tag creation fails", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initialHead = git(fixture.repo, ["rev-parse", "HEAD"]);
  const pnpm = "#!/bin/sh\nif [ \"$1\" = \"install\" ]; then printf \"changed\\n\" > pnpm-lock.yaml; fi\nexit 0\n";
  const gitWrapper = `#!/bin/sh
if [ "$1" = "tag" ] && [ "$2" = "-a" ]; then exit 42; fi
exec "${realGit}" "$@"
`;
  const result = await runRelease(fixture, pnpm, gitWrapper);

  await assertRolledBack(fixture, initialHead, result);
  const tag = spawnSync("git", ["rev-parse", "--verify", "refs/tags/v1.2.4"], { cwd: fixture.repo });
  assert.notEqual(tag.status, 0);
});

test("leaves independently versioned CLI and MCP manifests unchanged", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const pnpm = "#!/bin/sh\nif [ \"$1\" = \"install\" ]; then printf \"changed\\n\" > pnpm-lock.yaml; fi\nexit 0\n";
  const result = await runRelease(fixture, pnpm);

  assert.equal(result.status, 0, result.stderr);
  for (const manifestPath of releaseManifestPaths) {
    const manifest = JSON.parse(await readFile(path.join(fixture.repo, manifestPath), "utf8"));
    assert.equal(manifest.version, "1.2.4", manifestPath);
  }
  for (const manifestPath of independentManifestPaths) {
    const manifest = JSON.parse(await readFile(path.join(fixture.repo, manifestPath), "utf8"));
    assert.equal(manifest.version, "9.9.9", manifestPath);
  }
  const clientSource = await readFile(path.join(fixture.repo, "packages/sdk/src/client.ts"), "utf8");
  assert.match(clientSource, /const SDK_VERSION = "1\.2\.4";/);
  // Only the version constant changes; the rest of the file is untouched.
  assert.match(clientSource, /const before = 1;\nconst SDK_VERSION = "1\.2\.4";\nconst after = 2;\n/);
});

test("publishes the unreleased note under the new version", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const pnpm = "#!/bin/sh\nif [ \"$1\" = \"install\" ]; then printf \"changed\\n\" > pnpm-lock.yaml; fi\nexit 0\n";
  const result = await runRelease(fixture, pnpm);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(fixture.repo, ["status", "--porcelain"]), "");
  assert.ok(!existsSync(path.join(fixture.repo, "release-notes/unreleased.md")));
  const note = await readFile(path.join(fixture.repo, "release-notes/1.2.4.md"), "utf8");
  assert.match(note, /^---\nversion: 1\.2\.4\ndate: \d{4}-\d{2}-\d{2}\ntitle: A test release\n/);
  assert.match(note, /\(media\/1\.2\.4\/shot\.jpg "medium"\)/);
  assert.ok(existsSync(path.join(fixture.repo, "release-notes/media/1.2.4/shot.jpg")));
  assert.match(git(fixture.repo, ["show", "--name-only", "--format=", "HEAD"]), /release-notes\/1\.2\.4\.md/);
});

test("refuses to release without valid release notes", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  git(fixture.repo, ["rm", "-q", "release-notes/unreleased.md"]);
  git(fixture.repo, ["commit", "-q", "-m", "drop notes"]);
  const head = git(fixture.repo, ["rev-parse", "HEAD"]);
  const result = await runRelease(fixture, "#!/bin/sh\nexit 0\n");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /release-notes\/unreleased\.md is missing/);
  assert.equal(git(fixture.repo, ["rev-parse", "HEAD"]), head);
});
