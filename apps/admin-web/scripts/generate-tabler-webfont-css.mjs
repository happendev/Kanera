import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const sourcePath = require.resolve("@tabler/icons-webfont/dist/tabler-icons.min.css");
const outputPath = resolve(projectRoot, "src/tabler-icons.generated.css");
const source = await readFile(sourcePath, "utf8");
const fontFace = '@font-face{font-family:"tabler-icons";font-style:normal;font-weight:400;src:url("../node_modules/@tabler/icons-webfont/dist/fonts/tabler-icons.woff2") format("woff2")}';
const css = source.replace(/@font-face\{[^}]+\}/, fontFace);
if (css === source) throw new Error("Could not find the Tabler @font-face rule to replace.");

await writeFile(outputPath, css);
console.log("Generated WOFF2-only Tabler webfont CSS.");
