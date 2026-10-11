import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildReleaseCompose, IMAGE_REGISTRY } from "./build-release-compose.mjs";

const source = await readFile("docker-compose.yml", "utf8");
const initSql = await readFile("docker/postgres/init.sql", "utf8");

test("the repository compose file converts to a standalone release file", () => {
  const output = buildReleaseCompose(source, initSql, "1.9.0");

  assert.doesNotMatch(output, /^\s+build:/m);
  assert.doesNotMatch(output, /\.\/docker\//);
  assert.doesNotMatch(output, /profiles: \["monitoring"\]/);
  assert.match(output, new RegExp(`image: ${IMAGE_REGISTRY}/kanera-api:1\\.9\\.0`));
  assert.match(output, new RegExp(`image: ${IMAGE_REGISTRY}/kanera-web:1\\.9\\.0`));
  assert.match(output, new RegExp(`image: ${IMAGE_REGISTRY}/kanera-mcp:1\\.9\\.0`));
  assert.match(output, new RegExp(`image: ${IMAGE_REGISTRY}/kanera-db-backup:1\\.9\\.0`));
  assert.match(output, /target: \/docker-entrypoint-initdb\.d\/00-init\.sql/);
  assert.match(output, /CREATE EXTENSION IF NOT EXISTS "citext";/);
  assert.match(output, /<<: \*app-env/);
});

test("rejects a version that is not X.Y.Z", () => {
  assert.throws(() => buildReleaseCompose(source, initSql, "latest"), /X\.Y\.Z/);
});

test("rejects a Dockerfile with no published image", () => {
  const extra = source.replace(
    "dockerfile: apps/web/Dockerfile",
    "dockerfile: apps/unknown/Dockerfile",
  );
  assert.throws(() => buildReleaseCompose(extra, initSql, "1.9.0"), /no published image/);
});

test("escapes $ in the inlined init script", () => {
  const output = buildReleaseCompose(source, "SELECT '$1';\n", "1.9.0");
  assert.match(output, /SELECT '\$\$1';/);
});
