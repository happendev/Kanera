import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import subsetFont from "subset-font";

const projectRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const source = await readFile(require.resolve("@tabler/icons-webfont/dist/tabler-icons.min.css"), "utf8");
const font = await readFile(require.resolve("@tabler/icons-webfont/dist/fonts/tabler-icons.ttf"));
const glyphs = new Map([...source.matchAll(/\.ti-([a-z0-9-]+):before\{content:"\\([a-f0-9]+)"\}/g)]
  .map((match) => [match[1], Number.parseInt(match[2], 16)]));
if (glyphs.size < 5_000) throw new Error("Unexpected Tabler CSS: missing icon mappings");

// Include static classes and literal icon names (including conditional bindings and picker defaults).
// Account/workspace icons are unrestricted: any glyph outside this set still works through the
// complementary unicode-range face, fetched by the browser only when that glyph is rendered.
const core = new Set();
for (const appRoot of [resolve(projectRoot, "src/app"), resolve(projectRoot, "../../packages/shared/src")]) {
  for (const file of await readdir(appRoot, { recursive: true })) {
    if (!/\.(?:ts|html|scss)$/.test(file) || /\.(?:spec|test)\.ts$/.test(file) || file === "tabler-icons.ts") continue;
    const contents = await readFile(resolve(appRoot, file), "utf8");
    const names = [
      ...[...contents.matchAll(/\bti-([a-z0-9-]+)/g)].map((match) => match[1]),
      ...[...contents.matchAll(/["'`]([a-z0-9-]+)["'`]/g)].map((match) => match[1]),
    ];
    for (const name of names) if (glyphs.has(name)) core.add(glyphs.get(name));
  }
}
const extra = new Set([...glyphs.values()].filter((code) => !core.has(code)));
const output = resolve(projectRoot, "src/fonts");
await mkdir(output, { recursive: true });

function ranges(codes) {
  const sorted = [...codes].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i];
    let last = first;
    while (sorted[i + 1] === last + 1) last = sorted[++i];
    result.push(`U+${first.toString(16)}${last === first ? "" : `-${last.toString(16)}`}`);
  }
  return result.join(",");
}

const faces = [];
const groups = [["core", core]];
const catalogue = [...extra].sort((a, b) => a - b);
// One saved uncommon icon should not download the rest of the catalogue. The browser selects
// these disjoint unicode ranges automatically, including while searching all icons in the picker.
for (let offset = 0; offset < catalogue.length; offset += 256) {
  groups.push([`extra-${offset / 256}`, new Set(catalogue.slice(offset, offset + 256))]);
}
let total = 0;
for (const [name, codes] of groups) {
  const filename = `tabler-icons-${name}.woff2`;
  const buffer = await subsetFont(font, String.fromCodePoint(...[...codes].sort((a, b) => a - b)), { targetFormat: "woff2" });
  await writeFile(resolve(output, filename), buffer);
  faces.push(`@font-face{font-family:"tabler-icons";font-style:normal;font-weight:400;src:url("./fonts/${filename}") format("woff2");unicode-range:${ranges(codes)}}`);
  total += buffer.length;
  if (name === "core") console.log(`Tabler core: ${codes.size} glyphs, ${(buffer.length / 1024).toFixed(1)} KiB`);
}
console.log(`Tabler catalogue: ${groups.length - 1} lazy subsets; ${(total / 1024).toFixed(1)} KiB total icons`);
// Keep all name-to-codepoint mappings: saved custom choices and the complete picker must continue
// to work without JS font loading or a second icon system. Angular fingerprints every WOFF2 file.
const css = source.replace(/@font-face\{[^}]+\}/, faces.join("\n"));
if (css === source) throw new Error("Could not find the Tabler @font-face rule to replace");
await writeFile(resolve(projectRoot, "src/tabler-icons.generated.css"), css);
