// Repro: node benchmarks/performance/frontend.mjs --baseline-ref 59147bba --output /tmp/kanera-frontend-performance
// Uses the checked-out implementation and an immutable Git baseline. Network latency is simulated;
// diff timings use actual Chromium, and cache write counts use the actual service with fake IndexedDB.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootRequire = createRequire(path.join(root, "package.json"));
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const buildRequire = createRequire(webRequire.resolve("@angular/build/package.json"));
const ts = rootRequire("typescript");
const { chromium } = rootRequire("@playwright/test");
const { build } = buildRequire("esbuild");
const { openDB } = webRequire("idb");
const fakeIDB = webRequire("fake-indexeddb");
const option = (name, fallback) => process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const baseline = process.argv.includes("--baseline-ref") ? option("--baseline-ref") : "59147bba";
const output = process.argv.includes("--output") ? option("--output") : "/tmp/kanera-frontend-performance";
await fs.mkdir(output, { recursive: true });
const sources = new Map();
async function source(file, before) {
  const key = `${before}:${file}`;
  if (!sources.has(key)) sources.set(key, before ? execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" }) : await fs.readFile(path.join(root, file), "utf8"));
  return sources.get(key);
}
const signal = (initial) => {
  let value = initial;
  const read = () => value;
  read.set = (next) => { value = next; };
  read.update = (update) => { value = update(value); };
  return read;
};
function classCode(text, name, methods) {
  const ast = ts.createSourceFile("subject.ts", text, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === name);
  const members = methods ? methods.map((method) => cls.members.find((member) => member.name?.getText(ast) === method)) : [...cls.members];
  return ts.transpileModule(`class Subject { ${members.map((member) => member.getText(ast)).join("\n")} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nreturn Subject;";
}
const report = { baseline, node: process.version, diff: [], notes: [], globalWork: [] };
const browser = await chromium.launch({ headless: true, args: ["--enable-precise-memory-info"] });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.setContent('<h1>Kanera frontend performance comparison</h1><pre id="result"></pre>');
  for (const before of [true, false]) {
    const file = "apps/web/src/app/features/board/description-diff.ts";
    const compiled = await build({ stdin: { contents: await source(file, before), loader: "ts", resolveDir: path.dirname(path.join(root, file)) }, bundle: true, write: false, minify: true, platform: "browser", format: "iife", globalName: before ? "beforeDiff" : "afterDiff" });
    await page.addScriptTag({ content: compiled.outputFiles[0].text });
  }
  // Failure modes: repeated-token alignment can change if equal LCS paths choose another side;
  // trimming a common prefix can highlight a different repeated word; markup-only edits need the
  // same View changes affordance. Compare complete public results, not only an edit distance.
  report.exactDiffCases = await page.evaluate(() => {
    let count = 0;
    const words = ["a", "b", " "];
    const values = [""];
    for (let length = 1; length <= 4; length++) {
      for (let value = 0; value < words.length ** length; value++) {
        let n = value, text = "";
        for (let i = 0; i < length; i++) { text += words[n % words.length]; n = Math.floor(n / words.length); }
        values.push(text);
      }
    }
    for (const from of values) for (const to of values) {
      const expected = beforeDiff.descriptionDiff(from, to);
      const actual = afterDiff.descriptionDiff(from, to);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Different diff: ${JSON.stringify({ from, to, expected, actual })}`);
      if (afterDiff.hasDescriptionChanges(from, to) !== (expected.hasChanges || expected.formattingOnly)) throw new Error("Different feed eligibility");
      count++;
    }
    return count;
  });
  for (const words of [500, 1000, 2500]) {
    for (const before of [true, false]) {
      await cdp.send("HeapProfiler.collectGarbage");
      const result = await page.evaluate(({ words, before }) => {
        const module = before ? beforeDiff : afterDiff;
        const from = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
        const to = from.replace("word1 ", "replacement1 ");
        const heapBefore = performance.memory.usedJSHeapSize;
        const start = performance.now();
        const diff = module.descriptionDiff(from, to);
        const elapsedMs = performance.now() - start;
        const heapGrowthBytes = performance.memory.usedJSHeapSize - heapBefore;
        const feedStart = performance.now();
        if (before) module.descriptionDiff(from, to); else module.hasDescriptionChanges(from, to);
        return { before, words, elapsedMs, feedEligibilityMs: performance.now() - feedStart, heapGrowthBytes, lines: diff.lines.length };
      }, { words, before });
      report.diff.push(result);
    }
  }
  report.browser = browser.version();
  await page.evaluate((report) => { document.querySelector("#result").textContent = JSON.stringify(report, null, 2); }, report);
  await page.screenshot({ path: path.join(output, "diff-before-after.png"), fullPage: true });
  await context.tracing.stop({ path: path.join(output, "diff-trace.zip") });
} finally { await browser.close(); }

for (const before of [true, false]) {
  for (const [name, value] of Object.entries(fakeIDB)) if (name.startsWith("IDB")) globalThis[name] = value;
  globalThis.indexedDB = new fakeIDB.IDBFactory();
  const file = "apps/web/src/app/core/offline/offline-cache.service.ts";
  const Cache = new Function("signal", "openDB", "CACHE_STORES", "CACHE_BUDGET_BYTES", "CACHE_MAX_AGE_MS", classCode(await source(file, before), "OfflineCacheService"))(signal, openDB, ["shell", "boards", "cardDetails", "notes", "globalWork", "homeToday"], 32 * 1024 * 1024, 30 * 86400000);
  const cache = new Cache();
  const notes = Array.from({ length: 200 }, (_, i) => ({ id: `note-${i}`, title: `Note ${i}`, content: "Complete project notes.\n".repeat(800), workspaceId: "workspace", boardId: null }));
  await cache.saveNotes("workspace", null, notes);
  const put = fakeIDB.IDBObjectStore.prototype.put;
  const writes = [];
  fakeIDB.IDBObjectStore.prototype.put = function (value, key) {
    writes.push({ store: this.name, bytes: Buffer.byteLength(JSON.stringify(value)) });
    return put.call(this, value, key);
  };
  notes[0] = { ...notes[0], title: "Renamed" };
  try { await cache.saveNotes("workspace", null, notes); } finally { fakeIDB.IDBObjectStore.prototype.put = put; }
  const restored = await cache.loadNotes("workspace", null);
  if (JSON.stringify(restored.notes) !== JSON.stringify(notes)) throw new Error("Offline contents changed");
  report.notes.push({ before, notes: notes.length, changedNotes: 1, writes, totalWriteBytes: writes.reduce((sum, write) => sum + write.bytes, 0) });
}

for (const before of [true, false]) {
  const file = "apps/web/src/app/features/global-work/global-work.state.ts";
  const Subject = new Function("EMPTY_RESPONSE", classCode(await source(file, before), "GlobalWorkState", ["loadCards", "loadAllCards", "scheduleRealtimeRefresh", "reconcileInBackground"]))({ cards: [], nextCursor: null });
  const s = new Subject();
  const cards = Array.from({ length: 300 }, (_, i) => ({ id: String(i) }));
  let requests = 0, active = 0, peakConcurrent = 0, publications = 0;
  Object.assign(s, {
    requestVersion: 0, realtimeRefreshTimer: null, backgroundRefreshInFlight: false, backgroundRefreshQueued: false,
    definition: () => ({ display: "board", filters: {}, scope: {}, sort: "dueAsc" }), lens: () => "my", loading: () => false,
    response: signal({ cards, nextCursor: null }), reconciling: signal(false), cachedAt: signal(null), lastSyncedAt: signal(null), error: signal(null),
    otherPriorities: signal(null), teamPriorities: signal(null), teamPriorityCandidates: signal([]), reconciliationVersion: signal(0), cardDrag: { active: () => false },
    loadTeamPriorities: async () => null, loadPriorities: async () => null, loadTeamPriorityCandidateCards: async () => [], whenCardDragIdle: async () => {}, updateRooms() {}, persistCache: async () => {},
  });
  s.response.set = () => { publications++; };
  s.api = { post: async (_url, body) => {
    requests++; active++; peakConcurrent = Math.max(peakConcurrent, active);
    await new Promise((resolve) => setTimeout(resolve, 400)); active--;
    const offset = Number(body.cursor ?? 0);
    return { cards: cards.slice(offset, offset + 100), nextCursor: offset + 100 < cards.length ? String(offset + 100) : null };
  } };
  for (let i = 0; i < 5; i++) { s.scheduleRealtimeRefresh(false); await new Promise((resolve) => setTimeout(resolve, 250)); }
  while (s.reconciling() || s.realtimeRefreshTimer) await new Promise((resolve) => setTimeout(resolve, 25));
  report.globalWork.push({ before, cards: cards.length, events: 5, eventIntervalMs: 250, simulatedPageLatencyMs: 400, requests, peakConcurrent, publications });
}
await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
