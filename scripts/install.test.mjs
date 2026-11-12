import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReleaseCompose } from "./build-release-compose.mjs";

// Browser E2E cannot exercise installer download failures, fresh secrets, or existing Docker data.
const installer = path.resolve("scripts/install.sh");
const compose = buildReleaseCompose(await readFile("docker-compose.yml", "utf8"), await readFile("docker/postgres/init.sql", "utf8"), "1.10.0");
async function fixture(t, { downloadFails = false, existingData = false, startupFails = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "kanera-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(root, "compose.yml"), compose);
  await writeFile(path.join(root, "https.yml"), await readFile("docker-compose.https.yml"));
  await writeFile(path.join(bin, "curl"), `#!/bin/bash
printf '%s\\n' "$*" >> '${root}/curl.log'
out=''
while (($#)); do
  case "$1" in --output) out=$2; shift 2 ;; *) url=$1; shift ;; esac
done
case "$url" in
  */latest) printf 'https://github.com/happendev/Kanera/releases/tag/v1.10.0' ;;
  */docker-compose.yml) ${downloadFails ? "exit 22" : `cp '${root}/compose.yml' "$out"`} ;;
  */docker-compose.https.yml) cp '${root}/https.yml' "$out" ;;
  */api/health) exit 0 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  await writeFile(path.join(bin, "docker"), `#!/bin/bash
printf '%s\\n' "$*" >> '${root}/docker.log'
case "$*" in
  'compose version --short') echo 2.40.3 ;;
  'volume ls'*) ${existingData ? "echo existing_pgdata" : ":"} ;;
  *' up '*) ${startupFails ? "exit 1" : ":"} ;;
esac
`, { mode: 0o755 });
  const directory = path.join(root, "new install");
  return {
    root, directory,
    run: (args = []) => spawnSync("bash", [installer, "--directory", directory, ...args], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }),
  };
}

test("localhost generates private independent secrets, pins one release, and waits for health", async (t) => {
  const f = await fixture(t);
  const result = f.run(["--mode", "localhost", "--port", "14200"]);
  assert.equal(result.status, 0, result.stderr);
  const env = await readFile(path.join(f.directory, ".env"), "utf8");
  const secrets = [...env.matchAll(/^(?:POSTGRES_PASSWORD|JWT_SECRET|MCP_INTERNAL_SECRET|MFA_ENCRYPTION_KEY|MEDIA_SIGNING_SECRET|SECRETS_ENCRYPTION_KEY)=([a-f0-9]{64})$/gm)].map((m) => m[1]);
  assert.equal(new Set(secrets).size, 6);
  assert.equal((await stat(path.join(f.directory, ".env"))).mode & 0o777, 0o600);
  assert.match(env, /WEB_ORIGIN=http:\/\/localhost:14200/);
  assert.match(env, /COOKIE_SECURE=false/);
  assert.match(env, /KANERA_DEPLOYMENT_MODE=self_hosted/);
  assert.match(env, /POSTGRES_BIND_PORT=0/);
  await assert.rejects(access(path.join(f.directory, "docker-compose.override.yml")));
  const downloads = await readFile(path.join(f.root, "curl.log"), "utf8");
  assert.match(downloads, /download\/v1\.10\.0\/docker-compose.yml/);
  assert.match(downloads, /localhost:14200\/api\/health/);
  assert.match(await readFile(path.join(f.root, "docker.log"), "utf8"), /up -d --wait --wait-timeout 300/);
  for (const secret of secrets) assert.ok(!result.stdout.includes(secret));
  const second = f.run(["--mode", "localhost"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Directory already exists/);
  assert.equal(await readFile(path.join(f.directory, ".env"), "utf8"), env);
});

test("production downloads automatic HTTPS override and checks the public certificate", async (t) => {
  const f = await fixture(t);
  const result = f.run(["--mode", "production", "--domain", "Kanera.Example.com", "--version", "v1.10.0"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(f.directory, ".env"), "utf8"), /WEB_ORIGIN=https:\/\/kanera.example.com\nCOOKIE_DOMAIN=kanera.example.com\nCOOKIE_SECURE=true/);
  assert.match(await readFile(path.join(f.directory, "docker-compose.override.yml"), "utf8"), /caddy:2\.11\.9-alpine/);
  const calls = await readFile(path.join(f.root, "curl.log"), "utf8");
  assert.doesNotMatch(calls, /\/latest/);
  assert.match(calls, /https:\/\/kanera.example.com\/api\/health/);
  assert.doesNotMatch(calls, /--insecure/);
});

test("existing-proxy mode leaves TLS to the operator without installing Caddy", async (t) => {
  const f = await fixture(t);
  const result = f.run(["--mode", "production", "--domain", "kanera.example.com", "--https", "existing"]);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(path.join(f.directory, "docker-compose.override.yml")));
  assert.match(result.stdout, /Configure your HTTPS proxy/);
  assert.doesNotMatch(await readFile(path.join(f.root, "curl.log"), "utf8"), /https:\/\/kanera.example.com\/api\/health/);
});

for (const args of [
  ["--mode", "invalid"], ["--mode", "localhost", "--port", "65536"],
  ["--mode", "production", "--domain", "https://example.com"],
  ["--mode", "production", "--domain", "example.com\nBAD=value"],
  ["--mode", "production", "--domain", "kanera.local"],
  ["--mode", "localhost", "--version", "mcp-v1.0.0"],
]) {
  test(`rejects invalid options: ${JSON.stringify(args)}`, async (t) => {
    const f = await fixture(t);
    assert.notEqual(f.run(args).status, 0);
    await assert.rejects(access(f.directory));
  });
}
for (const option of ["downloadFails", "existingData"]) {
  test(`${option} leaves no installation or new secrets`, async (t) => {
    const f = await fixture(t, { [option]: true });
    assert.notEqual(f.run(["--mode", "localhost"]).status, 0);
    await assert.rejects(access(f.directory));
  });
}
test("startup failure preserves generated configuration and does not claim success", async (t) => {
  const f = await fixture(t, { startupFails: true });
  const result = f.run(["--mode", "localhost"]);
  assert.notEqual(result.status, 0);
  await access(path.join(f.directory, ".env"));
  assert.match(result.stderr, /Files and secrets are preserved/);
  assert.doesNotMatch(result.stdout, /Kanera installed/);
});
