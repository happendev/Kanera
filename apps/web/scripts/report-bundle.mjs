// Bundle size report, and with --check a gate against apps/web/bundle-budgets.json.
//
// What each budget guards:
//   initialRaw / initialBrotli   the eager startup payload — main's static import closure plus
//                                global styles. This is the number a first paint actually waits on.
//   totalJavaScriptBrotli        every precached script. ngsw prefetches `/*.js` so the whole app is
//                                installed for offline use, which means this is total app weight, not
//                                startup weight, and lazy-loading cannot reduce it — only shipping
//                                less code can. Raise it only alongside a note on what grew and why.
//   largestScriptRaw             keeps any single chunk from becoming a parse-time cliff.
//   tablerFontsRaw               the icon webfont, WOFF2-only (the check also rejects fallbacks).
//
// The report prints the measured values, so re-baselining is: run `pnpm bundle:web:check`, take the
// reported figure, and set the budget just above it. This runs in CI, so a regression fails on the
// commit that causes it rather than being discovered months later.
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(projectRoot, "dist/web");
const browserRoot = resolve(distRoot, "browser");
const stats = JSON.parse(await readFile(resolve(distRoot, "stats.json"), "utf8"));
const outputs = stats.outputs;
const check = process.argv.includes("--check");

const brotliSize = (buffer) => brotliCompressSync(buffer, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
}).length;

const entryFor = (suffix) => Object.entries(outputs)
  .find(([, output]) => output.entryPoint?.endsWith(suffix))?.[0];

const staticClosure = (start) => {
  const seen = new Set();
  const visit = (file) => {
    if (!file || seen.has(file) || !outputs[file]) return;
    seen.add(file);
    for (const imported of outputs[file].imports ?? []) {
      if (imported.kind === "import-statement") visit(imported.path);
    }
  };
  visit(start);
  return seen;
};

const union = (...sets) => new Set(sets.flatMap((set) => [...set]));
const sizesFor = async (files) => {
  let raw = 0;
  let brotli = 0;
  for (const file of files) {
    try {
      const contents = await readFile(resolve(browserRoot, file));
      raw += contents.length;
      brotli += brotliSize(contents);
    } catch {
      // Metafile-only outputs have no browser asset to compress.
    }
  }
  return { raw, brotli };
};

const files = await readdir(browserRoot);
const jsFiles = files.filter((file) => file.endsWith(".js"));
const ngsw = JSON.parse(await readFile(resolve(browserRoot, "ngsw.json"), "utf8"));
const appShellUrls = new Set(
  ngsw.assetGroups.find((group) => group.name === "app-shell")?.urls ?? [],
);
const precachedJsFiles = [...appShellUrls]
  .filter((url) => url.endsWith(".js"))
  .map((url) => url.replace(/^\//, ""));
const jsSizes = await sizesFor(precachedJsFiles);
const serviceWorkerRuntimeFiles = new Set(["ngsw-worker.js", "safety-worker.js", "worker-basic.min.js"]);
const uncachedScripts = jsFiles
  .filter((file) => !serviceWorkerRuntimeFiles.has(file) && !appShellUrls.has(`/${file}`));
const largestScript = jsFiles
  .map((file) => ({ file, raw: outputs[file]?.bytes ?? 0 }))
  .sort((a, b) => b.raw - a.raw)[0];
const tablerFonts = (await readdir(resolve(browserRoot, "media")))
  .filter((file) => file.startsWith("tabler-icons-"));
const tablerFontBytes = (await Promise.all(tablerFonts.map(async (file) =>
  (await readFile(resolve(browserRoot, "media", file))).length)))
  .reduce((total, size) => total + size, 0);

const main = entryFor("src/main.ts");
const styles = entryFor("angular:styles/global:styles");
const shell = staticClosure(entryFor("app-shell.component.ts"));
const initial = staticClosure(main);
if (styles) initial.add(styles);
const routeEntries = {
  home: "home.page.ts",
  board: "board.page.ts",
  globalWork: "global-work.page.ts",
  workspaceSettings: "workspace-settings.page.ts",
  accountSettings: "account-settings.page.ts",
};
const routes = {};
for (const [name, suffix] of Object.entries(routeEntries)) {
  routes[name] = await sizesFor(union(initial, shell, staticClosure(entryFor(suffix))));
}

const metrics = {
  initial: await sizesFor(initial),
  totalJavaScript: jsSizes,
  largestScript,
  tablerFonts: { files: tablerFonts, raw: tablerFontBytes },
  routes,
};

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`Initial: ${kib(metrics.initial.raw)} raw / ${kib(metrics.initial.brotli)} Brotli`);
console.log(`Precached JS: ${kib(jsSizes.raw)} raw / ${kib(jsSizes.brotli)} Brotli across ${precachedJsFiles.length} files`);
console.log(`Largest script: ${largestScript.file} (${kib(largestScript.raw)} raw)`);
console.log(`Tabler fonts: ${tablerFonts.join(", ")} (${kib(tablerFontBytes)})`);
for (const [name, value] of Object.entries(routes)) {
  console.log(`${name}: ${kib(value.raw)} raw / ${kib(value.brotli)} Brotli`);
}

if (check) {
  const budgets = JSON.parse(await readFile(resolve(projectRoot, "bundle-budgets.json"), "utf8"));
  const failures = [];
  const assertMax = (label, actual, maximum) => {
    if (actual > maximum) failures.push(`${label}: ${actual} > ${maximum}`);
  };
  assertMax("initial.raw", metrics.initial.raw, budgets.initialRaw);
  assertMax("initial.brotli", metrics.initial.brotli, budgets.initialBrotli);
  assertMax("totalJavaScript.brotli", jsSizes.brotli, budgets.totalJavaScriptBrotli);
  assertMax("largestScript.raw", largestScript.raw, budgets.largestScriptRaw);
  assertMax("tablerFonts.raw", tablerFontBytes, budgets.tablerFontsRaw);
  if (tablerFonts.some((file) => !file.endsWith(".woff2"))) {
    failures.push(`Tabler emitted unsupported fallback formats: ${tablerFonts.join(", ")}`);
  }
  if (uncachedScripts.length) {
    failures.push(`Application scripts missing from the offline app shell: ${uncachedScripts.join(", ")}`);
  }
  if (failures.length) {
    console.error(`Bundle budgets failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("Bundle budgets passed.");
  }
}
