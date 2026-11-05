// Measure the bootstrap actually executed by main.ts, then each route's static import closure.
// Angular's "initial" metric alone misses our locale-gated dynamic bootstrap and route chunks.
// gzip is the production origin's wire format; Brotli is supplementary for CDN deployments.
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(projectRoot, "dist/web");
const browserRoot = resolve(distRoot, "browser");
const stats = JSON.parse(await readFile(resolve(distRoot, "browser-stats.json"), "utf8"));
const outputs = stats.outputs;
const check = process.argv.includes("--check");
const failures = [];
const entryFor = (suffix) => {
  const file = Object.keys(outputs).find((file) => outputs[file].entryPoint?.endsWith(suffix));
  if (!file) throw new Error(`Missing bundle entry: ${suffix}`);
  return file;
};
const closure = (...roots) => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    if (!outputs[file]) throw new Error(`Missing bundle output: ${file}`);
    seen.add(file);
    for (const imported of outputs[file].imports ?? []) {
      if (imported.kind === "import-statement" && !imported.external) visit(imported.path);
    }
  };
  roots.flat().forEach(visit);
  return seen;
};
const union = (...sets) => new Set(sets.flatMap((set) => [...set]));
const sizeCache = new Map();
const sizesFor = async (files) => {
  const total = { raw: 0, gzip: 0, brotli: 0 };
  for (const file of files) {
    if (!sizeCache.has(file)) {
      const contents = await readFile(resolve(browserRoot, file));
      const text = /\.(?:js|css|html|json|svg)$/.test(file);
      sizeCache.set(file, {
        raw: contents.length,
        gzip: text ? gzipSync(contents, { level: 9 }).length : contents.length,
        brotli: text ? brotliCompressSync(contents, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
        }).length : contents.length,
      });
    }
    for (const key of Object.keys(total)) total[key] += sizeCache.get(file)[key];
  }
  return total;
};

const files = await readdir(browserRoot);
const jsFiles = files.filter((file) => file.endsWith(".js"));
const ngsw = JSON.parse(await readFile(resolve(browserRoot, "ngsw.json"), "utf8"));
const prefetch = new Set(ngsw.assetGroups.filter((group) => group.installMode === "prefetch")
  .flatMap((group) => group.urls.map((url) => url.slice(1))));
const cachedUrls = new Set(ngsw.assetGroups.flatMap((group) => group.urls));
const workerFiles = new Set(["ngsw-worker.js", "safety-worker.js", "worker-basic.min.js"]);
for (const file of jsFiles) {
  if (!workerFiles.has(file) && !cachedUrls.has(`/${file}`)) failures.push(`Script missing from offline packaging: ${file}`);
}
const media = (await readdir(resolve(browserRoot, "media"))).map((file) => `media/${file}`);
const iconFonts = media.filter((file) => file.includes("/tabler-icons-"));
const coreFont = iconFonts.find((file) => file.includes("/tabler-icons-core-"));
const latinFont = media.find((file) => file.includes("/inter-latin-opsz-normal-"));
if (!coreFont || !latinFont) throw new Error("Missing initial icon/text fonts");
if (iconFonts.some((file) => !file.endsWith(".woff2"))) failures.push("Icon fonts must be WOFF2 only");
for (const font of iconFonts) if (!cachedUrls.has(`/${font}`)) failures.push(`Icon font missing from offline packaging: ${font}`);

const main = entryFor("src/main.ts");
// Follow only imports directly made by main.ts, not every dynamic import in a shared output chunk.
// The latter would count every locale/feature as startup merely because the bundler co-located it.
const bootstrapEntries = stats.inputs[outputs[main].entryPoint].imports
  .filter((item) => item.kind === "dynamic-import")
  .map((item) => entryFor(item.path));
const bootstrap = closure(main, bootstrapEntries, entryFor("angular:styles/global:styles"),
  files.filter((file) => /^polyfills-.*\.js$/.test(file)), entryFor("locales/en-GB.js"));
bootstrap.add("manifest.js");
const shell = closure(entryFor("app-shell.component.ts"));
const routeEntries = {
  login: "login.page.ts",
  home: "home.page.ts",
  board: "board.page.ts",
  globalWork: "global-work.page.ts",
  workspaceSettings: "workspace-settings.page.ts",
  accountSettings: "account-settings.page.ts",
};
const routes = {};
for (const [name, entry] of Object.entries(routeEntries)) {
  const code = union(bootstrap, name === "login" ? [] : shell, closure(entryFor(entry)));
  routes[name] = {
    code: await sizesFor(code),
    // Default en-GB screen, including HTML and both initial fonts. Custom icons/other languages
    // can add lazy assets; keep those separate rather than claiming a universal first-visit size.
    firstVisit: await sizesFor(union(code, ["index.html", coreFont, latinFont])),
    files: [...code].sort(),
  };
  if (name === "board" || name === "globalWork") {
    const inputs = [...code].flatMap((file) => Object.keys(outputs[file]?.inputs ?? {}));
    for (const forbidden of ["description-editor.component.ts", "board-table-view.component.ts", "board-calendar-view.component.ts", "board-timeline-view.component.ts", "dependency-map.component.ts"]) {
      if (inputs.some((file) => file.endsWith(forbidden))) failures.push(`${name} eagerly imports ${forbidden}`);
    }
  }
}
const metrics = {
  bootstrap: await sizesFor(bootstrap),
  prefetch: { ...await sizesFor(prefetch), files: prefetch.size },
  totalJavaScript: await sizesFor(jsFiles.filter((file) => !workerFiles.has(file))),
  largestScript: jsFiles.map((file) => ({ file, raw: outputs[file]?.bytes ?? 0 })).sort((a, b) => b.raw - a.raw)[0],
  fonts: { core: await sizesFor([coreFont]), allIcons: await sizesFor(iconFonts), initial: await sizesFor([coreFont, latinFont]) },
  translations: Object.fromEntries(await Promise.all(files.filter((file) => /^messages\..*\.js$/.test(file)).map(async (file) => [file, await sizesFor([file])]))),
  routes,
};
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const summary = (sizes) => `${kib(sizes.raw)} raw / ${kib(sizes.gzip)} gzip / ${kib(sizes.brotli)} Brotli`;
console.log(`Bootstrap (before route): ${summary(metrics.bootstrap)}`);
console.log(`Offline prefetch: ${summary(metrics.prefetch)} across ${metrics.prefetch.files} files`);
console.log(`All JS (including every locale): ${summary(metrics.totalJavaScript)}`);
console.log(`Largest script: ${metrics.largestScript.file} (${kib(metrics.largestScript.raw)})`);
console.log(`Icons: ${kib(metrics.fonts.core.raw)} initial / ${kib(metrics.fonts.allIcons.raw)} entire catalogue`);
for (const [name, value] of Object.entries(routes)) {
  console.log(`${name}: ${summary(value.code)}; first visit incl. HTML/fonts: ${kib(value.firstVisit.gzip)} gzip`);
}
await writeFile(resolve(distRoot, "bundle-report.json"), `${JSON.stringify(metrics, null, 2)}\n`);

if (check) {
  const budgets = JSON.parse(await readFile(resolve(projectRoot, "bundle-budgets.json"), "utf8"));
  const maximum = (label, actual, limit) => {
    if (!Number.isFinite(limit)) failures.push(`Missing budget: ${label}`);
    else if (actual > limit) failures.push(`${label}: ${kib(actual)} > ${kib(limit)}`);
  };
  maximum("bootstrap.gzip", metrics.bootstrap.gzip, budgets.bootstrapGzip);
  maximum("prefetch.gzip", metrics.prefetch.gzip, budgets.prefetchGzip);
  maximum("largestScript.raw", metrics.largestScript.raw, budgets.largestScriptRaw);
  maximum("fonts.core", metrics.fonts.core.raw, budgets.coreIconFontRaw);
  maximum("fonts.allIcons", metrics.fonts.allIcons.raw, budgets.allIconFontsRaw);
  for (const [file, value] of Object.entries(metrics.translations)) {
    maximum(`${file}.gzip`, value.gzip, budgets.translationGzip);
  }
  for (const [name, value] of Object.entries(routes)) {
    maximum(`${name}.code.gzip`, value.code.gzip, budgets.routes[name]?.codeGzip);
    maximum(`${name}.firstVisit.gzip`, value.firstVisit.gzip, budgets.routes[name]?.firstVisitGzip);
  }
  if (failures.length) {
    console.error(`Bundle checks failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else console.log("Route budgets and offline packaging checks passed.");
}
