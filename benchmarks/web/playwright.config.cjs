const { defineConfig } = require("@playwright/test");
const os = require("node:os");
const path = require("node:path");

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "benchmark.spec.cjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The whole run is one test: five warm navigations per page, scroll/drag profiles, and 75 card
  // detail opens. A development build at fixture scale can exceed ten minutes on a slower machine or
  // with a widened fixture, so the budget is generous and tunable rather than a tripwire.
  timeout: Math.max(60_000, Number.parseInt(process.env.PERF_TEST_TIMEOUT_MS ?? "1800000", 10)),
  outputDir: process.env.PERF_TEST_OUTPUT ?? path.join(os.tmpdir(), "kanera-web-benchmark-test-results"),
  reporter: "line",
  use: {
    baseURL: (process.env.PERF_BASE_URL ?? "http://localhost:4200").replace(/\/$/, ""),
    browserName: "chromium",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    launchOptions: {
      args: ["--enable-precise-memory-info", "--disable-renderer-backgrounding"],
    },
  },
});
