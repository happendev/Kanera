#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";

const manifestPaths = [
  "package.json",
  "apps/api/package.json",
  "apps/web/package.json",
  "apps/mcp/package.json",
  "packages/shared/package.json",
];

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`\nRelease failed: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    if (options.capture) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      if (output) console.error(output);
    }
    fail(options.failureMessage ?? `${command} ${args.join(" ")} exited with ${result.status}`);
  }

  return result.stdout?.trim() ?? "";
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseVersion(version) {
  const match = semverPattern.exec(version);
  if (!match) fail(`"${version}" is not a plain SemVer version like 1.0.0.`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(version, type) {
  const current = parseVersion(version);

  if (type === "major") {
    return formatVersion({ major: current.major + 1, minor: 0, patch: 0 });
  }

  if (type === "minor") {
    return formatVersion({ major: current.major, minor: current.minor + 1, patch: 0 });
  }

  if (type === "bug") {
    return formatVersion({ major: current.major, minor: current.minor, patch: current.patch + 1 });
  }

  fail(`Unknown release type "${type}".`);
}

async function createAsker() {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
      async question(prompt) {
        return rl.question(prompt);
      },
      close() {
        rl.close();
      },
    };
  }

  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const answers = input.split(/\r?\n/);
  return {
    async question(prompt) {
      process.stdout.write(prompt);
      return answers.shift() ?? "";
    },
    close() {},
  };
}

async function chooseVersion(currentVersion, asker) {
  const options = [
    { key: "1", label: "major", version: bumpVersion(currentVersion, "major") },
    { key: "2", label: "minor", version: bumpVersion(currentVersion, "minor") },
    { key: "3", label: "bug", version: bumpVersion(currentVersion, "bug") },
    { key: "4", label: "manual", version: null },
  ];

  console.log(`Current version: ${currentVersion}`);
  console.log("\nChoose release type:");
  for (const option of options) {
    const suffix = option.version ? ` -> ${option.version}` : "";
    console.log(`${option.key}. ${option.label.padEnd(6)}${suffix}`);
  }

  while (true) {
    const answer = (await asker.question("\nRelease type: ")).trim().toLowerCase();
    const selected = options.find((option) => option.key === answer || option.label === answer || (answer === "patch" && option.label === "bug"));

    if (!selected) {
      console.log("Choose 1, 2, 3, 4, major, minor, bug, patch, or manual.");
      continue;
    }

    if (selected.version) return selected.version;

    while (true) {
      const manualVersion = (await asker.question("Manual version (example: 1.0.0): ")).trim();
      if (manualVersion.startsWith("v")) {
        console.log("Enter the plain version without a leading v, for example 1.0.0.");
        continue;
      }

      if (!semverPattern.test(manualVersion)) {
        console.log("Enter a plain SemVer version like 1.0.0.");
        continue;
      }

      return manualVersion;
    }
  }
}

async function confirmTagCreation(tagName, asker) {
  while (true) {
    const answer = (await asker.question(`Create annotated git tag ${tagName}? [y/N]: `)).trim().toLowerCase();
    if (answer === "" || answer === "n" || answer === "no") return false;
    if (answer === "y" || answer === "yes") return true;
    console.log("Choose y or n.");
  }
}

async function assertManifestVersionsMatch(rootVersion) {
  for (const path of manifestPaths) {
    const manifest = await readJson(path);
    if (manifest.version !== rootVersion) {
      fail(`${path} has version ${manifest.version}, but package.json has version ${rootVersion}. Sync versions before releasing.`);
    }
  }
}

function assertCleanWorkingTree() {
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (status) {
    fail("working tree is not clean. Commit, stash, or discard changes before running a release.");
  }
}

function assertOnMainBranch() {
  const branch = run("git", ["branch", "--show-current"], { capture: true });
  if (branch !== "main") {
    fail(`releases must be run from the main branch. Current branch is ${branch || "detached HEAD"}.`);
  }
}

function assertTagDoesNotExist(tagName) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], {
    stdio: "ignore",
  });

  if (result.status === 0) {
    fail(`tag ${tagName} already exists locally.`);
  }
}

async function updateManifestVersions(version) {
  for (const path of manifestPaths) {
    const manifest = await readJson(path);
    manifest.version = version;
    await writeJson(path, manifest);
  }
}

async function main() {
  const rootManifest = await readJson("package.json");
  const currentVersion = rootManifest.version;
  parseVersion(currentVersion);

  await assertManifestVersionsMatch(currentVersion);
  assertOnMainBranch();
  const asker = await createAsker();
  let nextVersion;
  let tagName;
  let shouldCreateTag;

  try {
    nextVersion = await chooseVersion(currentVersion, asker);
    tagName = `v${nextVersion}`;

    console.log(`\nRelease: ${currentVersion} -> ${nextVersion}`);
    shouldCreateTag = await confirmTagCreation(tagName, asker);
  } finally {
    asker.close();
  }

  assertCleanWorkingTree();
  if (shouldCreateTag) assertTagDoesNotExist(tagName);

  if (dryRun) {
    console.log("\nDry run complete. No files were changed.");
    return;
  }

  await updateManifestVersions(nextVersion);

  run("pnpm", ["install", "--lockfile-only"]);
  run("pnpm", ["lint"]);
  run("pnpm", ["test"]);

  run("git", ["add", ...manifestPaths, "pnpm-lock.yaml"]);
  run("git", ["commit", "-m", `chore: release ${tagName}`]);
  if (shouldCreateTag) run("git", ["tag", "-a", tagName, "-m", tagName]);

  console.log(`\nRelease commit created${shouldCreateTag ? " with tag" : " without tag"}.`);
  console.log("\nNext steps:");
  console.log("git push origin main");
  if (shouldCreateTag) {
    console.log(`git push origin ${tagName}`);
    console.log(`gh release create ${tagName} --title "${tagName}" --generate-notes --verify-tag`);
  }
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
