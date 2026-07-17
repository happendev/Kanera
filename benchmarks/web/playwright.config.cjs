const { defineConfig } = require("@playwright/test");
const os = require("node:os");
const path = require("node:path");

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "benchmark.spec.cjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60 * 1_000,
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
