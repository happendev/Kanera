import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

if (typeof packageJson.version !== "string") {
  throw new Error("apps/cli/package.json must contain a version");
}

const result = await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/kanera.mjs", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  legalComments: "eof",
  metafile: true,
  define: {
    KANERA_CLI_VERSION: JSON.stringify(packageJson.version),
  },
  // Some bundled dependencies retain guarded CommonJS requires for Node built-ins. Supplying a
  // local require keeps the ESM executable self-contained without external npm packages.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

await chmod(new URL("../dist/kanera.mjs", import.meta.url), 0o755);
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
await writeFile(new URL("../dist/THIRD_PARTY_NOTICES.md", import.meta.url), await thirdPartyNotices(result.metafile));

/**
 * The executable bundles third-party MIT/Apache/BSD/ISC code, and those licenses require their
 * copyright and permission notices to travel with redistributed copies. esbuild's legalComments
 * only preserves `@license` comment banners, which none of these packages use — their terms live in
 * LICENSE files — so the notices are collected here from the exact set of packages the metafile
 * says went into the bundle. A new bundled dependency is picked up automatically on the next build.
 */
async function thirdPartyNotices(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    // The last node_modules segment is the package's real root even under pnpm's nested store
    // layout (node_modules/.pnpm/name@version/node_modules/name). Workspace sources are symlinked
    // and resolve outside node_modules, so they never appear here.
    const marker = input.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const segments = input.slice(marker + "node_modules/".length).split("/");
    const name = segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    roots.add(input.slice(0, marker) + "node_modules/" + name);
  }

  const sections = [];
  for (const root of roots) {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (typeof pkg.license !== "string" || pkg.license === "") {
      throw new Error(`${root} declares no license; resolve this before shipping it inside the CLI bundle.`);
    }
    // Apache-2.0 additionally requires any NOTICE file to be preserved, hence the broader match.
    const legalFiles = (await readdir(root)).filter((entry) => /^(licen[cs]e|notice|copying)/iu.test(entry));
    const texts = await Promise.all(legalFiles.map(async (entry) =>
      `${(await readFile(join(root, entry), "utf8")).trim()}\n`));
    sections.push({
      name: pkg.name,
      body: [
        `## ${pkg.name}@${pkg.version}`,
        "",
        `License: ${pkg.license}`,
        "",
        ...(texts.length > 0
          ? ["```text", ...texts, "```"]
          : [`The package ships no license file; its terms are the ${pkg.license} license, see the package's repository.`]),
      ].join("\n"),
    });
  }
  sections.sort((a, b) => a.name.localeCompare(b.name));

  return [
    "# Third-party notices",
    "",
    "The `kanera` executable bundles the following packages. Each remains under its own license,",
    "reproduced below. The Kanera code in this package is licensed under the Elastic License 2.0",
    "(see LICENSE).",
    "",
    ...sections.map((section) => section.body),
    "",
  ].join("\n");
}
