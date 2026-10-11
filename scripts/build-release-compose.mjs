#!/usr/bin/env node
// Builds the standalone docker-compose.yml attached to each GitHub release. Self-hosters download
// that one file plus .env.example, so it must not reference anything else in the repository:
//   - every `build:` block becomes an `image:` pinned to the release's published GHCR image,
//   - the Postgres init script is inlined as a Compose config instead of a ./docker bind mount,
//   - the monitoring profile is dropped, since it bind-mounts a directory of config files and stays
//     a build-from-source option.
// The repository's docker-compose.yml stays the single source of truth; this is a text transform
// rather than a YAML round trip so the comments and the shared `x-app-env` anchor survive verbatim.
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

export const IMAGE_REGISTRY = "ghcr.io/happendev";

// Dockerfile -> published image name. publish-images.yml builds exactly these.
export const IMAGES = {
  "apps/api/Dockerfile": "kanera-api",
  "apps/web/Dockerfile": "kanera-web",
  "apps/mcp/Dockerfile": "kanera-mcp",
  "docker/db-backup/Dockerfile": "kanera-db-backup",
};

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const buildBlockPattern = /^( +)build:\n\1  context: \.\n\1  dockerfile: (\S+)\n\1  pull: true\n/gm;
const initMountPattern = /^( +)volumes:\n\1  - kanera_pgdata:\/var\/lib\/postgresql\n\1  - \.\/docker\/postgres\/init\.sql:\/docker-entrypoint-initdb\.d\/00-init\.sql:ro,Z\n/m;
const monitoringStart = /^  # -{20,}\n  # Monitoring stack\.[\s\S]*?(?=^volumes:\n)/m;

export function buildReleaseCompose(source, initSql, version) {
  if (!semverPattern.test(version)) throw new Error(`version must be X.Y.Z, got "${version}"`);

  let output = source.replace(buildBlockPattern, (_match, indent, dockerfile) => {
    const image = IMAGES[dockerfile];
    if (!image) throw new Error(`no published image for ${dockerfile}; add it to IMAGES and publish-images.yml`);
    return `${indent}image: ${IMAGE_REGISTRY}/${image}:${version}\n`;
  });
  if (/^\s+build:/m.test(output)) throw new Error("a build: block did not match the expected shape");

  if (!initMountPattern.test(output)) throw new Error("postgres init.sql mount not found");
  output = output.replace(
    initMountPattern,
    (_match, indent) =>
      `${indent}volumes:\n${indent}  - kanera_pgdata:/var/lib/postgresql\n` +
      `${indent}configs:\n${indent}  - source: postgres_init\n${indent}    target: /docker-entrypoint-initdb.d/00-init.sql\n`,
  );

  if (!monitoringStart.test(output)) throw new Error("monitoring section marker not found");
  output = output.replace(monitoringStart, "");
  output = output.replace(/^  kanera_(prometheus|grafana|loki|alloy)_data:\n/gm, "");
  if (/\.\/docker\//.test(output)) throw new Error("output still references files in ./docker");

  // Compose interpolates `$` inside config content, so escape it to keep the SQL literal.
  const config = initSql
    .replaceAll("$", "$$$$")
    .trimEnd()
    .split("\n")
    .map((line) => (line ? `      ${line}` : ""))
    .join("\n");

  const header =
    `# Kanera ${version} standalone Docker Compose file, generated from the repository's\n` +
    `# docker-compose.yml by scripts/build-release-compose.mjs. Do not edit; download the file from\n` +
    `# the release you want instead. Put it next to your .env and run \`docker compose up -d\`.\n` +
    `# Requires Docker Compose 2.23 or newer.\n\n`;

  return `${header}${output.trimEnd()}\n\nconfigs:\n  postgres_init:\n    content: |\n${config}\n`;
}

async function main() {
  const [version, outPath = "docker-compose.release.yml"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: node scripts/build-release-compose.mjs <X.Y.Z> [output path]");
    process.exit(1);
  }
  const source = await readFile("docker-compose.yml", "utf8");
  const initSql = await readFile("docker/postgres/init.sql", "utf8");
  await writeFile(outPath, buildReleaseCompose(source, initSql, version.replace(/^v/, "")));
  console.log(`Wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
